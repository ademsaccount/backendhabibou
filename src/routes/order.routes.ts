import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createOrderSchema, idParam, orderStatusFilterQuery, rateOrderSchema } from '../schemas';
import { deliveryFee } from '../services/order.service';
import { notify, notifyAdmins } from '../lib/notify';
import { pushAdmins } from '../lib/push';
import { emitToAdmins } from '../socket/io';
import { createPaymentIntent, stripeEnabled } from '../lib/stripe';
import type { Prisma } from '@prisma/client';

export const orderInclude = {
  items: { include: { product: { select: { id: true, name: true, image_url: true, restaurant_id: true } } } },
  restaurant: true,
  address: true,
  livreur: {
    include: { user: { select: { id: true, full_name: true, phone: true, avatar_url: true } } },
  },
  user: { select: { id: true, full_name: true, phone: true, avatar_url: true } },
  custom_request: true,
  review: true,
} satisfies Prisma.OrderInclude;

/** Recolte {name, price} dans le JSON de catalog d'options d'un produit. */
function collectCatalogEntries(node: unknown, out: { name: string; price: number }[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCatalogEntries(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.name === 'string' && typeof obj.price === 'number') {
      out.push({ name: obj.name, price: obj.price });
      return;
    }
    for (const value of Object.values(obj)) collectCatalogEntries(value, out);
  }
}

/** Recolte les noms d'options selectionnees (chaines ou objets {name}). */
function collectSelectedNames(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSelectedNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.name === 'string') out.push(obj.name);
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'name') collectSelectedNames(value, out);
    }
  }
}

/** Supplément en MAD : uniquement via le catalog serveur (le prix client est ignore). */
function optionDelta(catalogOptions: unknown, selectedOptions: unknown): number {
  if (selectedOptions == null) return 0;
  const entries: { name: string; price: number }[] = [];
  collectCatalogEntries(catalogOptions, entries);
  if (entries.length === 0) return 0;
  const byName = new Map(entries.map((e) => [e.name, e.price]));
  const names: string[] = [];
  collectSelectedNames(selectedOptions, names);
  const seen = new Set<string>();
  let delta = 0;
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    delta += byName.get(name) ?? 0;
  }
  return delta;
}

export const orderRouter = Router();
orderRouter.use(requireAuth, requireRole('client'));

orderRouter.post(
  '/',
  validate(createOrderSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const body = req.validated?.body as {
      address_id: string;
      payment_method: 'card' | 'cash';
      // Commande issue d'une "Demande spécifique" (devis admin accepté).
      custom_request_id?: string;
      items?: { product_id: string; quantity: number; notes?: string; options?: unknown }[];
    };

    const address = await prisma.address.findUnique({ where: { id: body.address_id } });
    if (!address || address.user_id !== userId) throw ApiError.notFound('Adresse introuvable');

    const fee = deliveryFee();

    const order = await prisma.$transaction(async (tx) => {
      if (body.custom_request_id) {
        const cr = await tx.customRequest.findUnique({ where: { id: body.custom_request_id } });
        if (!cr || cr.user_id !== userId) throw ApiError.notFound('Demande introuvable');
        if (cr.status !== 'accepted' || cr.admin_quote_price == null) {
          throw ApiError.badRequest('Devis non accepte', 'REQUEST_NOT_ACCEPTED');
        }
        const existing = await tx.order.findUnique({ where: { custom_request_id: cr.id } });
        if (existing) throw ApiError.conflict('Commande deja creee pour cette demande', 'ORDER_EXISTS');

        const created = await tx.order.create({
          data: {
            user_id: userId,
            custom_request_id: cr.id,
            address_id: body.address_id,
            payment_method: body.payment_method,
            total_price: cr.admin_quote_price + fee,
            delivery_fee: fee,
          },
          include: orderInclude,
        });
        return created;
      }

      const items = body.items ?? [];
      if (items.length === 0) throw ApiError.badRequest('Panier vide', 'EMPTY_CART');

      const productIds = items.map((i) => i.product_id);
      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      const byId = new Map(products.map((p) => [p.id, p]));

      // Catalogue de suppléments par produit (prix calculé côté serveur, prix client ignoré).
      const supplementRows = await tx.productSupplement.findMany({
        where: { product_id: { in: productIds } },
        include: { supplement: true },
      });
      const supplementsByProduct = new Map<string, { name: string; price: number }[]>();
      for (const row of supplementRows) {
        const list = supplementsByProduct.get(row.product_id) ?? [];
        list.push({
          name: row.supplement.name,
          price: row.extra_price_override ?? row.supplement.default_extra_price,
        });
        supplementsByProduct.set(row.product_id, list);
      }

      let restaurantId: string | null = null;
      let subtotal = 0;
      const orderItems: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];

      for (const item of items) {
        const product = byId.get(item.product_id);
        if (!product) throw ApiError.badRequest(`Produit introuvable : ${item.product_id}`, 'PRODUCT_NOT_FOUND');
        if (!product.is_available) throw ApiError.badRequest(`${product.name} n'est plus disponible`, 'PRODUCT_UNAVAILABLE');
        if (restaurantId && product.restaurant_id !== restaurantId) {
          throw ApiError.badRequest('Tous les articles doivent venir du meme commerce', 'MULTI_RESTAURANT');
        }
        restaurantId = product.restaurant_id;

        const catalog: { name: string; price: number }[] = [];
        collectCatalogEntries(product.options, catalog);
        catalog.push(...(supplementsByProduct.get(product.id) ?? []));

        const unit = product.price + optionDelta(catalog, item.options);
        subtotal += unit * item.quantity;
        orderItems.push({
          product_id: product.id,
          quantity: item.quantity,
          unit_price: unit,
          notes: item.notes,
          options: item.options as Prisma.InputJsonValue | undefined,
        });
      }

      if (!restaurantId) throw ApiError.badRequest('Aucun produit valide', 'INVALID_ITEMS');
      const restaurant = await tx.restaurant.findUnique({ where: { id: restaurantId } });
      if (!restaurant) throw ApiError.notFound('Commerce introuvable');
      if (!restaurant.is_open) throw ApiError.badRequest('Commerce ferme actuellement', 'RESTAURANT_CLOSED');

      return tx.order.create({
        data: {
          user_id: userId,
          restaurant_id: restaurantId,
          address_id: body.address_id,
          payment_method: body.payment_method,
          delivery_fee: fee,
          total_price: subtotal + fee,
          items: { create: orderItems },
        },
        include: orderInclude,
      });
    });

    const orderRef = order.id.slice(0, 8);
    const restaurantName = order.restaurant?.name ?? 'Commerce';

    // Alerte "appel entrant" cote admin (sudo_habichou) : event socket + push.
    emitToAdmins('order:incoming', {
      order_id: order.id,
      restaurant: restaurantName,
      total_price: order.total_price,
      items_count: order.items.length,
      payment_method: order.payment_method,
      url: `/admin/incoming?order_id=${order.id}`,
      created_at: order.created_at.toISOString(),
    });

    await notifyAdmins(
      'Nouvelle commande',
      `Commande ${orderRef} — ${order.total_price.toFixed(2)} MAD`,
      'order',
      { order_id: order.id },
    );

    void pushAdmins({
      title: 'Nouvelle commande',
      body: `${restaurantName} — ${order.total_price.toFixed(2)} MAD · ${order.items.length} article(s)`,
      channelId: 'incoming_order',
      sound: 'incoming_order.wav',
      data: { type: 'order_incoming', order_id: order.id, url: `/admin/incoming?order_id=${order.id}` },
    });

    res.status(201).json(order);
  }),
);

