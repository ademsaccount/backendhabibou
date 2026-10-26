import type { Order, OrderStatus } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// import { haversineKm, roundKm } from '../lib/geo';
// --- FIN DÉSACTIVÉ ---
import { notify, notifyAdmins } from '../lib/notify';
import { pushOrderStatusToUser } from '../lib/push';
import { logger } from '../lib/logger';
import { processQueueAfterFreeUp } from './dispatch.service';
import { emitToOrder } from '../socket/io';
import { stripeEnabled } from '../lib/stripe';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'picked_up',
  'on_the_way',
  'delivered',
  'cancelled',
];

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'picked_up', 'cancelled'],
  preparing: ['picked_up', 'cancelled'],
  picked_up: ['on_the_way'],
  on_the_way: ['delivered'],
  delivered: [],
  cancelled: [],
};

// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// const LIVREUR_TRANSITIONS: OrderStatus[] = ['picked_up', 'on_the_way', 'delivered'];
// --- FIN DÉSACTIVÉ ---

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'En attente de confirmation',
  confirmed: 'Commande confirmee',
  preparing: 'En preparation',
  picked_up: 'Colis recupere',
  on_the_way: 'Livreur en route',
  delivered: 'Livre',
  cancelled: 'Annulee',
};

export function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw ApiError.badRequest(`Transition invalide : ${from} -> ${to}`, 'INVALID_TRANSITION');
  }
}

export async function changeOrderStatus(
  order: Order,
  to: OrderStatus,
  opts: { actorRole?: string; actorUserId?: string } = {},
): Promise<Order> {
  assertTransition(order.status, to);

  // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
  // if (opts.actorRole === 'livreur' && !LIVREUR_TRANSITIONS.includes(to)) {
  //   throw ApiError.forbidden('Seuls picked_up / on_the_way / delivered sont permis au livreur');
  // }
  // --- FIN DÉSACTIVÉ ---

  // Assignation auto à la confirmation : l'acteur (admin top ou livreur qui
  // prend la commande) devient le livreur suivi par le client.
  let adminLivreurId: string | null = null;
  if (
    to === 'confirmed' &&
    opts.actorUserId &&
    (opts.actorRole === 'admin' || opts.actorRole === 'livreur')
  ) {
    const livreurRecord = await prisma.livreur.upsert({
      where: { user_id: opts.actorUserId },
      update: {},
      create: { user_id: opts.actorUserId },
    });
    adminLivreurId = livreurRecord.id;
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: to,
      ...(adminLivreurId ? { livreur_id: adminLivreurId } : {}),
      // Sortie de "pending" ou de file : l'indicateur d'attente ne sert plus.
      ...(to !== 'pending' ? { queued_at: null } : {}),
      ...(to === 'delivered'
        ? {
            delivered_at: new Date(),
            ...(order.payment_method === 'cash' || !stripeEnabled() ? { payment_status: 'paid' as const } : {}),
          }
        : {}),
    },
    include: {
      items: { include: { product: true } },
      restaurant: true,
      address: true,
      livreur: { include: { user: { select: { id: true, full_name: true, phone: true, avatar_url: true } } } },
      user: { select: { id: true, full_name: true, phone: true } },
      custom_request: true,
      shop_statuses: { select: { restaurant_id: true, status: true } },
    },
  });

  const payload = { order_id: updated.id, status: updated.status, label: STATUS_LABELS[to] };
  emitToOrder(updated.id, 'order:status_update', payload);

  // Demande spécifique liée : son statut suit celui de la commande.
  if (updated.custom_request_id && (to === 'confirmed' || to === 'cancelled')) {
    await prisma.customRequest.update({
      where: { id: updated.custom_request_id },
      data: { status: to === 'confirmed' ? 'accepted' : 'rejected' },
    });
  }
  await notify({
    user_id: updated.user_id,
    title: 'Commande mise a jour',
    body: STATUS_LABELS[to],
    type: 'order',
    data: { order_id: updated.id, status: updated.status },
  });

  if (updated.livreur && updated.livreur.user_id !== opts.actorUserId) {
    await notify({
      user_id: updated.livreur.user_id,
      title: 'Commande mise a jour',
      body: STATUS_LABELS[to],
      type: 'order',
      data: { order_id: updated.id, status: updated.status },
    });
  }

  if (to === 'confirmed' || to === 'cancelled') {
    await notifyAdmins('Commande ' + STATUS_LABELS[to].toLowerCase(), `Commande ${updated.id.slice(0, 8)}`, 'order', {
      order_id: updated.id,
    });
  }

  // Push client (confirmed / on_the_way / delivered / cancelled) — APRES la mise a
  // jour en base, best effort : ne doit jamais faire echouer la requete principale.
  try {
    await pushOrderStatusToUser(updated.user_id, updated.id, to);
  } catch (err) {
    // pushToUser n leve pas — garde-fou par principe.
    void err;
  }

  // Course terminee par son livreur : il se libere -> on purge la file d'attente.
  if ((to === 'delivered' || to === 'cancelled') && updated.livreur_id && updated.livreur) {
    try {
      await processQueueAfterFreeUp(updated.livreur.user_id);
    } catch (err) {
      logger.error('dispatch', 'purge file impossible', err instanceof Error ? err : String(err));
    }
  }

  return updated;
}

