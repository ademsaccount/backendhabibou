import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idParam, locationSchema, orderMessageSchema, orderStatusSchema } from '../schemas';
import { changeOrderStatus } from '../services/order.service';
import { emitToAdmins, emitToOrder } from '../socket/io';
import { notify, notifyAdmins } from '../lib/notify';
import { pushAdmins, pushNewMessageToUser } from '../lib/push';
import { orderInclude } from './order.routes';

const ACTIVE = ['confirmed', 'preparing', 'picked_up', 'on_the_way'] as const;
const DONE = ['delivered', 'cancelled'] as const;

async function getLivreur(userId: string) {
  const livreur = await prisma.livreur.findUnique({ where: { user_id: userId } });
  if (!livreur) {
    return prisma.livreur.create({ data: { user_id: userId } });
  }
  return livreur;
}

export const livreurRouter = Router();
livreurRouter.use(requireAuth, requireRole('livreur'));

livreurRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    res.json({ ...livreur, user: req.user });
  }),
);

livreurRouter.put(
  '/online',
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const is_online = typeof req.body?.is_online === 'boolean' ? req.body.is_online : !livreur.is_online;
    const updated = await prisma.livreur.update({ where: { id: livreur.id }, data: { is_online } });
    emitToAdmins('livreur:location_update', { livreur_id: updated.id, user_id: updated.user_id, is_online });
    res.json(updated);
  }),
);

livreurRouter.get(
  '/orders/assigned',
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const view = typeof req.query.view === 'string' ? req.query.view : 'active';
    const orders = await prisma.order.findMany({
      where: {
        livreur_id: livreur.id,
        ...(view === 'history' ? { status: { in: [...DONE] as never } } : { status: { in: [...ACTIVE] as never } }),
      },
      include: orderInclude,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(orders);
  }),
);

livreurRouter.get(
  '/orders/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
    if (!order) throw ApiError.notFound('Commande introuvable');
    const assigned = order.livreur_id === livreur.id;
    const offered =
      order.status === 'pending' && (order.diffused_to ?? []).includes(req.user!.id);
    if (!assigned && !offered) throw ApiError.forbidden();
    res.json(order);
  }),
);

livreurRouter.put(
  '/orders/:id/status',
  validate(orderStatusSchema),
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const { status } = req.validated?.body as { status: 'picked_up' | 'on_the_way' | 'delivered' };
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (order.livreur_id !== livreur.id) throw ApiError.forbidden();
    const updated = await changeOrderStatus(order, status, { actorRole: 'livreur' });
    res.json(updated);
  }),
);

/**
 * Accepter un appel diffusé : premier arrivé, premier Servi (atomique).
 * Perdant → 409 ORDER_TAKEN ; les autres appels se ferment via status_update.
 */
livreurRouter.post(
  '/orders/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (
      order.status !== 'pending' ||
      !(order.diffused_to ?? []).includes(req.user!.id) ||
      (order.rejected_by ?? []).includes(req.user!.id)
    ) {
      throw ApiError.forbidden('Appel indisponible', 'NOT_OFFERED');
    }
    const claimed = await prisma.order.updateMany({
      where: { id: order.id, status: 'pending', livreur_id: null },
      data: { livreur_id: livreur.id },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict('Commande déjà prise par un autre livreur', 'ORDER_TAKEN');
    }
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    const updated = await changeOrderStatus(fresh!, 'confirmed', {
      actorRole: 'livreur',
      actorUserId: req.user!.id,
    });
    res.json(updated);
  }),
);

/**
 * Refuser un appel diffusé : n'arrête pas les autres ; si tous les démarchés
 * ont refusé, la commande est annulée.
 */
livreurRouter.post(
  '/orders/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (
      order.status !== 'pending' ||
      !(order.diffused_to ?? []).includes(req.user!.id) ||
      order.livreur_id != null
    ) {
      throw ApiError.forbidden('Appel indisponible', 'NOT_OFFERED');
    }
    // Refus atomique (push) : deux refus simultanes ne peuvent pas se perdre
    // mutuellement, contrairement a lecture-modification-ecriture. Sans ca,
    // deux livreurs qui refusent en meme temps pouvaient laisser la commande
    // gele en pending sans aucun destinataire.
    if (!(order.rejected_by ?? []).includes(req.user!.id)) {
      await prisma.order.update({
        where: { id: order.id },
        data: { rejected_by: { push: req.user!.id } },
      });
    }
    // Annulation quand TOUS les demarches ont refuse, evaluee sur donnees
    // fraiches (un accept concurrent peut avoir pris la commande entre-temps).
    const fresh = await prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, livreur_id: true, diffused_to: true, rejected_by: true },
    });
    const allRejected =
      (fresh?.diffused_to ?? []).length > 0 &&
      (fresh?.diffused_to ?? []).every((id) => (fresh?.rejected_by ?? []).includes(id));
    if (allRejected) {
      try {
        const current = await prisma.order.findUnique({ where: { id: order.id } });
        if (current && current.status === 'pending' && current.livreur_id == null) {
          await changeOrderStatus(current, 'cancelled', { actorRole: 'livreur', actorUserId: req.user!.id });
        }
      } catch {
        // Course perdue contre une acceptation concurrente : l'annulation est sans objet.
      }
    }
    res.json({ ok: true });
  }),
);

