import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idParam, locationSchema, orderStatusSchema } from '../schemas';
import { changeOrderStatus } from '../services/order.service';
import { emitToAdmins, emitToOrder } from '../socket/io';
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
    if (order.livreur_id !== livreur.id) throw ApiError.forbidden();
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
