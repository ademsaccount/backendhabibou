import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createOrderSchema, idParam, orderMessageSchema, approvePriceSchema, orderStatusFilterQuery, rateOrderSchema } from '../schemas';
import { deliveryFee } from '../services/order.service';
import { routeNewOrder } from '../services/dispatch.service';
import { isOpenNow } from '../lib/open';
import { notify, notifyAdmins, notifyAssignedLivreur } from '../lib/notify';
import { pushAdmins, pushNewMessageToUser, pushOrderStatusToUser } from '../lib/push';
import { emitToOrder } from '../socket/io';
import { createPaymentIntent, stripeEnabled } from '../lib/stripe';
import { orderInclude } from '../lib/orderInclude';
import type { Prisma } from '@prisma/client';

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

/** Lit le tableau JSON Product.sizes : [{label, price}] valides uniquement. */
function parseProductSizes(raw: unknown): { label: string; price: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; price: number }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { label, price } = entry as { label?: unknown; price?: unknown };
    if (typeof label === 'string' && label.trim() && typeof price === 'number' && Number.isFinite(price)) {
      out.push({ label: label.trim(), price });
    }
  }
  return out;
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
      items: { product_id: string; quantity: number; notes?: string; options?: unknown; size_label?: string }[];
    };

    const address = await prisma.address.findUnique({ where: { id: body.address_id } });
    if (!address || address.user_id !== userId) throw ApiError.notFound('Adresse introuvable');

    const fee = deliveryFee();

    const order = await prisma.$transaction(async (tx) => {
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

        // Taille : prix résolu côté serveur depuis Product.sizes (jamais le prix client).
        const sizes = parseProductSizes(product.sizes);
        let basePrice = product.price;
        let sizeLabel: string | null = null;
        if (item.size_label) {
          const found = sizes.find((entry) => entry.label === item.size_label);
          if (!found) throw ApiError.badRequest(`Taille inconnue : ${item.size_label}`, 'SIZE_NOT_FOUND');
          sizeLabel = found.label;
          // Une seule taille enregistrée : sizes ignoré pour le prix (price = vérité).
          if (sizes.length >= 2) basePrice = found.price;
        }

        const unit = basePrice + optionDelta(catalog, item.options);
        subtotal += unit * item.quantity;
        orderItems.push({
          product_id: product.id,
          quantity: item.quantity,
          unit_price: unit,
          notes: item.notes,
          options: item.options as Prisma.InputJsonValue | undefined,
          size_label: sizeLabel,
        });
      }

      if (!restaurantId) throw ApiError.badRequest('Aucun produit valide', 'INVALID_ITEMS');
      const restaurant = await tx.restaurant.findUnique({ where: { id: restaurantId } });
      if (!restaurant) throw ApiError.notFound('Commerce introuvable');
      if (!isOpenNow(restaurant)) throw ApiError.badRequest('Commerce ferme actuellement', 'RESTAURANT_CLOSED');

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

    const restaurantName = order.restaurant?.name ?? 'Commerce';

    // Routage intelligent de l'appel : admin libre -> appel entrant admin ;
    // admin occupe -> diffusion auto aux livreurs libres ; sinon file d'attente.
    await routeNewOrder({
      orderId: order.id,
      restaurantName,
      itemsCount: order.items.length,
      paymentMethod: order.payment_method,
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

/* ------------- Négociation (demandes spécifiques) : messages + prix ------------- */

async function getOwnOrderOrThrow(orderId: string, userId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.user_id !== userId) throw ApiError.notFound('Commande introuvable');
  return order;
}

function assertChatOpen(status: string) {
  if (status === 'cancelled' || status === 'delivered') {
    throw ApiError.badRequest('Discussion fermee', 'CHAT_CLOSED');
  }
}

orderRouter.get(
  '/:id/messages',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await getOwnOrderOrThrow(req.params.id, req.user!.id);
    const messages = await prisma.orderMessage.findMany({
      where: { order_id: order.id },
      orderBy: { created_at: 'asc' },
      take: 200,
    });
    res.json(messages);
  }),
);

orderRouter.post(
  '/:id/messages',
  validate(orderMessageSchema),
  asyncHandler(async (req, res) => {
    const order = await getOwnOrderOrThrow(req.params.id, req.user!.id);
    assertChatOpen(order.status);
    const body = req.validated?.body as { kind: 'text' | 'price'; text?: string; price?: number };
    if (body.kind === 'price') {
      throw ApiError.forbidden('Seul le livreur propose un prix', 'PRICE_FORBIDDEN');
    }
    const message = await prisma.orderMessage.create({
      data: {
        order_id: order.id,
        sender_id: req.user!.id,
        sender_role: 'client',
        kind: 'text',
        text: body.text!,
      },
    });
    emitToOrder(order.id, 'order:message:new', { message });
    await notifyAdmins(
      'Nouveau message client',
      (body.text ?? '').slice(0, 80),
      'order',
      { order_id: order.id },
    );
    void pushAdmins({
      title: 'Nouveau message client',
      body: (body.text ?? '').slice(0, 80),
      data: { type: 'order_message', order_id: order.id, url: `/admin/orders/${order.id}` },
    });
    await notifyAssignedLivreur(order, req.user!.id, (body.text ?? '').slice(0, 80));
    res.status(201).json(message);
  }),
);

orderRouter.post(
  '/:id/approve-price',
  validate(approvePriceSchema),
  asyncHandler(async (req, res) => {
    const order = await getOwnOrderOrThrow(req.params.id, req.user!.id);
    const body = req.validated?.body as { price: number; payment_method?: 'card' | 'cash' };
    if (order.price_status !== 'proposed' || order.proposed_price == null) {
      throw ApiError.badRequest('Aucune proposition a approuver', 'NO_PROPOSAL');
    }
    if (Math.abs(body.price - order.proposed_price) > 0.001) {
      throw ApiError.badRequest('Le prix a change', 'PRICE_MISMATCH');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        total_price: body.price + order.delivery_fee,
        price_status: 'approved',
        ...(body.payment_method ? { payment_method: body.payment_method } : {}),
      },
      include: orderInclude,
    });
    emitToOrder(order.id, 'order:price_update', {
      order_id: order.id,
      price_status: 'approved',
      total_price: updated.total_price,
    });
    await notifyAdmins('Prix approuve', `Commande ${order.id.slice(0, 8)} : prix accepte`, 'order', {
      order_id: order.id,
    });
    res.json(updated);
  }),
);

orderRouter.post(
  '/:id/reject-price',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await getOwnOrderOrThrow(req.params.id, req.user!.id);
    if (order.price_status !== 'proposed' || order.proposed_price == null) {
      throw ApiError.badRequest('Aucune proposition a refuser', 'NO_PROPOSAL');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { price_status: 'rejected' },
      include: orderInclude,
    });
    emitToOrder(order.id, 'order:price_update', { order_id: order.id, price_status: 'rejected' });
    await notifyAdmins('Prix refuse', `Commande ${order.id.slice(0, 8)} : prix refuse`, 'order', {
      order_id: order.id,
    });
    res.json(updated);
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
    // Push client (annulation) — apres la mise a jour, best effort.
    try {
      await pushOrderStatusToUser(updated.user_id, updated.id, 'cancelled');
    } catch (err) {
      void err;
    }
    res.json(updated);
  }),
);