/**
 * Tap du livreur/admin sur la carte d'UN commerce du pipeline branche :
 * SEUL ce commerce passe a picked_up, les autres restent en preparation.
 * Quand TOUS les commerces de la commande sont retires, la commande passe
 * globalement a picked_up (suite du tronc on_the_way -> delivered inchangee).
 *
 * Premier tap depuis « confirmée » : la tournée démarre — la commande passe
 * globalement a preparing (notification client comprise).
 * Ce n'est actif qu'aux etapes « branches » (confirmed / preparing). Les
 * commerces sans ligne OrderShopStatus sont derives a `preparing` cote client.
 */
export async function pickUpOrderShop(
  order: Order,
  restaurantId: string,
  opts: { actorRole?: string; actorUserId?: string } = {},
): Promise<Order> {
  if (order.status !== 'confirmed' && order.status !== 'preparing') {
    throw ApiError.badRequest(`Etape par commerce indisponible : ${order.status}`, 'INVALID_TRANSITION');
  }

  // Le commerce doit appartenir a la commande (articles qu'il a produit).
  const items = await prisma.orderItem.findMany({
    where: { order_id: order.id },
    select: { product: { select: { restaurant_id: true } } },
  });
  const shops = [...new Set(items.map((item) => item.product.restaurant_id).filter((id): id is string => !!id))];
  if (!shops.includes(restaurantId)) {
    throw ApiError.notFound('Commerce introuvable dans cette commande');
  }

  // Premier tap de branche depuis « confirmée » → la tournée démarre.
  let stage = order;
  if (order.status === 'confirmed') {
    stage = await changeOrderStatus(order, 'preparing', opts);
  }

  await prisma.orderShopStatus.upsert({
    where: { order_id_restaurant_id: { order_id: order.id, restaurant_id: restaurantId } },
    update: { status: 'picked_up' },
    create: { order_id: order.id, restaurant_id: restaurantId, status: 'picked_up' },
  });

  emitToOrder(order.id, 'order:shop_status_update', {
    order_id: order.id,
    restaurant_id: restaurantId,
    status: 'picked_up',
  });

  // Tous les commerces retires -> bascule du tronc vers picked_up.
  const picked = await prisma.orderShopStatus.count({
    where: { order_id: order.id, status: 'picked_up' },
  });
  if (picked >= shops.length) {
    return changeOrderStatus(stage, 'picked_up', opts);
  }
  return resolveOrder(stage.id);
}

/** Variant economique : la commande rattachee a `id` avec l'include complet. */
async function resolveOrder(id: string): Promise<Order> {
  const fresh = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { include: { product: true } },
      restaurant: true,
      address: true,
      livreur: { include: { user: { select: { id: true, full_name: true, phone: true, avatar_url: true } } } },
      user: { select: { id: true, full_name: true, phone: true } },
      custom_request: true,
      shop_statuses: { select: { restaurant_id: true, status: true } },
    },
  });
  if (!fresh) throw ApiError.notFound('Commande introuvable');
  return fresh;
}

// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// export async function assignLivreur(orderId: string, livreurUserId: string | null, auto = false) {
//   const order = await prisma.order.findUnique({ where: { id: orderId } });
//   if (!order) throw ApiError.notFound('Commande introuvable');
//   if (['delivered', 'cancelled'].includes(order.status)) {
//     throw ApiError.badRequest('Commande deja terminee', 'ORDER_CLOSED');
//   }
//
//   let targetUserId: string;
//
//   if (auto || !livreurUserId) {
//     const restaurant = order.restaurant_id ? await prisma.restaurant.findUnique({ where: { id: order.restaurant_id } }) : null;
//     const address = await prisma.address.findUnique({ where: { id: order.address_id } });
//     const fromLat = restaurant?.latitude ?? address?.latitude ?? 0;
//     const fromLng = restaurant?.longitude ?? address?.longitude ?? 0;
//
//     const livreurs = await prisma.livreur.findMany({
//       where: { is_online: true },
//       include: { user: { select: { id: true, full_name: true } } },
//     });
//     if (livreurs.length === 0) throw ApiError.badRequest('Aucun livreur en ligne', 'NO_LIVREUR');
//
//     const activeCounts = await prisma.order.groupBy({
//       by: ['livreur_id'],
//       where: {
//         livreur_id: { not: null },
//         status: { in: ['confirmed', 'preparing', 'picked_up', 'on_the_way'] },
//       },
//       _count: { _all: true },
//     });
//     const countFor = (id: string) => activeCounts.find((c) => c.livreur_id === id)?._count._all ?? 0;
//
//     const ranked = livreurs
//       .map((l) => ({
//         l,
//         distance:
//           l.current_lat != null && l.current_lng != null
//             ? roundKm(haversineKm(fromLat, fromLng, l.current_lat, l.current_lng))
//             : 9999,
//         active: countFor(l.id),
//       }))
//       .sort((a, b) => a.active - b.active || a.distance - b.distance);
//
//     const chosen = ranked[0];
//     if (!chosen) throw ApiError.badRequest('Aucun livreur disponible', 'NO_LIVREUR');
//     targetUserId = chosen.l.user_id;
//   } else {
//     // Accepte tantôt un Livreur.id, tantôt un User.id (contrat tolerance)
//     const byLivreurId = await prisma.livreur.findUnique({ where: { id: livreurUserId } });
//     const record = byLivreurId ?? (await prisma.livreur.findUnique({ where: { user_id: livreurUserId } }));
//     if (!record) throw ApiError.badRequest("Cet utilisateur n'est pas livreur", 'NOT_LIVREUR');
//     targetUserId = record.user_id;
//   }
//
//   const livreurRecord = await prisma.livreur.upsert({
//     where: { user_id: targetUserId },
//     update: {},
//     create: { user_id: targetUserId },
//   });
//
//   const updated = await prisma.order.update({
//     where: { id: order.id },
//     data: { livreur_id: livreurRecord.id },
//     include: {
//       items: { include: { product: true } },
//       restaurant: true,
//       address: true,
//       livreur: { include: { user: { select: { id: true, full_name: true, phone: true, avatar_url: true } } } },
//       user: { select: { id: true, full_name: true, phone: true } },
//     },
//   });
//
//   await notify({
//     user_id: targetUserId,
//     title: 'Nouvelle course assignee',
//     body: `${updated.restaurant?.name ?? 'Demande libre'} — ${updated.total_price.toFixed(2)} MAD`,
//     type: 'assignment',
//     data: { order_id: updated.id },
//   });
//   await notify({
//     user_id: updated.user_id,
//     title: 'Livreur assigne',
//     body: 'Un livreur a ete assigne a votre commande',
//     type: 'order',
//     data: { order_id: updated.id },
//   });
//   emitToOrder(updated.id, 'order:status_update', { order_id: updated.id, status: updated.status });
//
//   return updated;
// }
// --- FIN DÉSACTIVÉ ---

/**
 * Frais de livraison d'une commande : base au premier commerce, supplement
 * par commerce supplementaire (le livreur enchaine les pickups dans une
 * SEULE commande). Meme formule cote app : DELIVERY_FEE + HOP × (shops−1).
 */
export function deliveryFee(shopsCount = 1): number {
  return env.DELIVERY_FEE + Math.max(0, shopsCount - 1) * env.DELIVERY_HOP_FEE;
}