orderRouter.get(
  '/me',
  validate({ query: orderStatusFilterQuery }),
  asyncHandler(async (req, res) => {
    const { status } = req.validated?.query as { status?: string };
    const orders = await prisma.order.findMany({
      where: { user_id: req.user!.id, ...(status && status !== 'all' ? { status: status as never } : {}) },
      include: orderInclude,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(orders);
  }),
);

orderRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (order.user_id !== req.user!.id) throw ApiError.forbidden();
    res.json(order);
  }),
);

orderRouter.post(
  '/:id/rate',
  validate(rateOrderSchema),
  asyncHandler(async (req, res) => {
    const { rating, comment } = req.validated?.body as { rating: number; comment?: string };
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.user_id !== req.user!.id) throw ApiError.notFound('Commande introuvable');
    if (order.status !== 'delivered') throw ApiError.badRequest('Commande non livree', 'NOT_DELIVERED');

    const existing = await prisma.review.findUnique({ where: { order_id: order.id } });
    if (existing) throw ApiError.conflict('Deja notee', 'ALREADY_REVIEWED');

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          order_id: order.id,
          user_id: req.user!.id,
          restaurant_id: order.restaurant_id,
          rating,
          comment: comment ?? null,
        },
      });
      if (order.restaurant_id) {
        const agg = await tx.review.aggregate({
          where: { restaurant_id: order.restaurant_id },
          _avg: { rating: true },
          _count: true,
        });
        await tx.restaurant.update({
          where: { id: order.restaurant_id },
          data: { rating: Math.round((agg._avg.rating ?? 0) * 10) / 10 },
        });
      }
      return created;
    });

    res.status(201).json(review);
  }),
);

orderRouter.post(
  '/:id/pay',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.user_id !== req.user!.id) throw ApiError.notFound('Commande introuvable');
    if (order.payment_method !== 'card') throw ApiError.badRequest('Paiement a la livraison', 'NOT_CARD_PAYMENT');
    if (order.payment_status === 'paid') throw ApiError.badRequest('Deja payee', 'ALREADY_PAID');

    const client_secret = await createPaymentIntent(order.id, order.total_price);
    if (client_secret && client_secret !== order.payment_intent_id) {
      await prisma.order.update({ where: { id: order.id }, data: { payment_intent_id: client_secret } });
    }
    res.json({
      client_secret,
      simulated: !stripeEnabled(),
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    });
  }),
);

orderRouter.put(
  '/:id/cancel',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order || order.user_id !== req.user!.id) throw ApiError.notFound('Commande introuvable');
    if (!['pending', 'confirmed'].includes(order.status)) {
      throw ApiError.badRequest('Annulation impossible a ce stade', 'CANNOT_CANCEL');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'cancelled' },
      include: orderInclude,
    });
    await notify({
      user_id: order.user_id,
      title: 'Commande annulee',
      body: 'Votre commande a ete annulee',
      type: 'order',
      data: { order_id: order.id },
    });
    res.json(updated);
  }),
);