livreurRouter.put(
  '/location',
  validate(locationSchema),
  asyncHandler(async (req, res) => {
    const { lat, lng, order_id } = req.validated?.body as { lat: number; lng: number; order_id?: string };
    const livreur = await getLivreur(req.user!.id);
    const updated = await prisma.livreur.update({ where: { id: livreur.id }, data: { current_lat: lat, current_lng: lng } });

    const payload = {
      livreur_id: updated.id,
      user_id: updated.user_id,
      lat,
      lng,
      order_id: order_id ?? null,
      at: new Date().toISOString(),
    };
    if (order_id) emitToOrder(order_id, 'livreur:location_update', payload);
    emitToAdmins('livreur:location_update', payload);

    res.json({ ok: true, lat, lng });
  }),
);

livreurRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const livreur = await getLivreur(req.user!.id);
    const [deliveredAgg, history] = await Promise.all([
      prisma.order.aggregate({
        where: { livreur_id: livreur.id, status: 'delivered' },
        _count: { _all: true },
        _sum: { delivery_fee: true },
      }),
      prisma.order.findMany({
        where: { livreur_id: livreur.id, status: { in: [...DONE] as never } },
        include: orderInclude,
        orderBy: { delivered_at: 'desc' },
        take: 50,
      }),
    ]);
    res.json({
      is_online: livreur.is_online,
      rating: livreur.rating,
      vehicle_type: livreur.vehicle_type,
      total_deliveries: deliveredAgg._count._all,
      earnings: deliveredAgg._sum.delivery_fee ?? 0,
      history,
    });
  }),
);

async function getAssignedOrderOrThrow(orderId: string, userId: string) {
  const livreur = await getLivreur(userId);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Commande introuvable');
  if (order.livreur_id !== livreur.id) throw ApiError.forbidden();
  return order;
}

function assertChatOpen(status: string) {
  if (status === 'cancelled' || status === 'delivered') {
    throw ApiError.badRequest('Discussion fermee', 'CHAT_CLOSED');
  }
}

livreurRouter.get(
  '/orders/:id/messages',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await getAssignedOrderOrThrow(req.params.id, req.user!.id);
    const messages = await prisma.orderMessage.findMany({
      where: { order_id: order.id },
      orderBy: { created_at: 'asc' },
      take: 200,
    });
    res.json(messages);
  }),
);

livreurRouter.post(
  '/orders/:id/messages',
  validate(orderMessageSchema),
  asyncHandler(async (req, res) => {
    const order = await getAssignedOrderOrThrow(req.params.id, req.user!.id);
    assertChatOpen(order.status);
    const body = req.validated?.body as { kind: 'text' | 'price'; text?: string; price?: number };
    if (body.kind === 'price' && !order.custom_request_id) {
      throw ApiError.forbidden('Prix réservé aux demandes personnalisées', 'PRICE_FORBIDDEN');
    }
    const message = await prisma.orderMessage.create({
      data: {
        order_id: order.id,
        sender_id: req.user!.id,
        sender_role: 'admin',
        kind: body.kind,
        text: body.kind === 'text' ? body.text! : (body.text ?? null),
        price: body.kind === 'price' ? body.price! : null,
      },
    });
    if (body.kind === 'price') {
      await prisma.order.update({
        where: { id: order.id },
        data: { proposed_price: body.price!, price_status: 'proposed' },
      });
      emitToOrder(order.id, 'order:price_update', {
        order_id: order.id,
        price_status: 'proposed',
        proposed_price: body.price!,
      });
    }
    emitToOrder(order.id, 'order:message:new', { message });
    const preview =
      body.kind === 'price' && body.price != null
        ? `Prix proposé : ${body.price.toFixed(2)} MAD`
        : (body.text ?? '').slice(0, 80);
    await notify({
      user_id: order.user_id,
      title: 'Nouveau message',
      body: preview,
      type: 'order',
      data: { order_id: order.id },
    });
    try {
      await pushNewMessageToUser(order.user_id, order.id, preview);
    } catch (err) {
      void err;
    }
    await notifyAdmins('Nouveau message livreur', preview, 'order', { order_id: order.id });
    void pushAdmins({
      title: 'Nouveau message livreur',
      body: preview,
      data: { type: 'order_message', order_id: order.id, url: `/admin/orders/${order.id}` },
    });
    res.status(201).json(message);
  }),
);
