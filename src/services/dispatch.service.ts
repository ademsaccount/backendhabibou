import type { Order, OrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';
import { notifyAdmins } from '../lib/notify';
import { pushAdmins, pushToUser } from '../lib/push';
import { emitToAdmins, emitToOrder, emitToUser } from '../socket/io';
import { orderInclude } from '../lib/orderInclude';

/**
 * Routage intelligent des nouvelles commandes ("appel") :
 * - un admin libre  -> l'appel sonne chez les admins (comportement historique) ;
 * - admin occupe + livreurs libres -> diffusion automatique aux livreurs libres ;
 * - personne de libre -> file d'attente (queued_at), re-diffusee des qu'un
 *   livreur se libere ou se connecte.
 */

/** Statuts "course en cours" : un livreur qui en porte une n'est pas libre. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'confirmed',
  'preparing',
  'picked_up',
  'on_the_way',
];

/** Livreurs connectes (role livreur) sans aucune course en cours. Retourne des User ids. */
export async function getFreeLivreurUserIds(excludeUserId?: string): Promise<string[]> {
  const online = await prisma.livreur.findMany({
    where: {
      is_online: true,
      ...(excludeUserId ? { user_id: { not: excludeUserId } } : {}),
      user: { role: 'livreur' },
    },
    select: { id: true, user_id: true },
  });
  if (online.length === 0) return [];
  const busy = await prisma.order.groupBy({
    by: ['livreur_id'],
    where: {
      livreur_id: { in: online.map((l) => l.id) },
      status: { in: ACTIVE_ORDER_STATUSES },
    },
    _count: { _all: true },
  });
  const busyIds = new Set(busy.map((b) => b.livreur_id));
  return online.filter((l) => !busyIds.has(l.id)).map((l) => l.user_id);
}

/** Vrai si au moins un admin n'a aucune course en cours (via son profil livreur). */
export async function isAnyAdminFree(): Promise<boolean> {
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
  if (admins.length === 0) return false;
  const profiles = await prisma.livreur.findMany({
    where: { user_id: { in: admins.map((a) => a.id) } },
    select: { id: true },
  });
  if (profiles.length === 0) return true;
  const active = await prisma.order.count({
    where: {
      livreur_id: { in: profiles.map((p) => p.id) },
      status: { in: ACTIVE_ORDER_STATUSES },
    },
  });
  return active === 0;
}

interface RingMeta {
  title: string;
  body: string;
  restaurant: string | null;
  itemsCount: number;
  paymentMethod: string;
  customRequestId?: string;
}

/** Fait sonner l'appel entrant chez tous les admins (socket + push plein ecran). */
export async function ringAdmins(order: Order, meta: RingMeta): Promise<void> {
  emitToAdmins('order:incoming', {
    order_id: order.id,
    ...(meta.customRequestId ? { custom_request_id: meta.customRequestId } : {}),
    restaurant: meta.restaurant,
    total_price: order.total_price,
    items_count: meta.itemsCount,
    payment_method: meta.paymentMethod,
    url: `/admin/incoming?order_id=${order.id}`,
    created_at: order.created_at.toISOString(),
  });
  void pushAdmins({
    title: meta.title,
    body: meta.body,
    channelId: 'incoming_order',
    sound: 'incoming_order.wav',
    data: { type: 'order_incoming', order_id: order.id, url: `/admin/incoming?order_id=${order.id}` },
  });
}

/**
 * Diffuse un appel (pending) a une liste de livreurs (User ids) : snapshot en
 * base, event socket + push a chacun. Premier qui accepte gagne (claim
 * atomique cote accept) ; la sortie de file (queued_at) est effacee.
 */
export async function diffuseOrderToLivreurs(orderId: string, livreurUserIds: string[]) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Commande introuvable');
  if (order.status !== 'pending') {
    throw ApiError.badRequest('Diffusion impossible a ce stade', 'NOT_DIFFUSABLE');
  }
  if (livreurUserIds.length === 0) {
    throw ApiError.badRequest('Aucun livreur en ligne', 'DIFFUSE_EMPTY');
  }
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { diffused_at: new Date(), diffused_to: livreurUserIds, rejected_by: [], queued_at: null },
    include: orderInclude,
  });
  for (const userId of livreurUserIds) {
    emitToUser(userId, 'order:diffuse', { order_id: order.id });
  }
  for (const userId of livreurUserIds) {
    void pushToUser(userId, {
      templates: {
        fr: { title: 'Nouvel appel', body: `Commande ${order.id.slice(0, 8)} à prendre` },
        en: { title: 'New call', body: `Order ${order.id.slice(0, 8)} to take` },
        ar: { title: 'نداء جديد', body: `طلب ${order.id.slice(0, 8)} للاستلام` },
      },
      channelId: 'incoming_order',
      sound: 'incoming_order.wav',
      data: { type: 'order_incoming', order_id: order.id, url: `/livreur/incoming?order_id=${order.id}` },
    });
  }
  // Le client suit la sortie de file en direct (banniere "en attente" masquee).
  emitToOrder(order.id, 'order:diffused', { order_id: order.id });
  return updated;
}

export interface NewOrderRouting {
  orderId: string;
  restaurantName?: string | null;
  itemsCount: number;
  paymentMethod: string;
  /** Demande personnalisee : titres/notif adaptes + id joint aux payloads. */
  customRequest?: { id: string; title: string; body: string } | null;
}

/**
 * Arbre de decision a la creation d'une commande :
 * 'admin'    -> admin libre : appel entrant classique ;
 * 'livreurs' -> admin occupe : diffusion auto aux livreurs libres ;
 * 'queued'   -> personne de libre : file d'attente + notif admin (sonore, sans plein ecran).
 */
