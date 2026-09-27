import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createCustomRequestSchema, customRequestStatusFilterQuery, idParam, quoteSchema } from '../schemas';
import { notify, notifyAdmins } from '../lib/notify';
import { emitToAdmins, emitToUser } from '../socket/io';

const includeCR = {
  address: true,
  user: { select: { id: true, full_name: true, phone: true, avatar_url: true } },
} as const;

export const customRequestRouter = Router();
customRequestRouter.use(requireAuth, requireRole('client'));

customRequestRouter.post(
  '/',
  validate(createCustomRequestSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      description_text: string;
      photo_url?: string;
      estimated_budget?: number;
      address_id: string;
    };
    const address = await prisma.address.findUnique({ where: { id: body.address_id } });
    if (!address || address.user_id !== req.user!.id) throw ApiError.notFound('Adresse introuvable');

    const cr = await prisma.customRequest.create({
      data: { ...body, user_id: req.user!.id },
      include: includeCR,
    });

    await notifyAdmins(
      'Nouvelle demande libre',
      `${req.user!.full_name} : ${cr.description_text.slice(0, 80)}`,
      'custom_request',
      { custom_request_id: cr.id },
    );
    emitToAdmins('notification:new', { type: 'custom_request', custom_request_id: cr.id });
    res.status(201).json(cr);
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

customRequestRouter.post(
  '/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const cr = await prisma.customRequest.findUnique({ where: { id: req.params.id } });
    if (!cr || cr.user_id !== req.user!.id) throw ApiError.notFound('Demande introuvable');
    if (cr.status !== 'quoted' || cr.admin_quote_price == null) {
      throw ApiError.badRequest('Aucun devis a accepter', 'NOT_QUOTED');
    }
    const updated = await prisma.customRequest.update({
      where: { id: cr.id },
      data: { status: 'accepted' },
      include: includeCR,
    });
    await notifyAdmins('Devis accepte', `Demande ${cr.id.slice(0, 8)} acceptee`, 'custom_request', {
      custom_request_id: cr.id,
    });
    res.json(updated);
  }),
);

customRequestRouter.post(
  '/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const cr = await prisma.customRequest.findUnique({ where: { id: req.params.id } });
    if (!cr || cr.user_id !== req.user!.id) throw ApiError.notFound('Demande introuvable');
    if (cr.status !== 'quoted') throw ApiError.badRequest('Aucun devis a refuser', 'NOT_QUOTED');
    const updated = await prisma.customRequest.update({
      where: { id: cr.id },
      data: { status: 'rejected' },
      include: includeCR,
    });
    await notify({
      user_id: req.user!.id,
      title: 'Devis refuse',
      body: 'Vous avez refuse le devis propose',
      type: 'custom_request',
      data: { custom_request_id: cr.id },
    });
    await notifyAdmins('Devis refuse', `Demande ${cr.id.slice(0, 8)} refusee`, 'custom_request', {
      custom_request_id: cr.id,
    });
    res.json(updated);
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
  '/:id/quote',
  validate(quoteSchema),
  asyncHandler(async (req, res) => {
    const { admin_quote_price } = req.validated?.body as { admin_quote_price: number };
    const cr = await prisma.customRequest.findUnique({ where: { id: req.params.id } });
    if (!cr) throw ApiError.notFound('Demande introuvable');
    if (cr.status === 'accepted' || cr.status === 'rejected') {
      throw ApiError.badRequest('Demande deja clos', 'REQUEST_CLOSED');
    }

    const updated = await prisma.customRequest.update({
      where: { id: cr.id },
      data: { admin_quote_price, status: 'quoted' },
      include: includeCR,
    });

    const payload = { custom_request_id: updated.id, admin_quote_price, status: updated.status };
    emitToUser(cr.user_id, 'custom_request:quoted', payload);
    await notify({
      user_id: cr.user_id,
      title: 'Devis recu',
      body: `Prix propose : ${admin_quote_price.toFixed(2)} MAD`,
      type: 'custom_request',
      data: { custom_request_id: updated.id },
    });
    res.json(updated);
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
    await notify({
      user_id: cr.user_id,
      title: 'Demande refusee',
      body: 'Votre demande libre a ete refusee par notre equipe',
      type: 'custom_request',
      data: { custom_request_id: updated.id },
    });
    res.json(updated);
  }),
);
