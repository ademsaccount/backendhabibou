import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createCustomRequestSchema, customRequestStatusFilterQuery, idParam } from '../schemas';
import { notifyAdmins } from '../lib/notify';
import { changeOrderStatus, deliveryFee } from '../services/order.service';
import { routeNewOrder } from '../services/dispatch.service';
import { orderInclude } from '../lib/orderInclude';

const includeCR = {
  address: true,
  user: { select: { id: true, full_name: true, phone: true, avatar_url: true } },
} as const;

export const customRequestRouter = Router();
customRequestRouter.use(requireAuth, requireRole('client'));

/**
 * Demande spécifique : texte + photo éventuelle. Crée immédiatement la demande
 * ET sa commande (pending, livraison seule) — l'admin la reçoit comme une
 * commande, avec le même appel entrant (titre "demande personnalisée").
 */
customRequestRouter.post(
  '/',
  validate(createCustomRequestSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      description_text: string;
      photo_url?: string;
      address_id: string;
    };
    const address = await prisma.address.findUnique({ where: { id: body.address_id } });
    if (!address || address.user_id !== req.user!.id) throw ApiError.notFound('Adresse introuvable');

    const fee = deliveryFee();
    const { cr, order } = await prisma.$transaction(async (tx) => {
      const created = await tx.customRequest.create({
        data: {
          description_text: body.description_text,
          photo_url: body.photo_url,
          address_id: body.address_id,
          user_id: req.user!.id,
        },
        include: includeCR,
      });
      const createdOrder = await tx.order.create({
        data: {
          user_id: req.user!.id,
          custom_request_id: created.id,
          address_id: body.address_id,
          payment_method: 'cash',
          delivery_fee: fee,
          total_price: fee,
        },
        include: orderInclude,
      });
      return { cr: created, order: createdOrder };
    });

    // Meme routage que les commandes : admin libre -> appel entrant,
    // admin occupe -> diffusion auto aux livreurs libres, sinon file d'attente.
    await routeNewOrder({
      orderId: order.id,
      restaurantName: null,
      itemsCount: 0,
      paymentMethod: order.payment_method,
      customRequest: {
        id: cr.id,
        title: 'Nouvelle demande personnalisée',
        body: `${req.user!.full_name} : ${cr.description_text.slice(0, 80)}`,
      },
    });

    res.status(201).json({ custom_request: cr, order });
  }),
);

customRequestRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const list = await prisma.customRequest.findMany({
      where: { user_id: req.user!.id },
      include: includeCR,
      orderBy: { created_at: 'desc' },
    });
    res.json(list);
  }),
);

customRequestRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const cr = await prisma.customRequest.findUnique({ where: { id: req.params.id }, include: includeCR });
    if (!cr || cr.user_id !== req.user!.id) throw ApiError.notFound('Demande introuvable');
    res.json(cr);
  }),
);

export const adminCustomRequestRouter = Router();
adminCustomRequestRouter.use(requireAuth, requireRole('admin'));

adminCustomRequestRouter.get(
  '/',
  validate({ query: customRequestStatusFilterQuery }),
  asyncHandler(async (req, res) => {
    const { status } = req.validated?.query as { status?: string };
    const list = await prisma.customRequest.findMany({
      where: status && status !== 'all' ? { status: status as never } : {},
      include: includeCR,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    res.json(list);
  }),
);

adminCustomRequestRouter.put(
  '/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const cr = await prisma.customRequest.findUnique({ where: { id: req.params.id } });
    if (!cr) throw ApiError.notFound('Demande introuvable');
    const updated = await prisma.customRequest.update({
      where: { id: cr.id },
      data: { status: 'rejected', admin_quote_price: null },
      include: includeCR,
    });
    // La commande liée (créée à la demande) est annulée : notifs + push + socket via le service.
    const linked = await prisma.order.findUnique({ where: { custom_request_id: cr.id } });
    if (linked && linked.status === 'pending') {
      await changeOrderStatus(linked, 'cancelled', { actorRole: 'admin', actorUserId: req.user!.id });
    } else {
      await notifyAdmins('Demande refusee', `Demande ${cr.id.slice(0, 8)} refusee`, 'custom_request', {
        custom_request_id: updated.id,
      });
    }
    res.json(updated);
  }),
);