export async function routeNewOrder(input: NewOrderRouting): Promise<'admin' | 'livreurs' | 'queued'> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw ApiError.notFound('Commande introuvable');
  const orderRef = order.id.slice(0, 8);
  const restaurant = input.restaurantName ?? 'Commerce';
  const title = input.customRequest ? 'Nouvelle demande personnalisée' : 'Nouvelle commande';
  const body = input.customRequest
    ? input.customRequest.body
    : `${restaurant} — ${order.total_price.toFixed(2)} MAD · ${input.itemsCount} article(s)`;

  if (await isAnyAdminFree()) {
    await ringAdmins(order, {
      title,
      body,
      restaurant: input.restaurantName ?? null,
      itemsCount: input.itemsCount,
      paymentMethod: input.paymentMethod,
      ...(input.customRequest ? { customRequestId: input.customRequest.id } : {}),
    });
    await notifyAdmins(title, body, input.customRequest ? 'custom_request' : 'order', {
      ...(input.customRequest ? { custom_request_id: input.customRequest.id } : {}),
      order_id: order.id,
    });
    return 'admin';
  }

  const free = await getFreeLivreurUserIds();
  if (free.length > 0) {
    await diffuseOrderToLivreurs(order.id, free);
    await notifyAdmins(
      'Commande routée aux livreurs',
      `Commande ${orderRef} — admin occupé, appel diffusé à ${free.length} livreur(s) libre(s)`,
      'order',
      { order_id: order.id },
    );
    logger.info('dispatch', `commande ${orderRef} auto-diffusée (admin occupé) → ${free.length} livreur(s)`);
    return 'livreurs';
  }

  // Personne de libre : mise en file d'attente.
  const queued = await prisma.order.update({
    where: { id: order.id },
    data: { queued_at: new Date() },
  });
  emitToOrder(order.id, 'order:queued', {
    order_id: order.id,
    queued_at: queued.queued_at?.toISOString() ?? new Date().toISOString(),
  });
  await notifyAdmins(`${title} — en attente`, `${body} · aucun livreur libre`, 'order', {
    order_id: order.id,
  });
  // Notif sonore SANS plein ecran : un clic ouvre le meme ecran d'appel
  // (l'admin peut accepter meme s'il a deja une course — multi-courses reserve a l'admin).
  void pushAdmins({
    title: `${title} — en attente`,
    body: `${body} · aucun livreur libre pour le moment`,
    channelId: 'escalated_order',
    sound: 'default',
    data: { type: 'order_escalated', order_id: order.id, url: `/admin/incoming?order_id=${order.id}` },
  });
  logger.info('dispatch', `commande ${orderRef} mise en file (admin occupe, aucun livreur libre)`);
  return 'queued';
}

/**
 * A appeler quand un livreur (ou l'admin) se libere : livraison terminee /
 * annulee, ou (re)connexion. Les commandes en file (plus anciennes d'abord)
 * sont diffusees aux livreurs desormais libres. Si personne n'est libre et
 * que c'est l'admin qui s'est libere, l'appel lui revient.
 */
export async function processQueueAfterFreeUp(freedUserId?: string): Promise<void> {
  const queued = await prisma.order.findMany({
    where: { status: 'pending', livreur_id: null, queued_at: { not: null } },
    orderBy: { queued_at: 'asc' },
  });
  if (queued.length === 0) return;

  const free = await getFreeLivreurUserIds();
  if (free.length > 0) {
    for (const order of queued) {
      try {
        await diffuseOrderToLivreurs(order.id, free);
        logger.info('dispatch', `file : commande ${order.id.slice(0, 8)} diffusee a ${free.length} livreur(s)`);
      } catch (err) {
        // Course perdue entre-temps (acceptee / annulee par ailleurs) : on passe a la suivante.
        logger.warn('dispatch', `file : diffusion impossible commande=${order.id}`, err instanceof Error ? err : String(err));
      }
    }
    return;
  }

  if (freedUserId) {
    const user = await prisma.user.findUnique({ where: { id: freedUserId }, select: { role: true } });
    if (user?.role === 'admin') {
      const oldest = await prisma.order.findUnique({
        where: { id: queued[0].id },
        include: {
          items: { select: { id: true } },
          restaurant: { select: { name: true } },
          custom_request: { select: { id: true, description_text: true } },
        },
      });
      if (oldest && oldest.status === 'pending' && oldest.livreur_id == null) {
        const cr = oldest.custom_request
          ? {
              id: oldest.custom_request.id,
              title: 'Nouvelle demande personnalisée',
              body: `${oldest.custom_request.description_text.slice(0, 80)}`,
            }
          : null;
        await ringAdmins(oldest, {
          title: cr ? cr.title : 'Commande en attente',
          body: cr ? cr.body : `${oldest.restaurant?.name ?? 'Commerce'} — ${oldest.total_price.toFixed(2)} MAD`,
          restaurant: oldest.restaurant?.name ?? null,
          itemsCount: oldest.items.length,
          paymentMethod: oldest.payment_method,
          ...(cr ? { customRequestId: cr.id } : {}),
        });
        logger.info('dispatch', `file : commande ${oldest.id.slice(0, 8)} renvoyee a l'admin (libere)`);
      }
    }
  }
}

/** Nombre de courses en cours d'un livreur (User id) — garde anti-double-course. */
export async function countActiveOrdersForUser(userId: string): Promise<number> {
  const profile = await prisma.livreur.findUnique({ where: { user_id: userId }, select: { id: true } });
  if (!profile) return 0;
  return prisma.order.count({
    where: { livreur_id: profile.id, status: { in: ACTIVE_ORDER_STATUSES } },
  });
}
