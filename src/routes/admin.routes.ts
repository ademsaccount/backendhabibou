import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createIngredientSchema,
  createLivreurSchema,
  createMedicationCategorySchema,
  createProductSchema,
  createRestaurantSchema,
  createStorySchema,
  createSupplementSchema,
  idParam,
  orderMessageSchema,
  adminOrderStatusSchema,
  orderStatusFilterQuery,
  updateLivreurSchema,
  updateMedicationCategorySchema,
  updateProductSchema,
  updateRestaurantSchema,
  updateStorySchema,
} from '../schemas';
import {
  productCatalogInclude,
  syncProductIngredients,
  syncProductSupplements,
  withCatalogs,
  type IngredientInput,
  type SupplementInput,
} from '../lib/catalog';
// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// import { assignLivreur, changeOrderStatus } from '../services/order.service';
import { changeOrderStatus } from '../services/order.service';
// --- FIN DÉSACTIVÉ ---
// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// import { haversineKm, roundKm } from '../lib/geo';
// --- FIN DÉSACTIVÉ ---
import { orderInclude } from './order.routes';
import { broadcast, emitToOrder, emitToUser } from '../socket/io';
import { notify, notifyAssignedLivreur } from '../lib/notify';
import { pushNewMessageToUser, pushToUser } from '../lib/push';
import type { Prisma } from '@prisma/client';

type ProductBody = {
  ingredients?: IngredientInput[];
  supplements?: SupplementInput[];
  sizes?: { label: string; price: number }[] | null;
} & Record<string, unknown>;

/**
 * Tailles multiples : dès 2 entrées, price est resynchronisé sur le minimum
 * (affichage « à partir de X » + valeur de repli pour le code qui lit
 * product.price). sizes vide ou à 1 entrée : price inchangé.
 */
function applySizePrice(data: Record<string, unknown>): void {
  const sizes = data.sizes;
  if (!Array.isArray(sizes) || sizes.length < 2) return;
  const prices = sizes
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { price?: unknown }).price : undefined))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (prices.length >= 2) data.price = Math.min(...prices);
}

const productInclude: Prisma.ProductInclude = {
  restaurant: { select: { id: true, name: true } },
  ...productCatalogInclude,
};

// Base distante : la synchronisation du catalogue (n requêtes par ligne) dépasse largement
// le timeout interactif par défaut de Prisma (5 s).
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Valide l'existence de la catégorie de médicaments si renseignée. */
async function assertMedicationCategory(id: string | null | undefined) {
  if (!id) return;
  const category = await prisma.medicationCategory.findUnique({ where: { id } });
  if (!category) throw ApiError.badRequest('Categorie de medicaments introuvable', 'MEDICATION_CATEGORY_NOT_FOUND');
}
// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// const livreurInclude = {
//   user: { select: { id: true, full_name: true, phone: true, email: true, avatar_url: true } },
//   orders: {
//     where: { status: { in: ['confirmed', 'preparing', 'picked_up', 'on_the_way'] as never } },
//     select: { id: true },
//   },
// } as const;
// --- FIN DÉSACTIVÉ ---

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

/* ---------------- Dashboard ---------------- */

adminRouter.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // --- DÉSACTIVÉ : demandes libres + compteurs livreurs inutilisés (l'admin est l'unique livreur) ---
    // const pendingCustomRequests = prisma.customRequest.count({ where: { status: 'pending' } });
    // const livreursOnline = prisma.livreur.count({ where: { is_online: true } });
    // --- FIN DÉSACTIVÉ ---
    const [ordersToday, revenue, activeOrders, totalRestaurants] = await Promise.all([
      prisma.order.count({ where: { created_at: { gte: startOfDay } } }),
      prisma.order.aggregate({
        where: { created_at: { gte: startOfDay }, status: { not: 'cancelled' } },
        _sum: { total_price: true },
      }),
      prisma.order.count({ where: { status: { in: ['pending', 'confirmed', 'preparing', 'picked_up', 'on_the_way'] } } }),
      prisma.restaurant.count(),
    ]);

    res.json({
      orders_today: ordersToday,
      revenue_today: revenue._sum.total_price ?? 0,
      // --- DÉSACTIVÉ : demandes libres + compteurs livreurs inutilisés ---
      // pending_custom_requests: pendingCustomRequests,
      // livreurs_online: livreursOnline,
      // --- FIN DÉSACTIVÉ ---
      active_orders: activeOrders,
      total_restaurants: totalRestaurants,
    });
  }),
);

/* ---------------- Stats ---------------- */

adminRouter.get(
  '/stats/revenue',
  asyncHandler(async (req, res) => {
    const days = Math.min(31, Math.max(1, Math.floor(Number(req.query.days ?? 7)) || 7));
    // Jours calendaires de Tunis (pas UTC) : commandes annulées exclues.
    const rows = await prisma.$queryRaw<{ day: string; total: number; count: bigint }[]>`
      SELECT TO_CHAR(DATE_TRUNC('day', "created_at" AT TIME ZONE 'Africa/Tunis'), 'YYYY-MM-DD') AS day,
             COALESCE(SUM("total_price"), 0) AS total,
             COUNT(*) AS count
      FROM "Order"
      WHERE "created_at" >= (NOW() - (${days} || ' days')::INTERVAL)
        AND "status" <> 'cancelled'
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    res.json(rows.map((r) => ({ day: r.day, total: Number(r.total), count: Number(r.count) })));
  }),
);

/* ---------------- Restaurants ---------------- */

adminRouter.get(
  '/restaurants',
  asyncHandler(async (_req, res) => {
    const restaurants = await prisma.restaurant.findMany({
      include: { _count: { select: { products: true, orders: true } } },
      orderBy: { created_at: 'desc' },
    });
    res.json(restaurants);
  }),
);

adminRouter.get(
  '/restaurants/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      include: { products: { include: productCatalogInclude, orderBy: [{ category: 'asc' }, { name: 'asc' }] } },
    });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');
    res.json({ ...restaurant, products: restaurant.products.map((p) => withCatalogs(p)) });
  }),
);

adminRouter.post(
  '/restaurants',
  validate(createRestaurantSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as Record<string, unknown>;
    const restaurant = await prisma.restaurant.create({
      data: { ...(body as Prisma.RestaurantUncheckedCreateInput), created_by_admin_id: req.user!.id },
    });
    res.status(201).json(restaurant);
  }),
);

adminRouter.put(
  '/restaurants/:id',
  validate(updateRestaurantSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.restaurant.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Commerce introuvable');
    const body = req.validated?.body as Record<string, unknown>;
    const restaurant = await prisma.restaurant.update({ where: { id: existing.id }, data: body as never });
    res.json(restaurant);
  }),
);

adminRouter.delete(
  '/restaurants/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.restaurant.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Commerce introuvable');
    // Suppression en cascade assumée : commandes (→ OrderItem/avis) puis commerce (→ produits).
    // L'ordre est important : Order.restaurant_id est en SET NULL, pas CASCADE.
    await prisma.$transaction(async (tx) => {
      await tx.order.deleteMany({ where: { restaurant_id: existing.id } });
      await tx.restaurant.delete({ where: { id: existing.id } });
    }, TX_OPTS);
    res.status(204).send();
  }),
);

/* ---------------- Stories ---------------- */

const storyInclude = {
  restaurant: { select: { id: true, name: true, logo_url: true } },
} as const;

adminRouter.get(
  '/stories',
  asyncHandler(async (_req, res) => {
    const stories = await prisma.story.findMany({
      include: storyInclude,
      orderBy: { created_at: 'desc' },
    });
    res.json(stories);
  }),
);

adminRouter.post(
  '/stories',
  validate(createStorySchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      restaurant_id: string;
      media_url: string;
      media_type: 'image' | 'video';
      text?: string | null;
      text_color?: string | null;
      text_x?: number | null;
      text_y?: number | null;
      text_scale?: number | null;
      duration_hours?: number | null;
    };
    const restaurant = await prisma.restaurant.findUnique({ where: { id: body.restaurant_id } });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');
    const story = await prisma.story.create({
      data: {
        restaurant_id: body.restaurant_id,
        media_url: body.media_url,
        media_type: body.media_type,
        text: body.text ?? null,
        text_color: body.text_color ?? null,
        text_x: body.text_x ?? null,
        text_y: body.text_y ?? null,
        text_scale: body.text_scale ?? null,
        expires_at:
          body.duration_hours != null
            ? new Date(Date.now() + body.duration_hours * 3_600_000)
            : null,
        created_by_admin_id: req.user!.id,
      },
      include: storyInclude,
    });
    res.status(201).json(story);
    broadcast('stories:changed', { action: 'created', id: story.id });
  }),
);

adminRouter.get(
  '/stories/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const story = await prisma.story.findUnique({
      where: { id: req.params.id },
      include: storyInclude,
    });
    if (!story) throw ApiError.notFound('Story introuvable');
    res.json(story);
  }),
);

adminRouter.put(
  '/stories/:id',
  validate(updateStorySchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.story.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Story introuvable');
    const body = req.validated?.body as {
      text?: string | null;
      text_color?: string | null;
      text_x?: number | null;
      text_y?: number | null;
      text_scale?: number | null;
      is_active?: boolean;
      expires_at?: string | null;
    };
    const story = await prisma.story.update({
      where: { id: existing.id },
      data: {
        ...(body.text !== undefined ? { text: body.text } : {}),
        ...(body.text_color !== undefined ? { text_color: body.text_color } : {}),
        ...(body.text_x !== undefined ? { text_x: body.text_x } : {}),
        ...(body.text_y !== undefined ? { text_y: body.text_y } : {}),
        ...(body.text_scale !== undefined ? { text_scale: body.text_scale } : {}),
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
        ...(body.expires_at !== undefined
          ? { expires_at: body.expires_at ? new Date(body.expires_at) : null }
          : {}),
      },
      include: storyInclude,
    });
    res.json(story);
    broadcast('stories:changed', { action: 'updated', id: story.id });
  }),
);

adminRouter.delete(
  '/stories/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.story.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Story introuvable');
    await prisma.story.delete({ where: { id: existing.id } });
    res.status(204).send();
    broadcast('stories:changed', { action: 'deleted', id: existing.id });
  }),
);

/* ---------------- Produits ---------------- */

adminRouter.get(
  '/restaurants/:id/products',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.params.id } });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');
    const products = await prisma.product.findMany({
      where: { restaurant_id: restaurant.id },
      include: productInclude,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(products.map((p) => withCatalogs(p)));
  }),
);

adminRouter.post(
  '/restaurants/:id/products',
  validate(createProductSchema),
  asyncHandler(async (req, res) => {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: req.params.id } });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');

    const { ingredients, supplements, ...data } = req.validated?.body as ProductBody;
    await assertMedicationCategory(data.medication_category_id as string | null | undefined);
    applySizePrice(data);

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: { ...(data as Prisma.ProductUncheckedCreateInput), restaurant_id: restaurant.id },
      });
      await syncProductIngredients(tx, created.id, ingredients, req.user!.id);
      await syncProductSupplements(tx, created.id, supplements, req.user!.id);
      return tx.product.findUnique({ where: { id: created.id }, include: productInclude });
    }, TX_OPTS);
    res.status(201).json(withCatalogs(product!));
  }),
);

adminRouter.put(
  '/products/:id',
  validate(updateProductSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Produit introuvable');

    const { ingredients, supplements, ...data } = req.validated?.body as ProductBody;
    await assertMedicationCategory(data.medication_category_id as string | null | undefined);
    applySizePrice(data);

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: data as Prisma.ProductUncheckedUpdateInput,
        include: productInclude,
      });
      await syncProductIngredients(tx, updated.id, ingredients, req.user!.id);
      await syncProductSupplements(tx, updated.id, supplements, req.user!.id);
      return tx.product.findUnique({ where: { id: updated.id }, include: productInclude });
    }, TX_OPTS);
    res.json(withCatalogs(product!));
  }),
);

adminRouter.delete(
  '/products/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Produit introuvable');
    const used = await prisma.orderItem.count({ where: { product_id: existing.id } });
    if (used > 0) {
      const product = await prisma.product.update({
        where: { id: existing.id },
        data: { is_available: false },
        include: productInclude,
      });
      return res.json(withCatalogs(product));
    }
    await prisma.product.delete({ where: { id: existing.id } });
    res.status(204).send();
  }),
);

/* ------------- Catalogues globaux : ingrédients & suppléments ------------- */

adminRouter.get(
  '/ingredients',
  asyncHandler(async (_req, res) => {
    const ingredients = await prisma.ingredient.findMany({
      where: { in_catalog: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    res.json(ingredients);
  }),
);

adminRouter.post(
  '/ingredients',
  validate(createIngredientSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as { name: string; in_catalog?: boolean };
    const name = body.name.trim();
    const existing = await prisma.ingredient.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      const ingredient = await prisma.ingredient.update({
        where: { id: existing.id },
        data: { in_catalog: body.in_catalog ?? true },
        include: { _count: { select: { products: true } } },
      });
      return res.json(ingredient);
    }
    const ingredient = await prisma.ingredient.create({
      data: { name, in_catalog: body.in_catalog ?? true, created_by_admin: req.user!.id },
      include: { _count: { select: { products: true } } },
    });
    res.status(201).json(ingredient);
  }),
);

adminRouter.get(
  '/supplements',
  asyncHandler(async (_req, res) => {
    const supplements = await prisma.supplement.findMany({
      where: { in_catalog: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    res.json(supplements);
  }),
);

adminRouter.post(
  '/supplements',
  validate(createSupplementSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as { name: string; default_extra_price?: number; in_catalog?: boolean };
    const name = body.name.trim();
    const existing = await prisma.supplement.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      const supplement = await prisma.supplement.update({
        where: { id: existing.id },
        data: {
          in_catalog: body.in_catalog ?? true,
          ...(body.default_extra_price !== undefined ? { default_extra_price: body.default_extra_price } : {}),
        },
        include: { _count: { select: { products: true } } },
      });
      return res.json(supplement);
    }
    const supplement = await prisma.supplement.create({
      data: {
        name,
        default_extra_price: body.default_extra_price ?? 0,
        in_catalog: body.in_catalog ?? true,
        created_by_admin: req.user!.id,
      },
      include: { _count: { select: { products: true } } },
    });
    res.status(201).json(supplement);
  }),
);

/* ------------- Catégories de médicaments (flux Pharmacie, configurables) ------------- */

adminRouter.get(
  '/medication-categories',
  asyncHandler(async (_req, res) => {
    const categories = await prisma.medicationCategory.findMany({
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    res.json(categories);
  }),
);

adminRouter.post(
  '/medication-categories',
  validate(createMedicationCategorySchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as Record<string, unknown>;
    const category = await prisma.medicationCategory.create({
      data: body as Prisma.MedicationCategoryUncheckedCreateInput,
      include: { _count: { select: { products: true } } },
    });
    res.status(201).json(category);
  }),
);

adminRouter.put(
  '/medication-categories/:id',
  validate(updateMedicationCategorySchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.medicationCategory.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Categorie introuvable');
    const body = req.validated?.body as Record<string, unknown>;
    const category = await prisma.medicationCategory.update({
      where: { id: existing.id },
      data: body as Prisma.MedicationCategoryUncheckedUpdateInput,
      include: { _count: { select: { products: true } } },
    });
    res.json(category);
  }),
);

adminRouter.delete(
  '/medication-categories/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.medicationCategory.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { products: true } } },
    });
    if (!existing) throw ApiError.notFound('Categorie introuvable');
    if (existing._count.products > 0) {
      throw ApiError.conflict('Categorie liee a des produits : desactivez-la plutot', 'HAS_PRODUCTS');
    }
    await prisma.medicationCategory.delete({ where: { id: existing.id } });
    res.status(204).send();
  }),
);

/* ---------------- Commandes ---------------- */

adminRouter.get(
  '/orders',
  validate({ query: orderStatusFilterQuery }),
  asyncHandler(async (req, res) => {
    const { status } = req.validated?.query as { status?: string };
    const orders = await prisma.order.findMany({
      where: status && status !== 'all' ? { status: status as never } : {},
      include: orderInclude,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    res.json(orders);
  }),
);

adminRouter.get(
  '/orders/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
    if (!order) throw ApiError.notFound('Commande introuvable');
    res.json(order);
  }),
);

adminRouter.put(
  '/orders/:id/status',
  validate(adminOrderStatusSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.validated?.body as {
      status: 'confirmed' | 'preparing' | 'picked_up' | 'on_the_way' | 'delivered' | 'cancelled';
    };
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    // Mainmise livreur : des qu'un livreur a pris la commande, l'admin ne la
    // touche plus (ni avancement, ni annulation) — course admin/livreur impossible.
    if (order.livreur_id != null) {
      throw ApiError.forbidden('Commande prise en charge par un livreur', 'ORDER_OWNED_BY_LIVREUR');
    }
    const updated = await changeOrderStatus(order, status, { actorRole: 'admin', actorUserId: req.user!.id });
    res.json(updated);
  }),
);

/**
 * Diffusion d'appel : la commande (pending) sonne chez tous les autres livreurs
 * en ligne. Le premier qui accepte la prend ; les refus n'arrêtent pas les autres ;
 * si tous refusent, la commande est annulée.
 */
adminRouter.post(
  '/orders/:id/diffuse',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (order.status !== 'pending') {
      throw ApiError.badRequest('Diffusion impossible a ce stade', 'NOT_DIFFUSABLE');
    }
    const online = await prisma.livreur.findMany({
      where: { is_online: true, user_id: { not: req.user!.id }, user: { role: 'livreur' } },
      select: { user_id: true },
    });
    if (online.length === 0) {
      throw ApiError.badRequest('Aucun livreur en ligne', 'DIFFUSE_EMPTY');
    }
    const ids = online.map((l) => l.user_id);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { diffused_at: new Date(), diffused_to: ids, rejected_by: [] },
      include: orderInclude,
    });
    for (const userId of ids) {
      emitToUser(userId, 'order:diffuse', { order_id: order.id });
    }
    for (const userId of ids) {
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
    res.json(updated);
  }),
);

adminRouter.get(
  '/orders/:id/messages',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    const messages = await prisma.orderMessage.findMany({
      where: { order_id: order.id },
      orderBy: { created_at: 'asc' },
      take: 200,
    });
    res.json(messages);
  }),
);

adminRouter.post(
  '/orders/:id/messages',
  validate(orderMessageSchema),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (order.status === 'cancelled' || order.status === 'delivered') {
      throw ApiError.badRequest('Discussion fermee', 'CHAT_CLOSED');
    }
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
        ? `Prix propose : ${body.price.toFixed(2)} MAD`
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
    await notifyAssignedLivreur(order, req.user!.id, preview);
    res.status(201).json(message);
  }),
);

// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// adminRouter.put(
//   '/orders/:id/assign',
//   validate(assignSchema),
//   asyncHandler(async (req, res) => {
//     const body = req.validated?.body as { livreur_id?: string; auto?: boolean };
//     const updated = await assignLivreur(req.params.id, body.livreur_id ?? null, body.auto ?? !body.livreur_id);
//     res.json(updated);
//   }),
// );
// --- FIN DÉSACTIVÉ ---

/* ---------------- Livreurs (gérés par l'admin top) ---------------- */

const livreurUserSelect = {
  id: true,
  email: true,
  full_name: true,
  phone: true,
  avatar_url: true,
  role: true,
  created_at: true,
} as const;

/**
 * Reprise en main : une commande prise en charge puis abandonnee (livreur
 * supprime, desactive ou fantome) repasse en attente non attribuee. L'admin
 * la retravaille ensuite normalement (diffusion / acceptation / annulation).
 */
adminRouter.post(
  '/orders/:id/reclaim',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) throw ApiError.notFound('Commande introuvable');
    if (order.livreur_id == null) {
      throw ApiError.badRequest('Commande non attribuee', 'NOT_CLAIMED');
    }
    if (order.status === 'delivered' || order.status === 'cancelled') {
      throw ApiError.badRequest('Commande deja cloturee', 'NOT_RECLAIMABLE');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        livreur_id: null,
        diffused_at: null,
        diffused_to: [],
        rejected_by: [],
        status: 'pending',
      },
      include: orderInclude,
    });
    emitToOrder(order.id, 'order:status_update', {
      order_id: order.id,
      status: 'pending',
      label: 'En attente de confirmation',
    });
    await notify({
      user_id: updated.user_id,
      title: 'Commande reattribuee',
      body: `Commande ${order.id.slice(0, 8)} : un nouveau livreur va la prendre en charge`,
      type: 'order',
      data: { order_id: order.id },
    });
    res.json(updated);
  }),
);

adminRouter.get(
  '/livreurs',
  asyncHandler(async (_req, res) => {
    // Inclut les livreurs desactives (role client + ligne Livreur conservee) :
    // sans eux, un livreur "eteint" disparait de l'UI sans aucun moyen de
    // le reactiver.
    const users = await prisma.user.findMany({
      where: { OR: [{ role: 'livreur' }, { livreur: { isNot: null } }] },
      select: { ...livreurUserSelect, livreur: true },
      orderBy: { created_at: 'desc' },
    });
    const activeCounts = await prisma.order.groupBy({
      by: ['livreur_id'],
      where: { livreur_id: { not: null }, status: { in: ['confirmed', 'preparing', 'picked_up', 'on_the_way'] } },
      _count: { _all: true },
    });
    res.json(
      users.map((u) => ({
        ...u,
        active_orders: activeCounts.find((c) => c.livreur_id === u.livreur?.id)?._count._all ?? 0,
      })),
    );
  }),
);

adminRouter.get(
  '/livreurs/online-count',
  asyncHandler(async (_req, res) => {
    const count = await prisma.livreur.count({
      where: { is_online: true, user: { role: 'livreur' } },
    });
    res.json({ count });
  }),
);

adminRouter.post(
  '/livreurs',
  validate(createLivreurSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      email: string;
      password: string;
      full_name: string;
      phone?: string;
      avatar_url?: string | null;
      vehicle_type?: string;
    };
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw ApiError.conflict('Un compte existe deja avec cet email', 'EMAIL_TAKEN');
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          password_hash: await bcrypt.hash(body.password, 10),
          full_name: body.full_name,
          phone: body.phone ?? null,
          avatar_url: body.avatar_url ?? null,
          role: 'livreur',
        },
        select: livreurUserSelect,
      });
      const livreur = await tx.livreur.create({
        data: { user_id: user.id, vehicle_type: body.vehicle_type ?? 'moto' },
      });
      return { ...user, livreur };
    });
    res.status(201).json(created);
  }),
);

adminRouter.put(
  '/livreurs/:id',
  validate(updateLivreurSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      full_name?: string;
      phone?: string | null;
      avatar_url?: string | null;
      vehicle_type?: string;
      role?: 'livreur' | 'client';
    };
    const existing = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { livreur: true },
    });
    if (!existing) throw ApiError.notFound('Livreur introuvable');
    // Desactivation interdite tant que le livreur possede des courses non
    // terminees : sinon la commande reste gele (ni admin ni livreur ne peut
    // la toucher une fois prise en charge).
    if (body.role === 'client' && existing.livreur) {
      const activeCount = await prisma.order.count({
        where: { livreur_id: existing.livreur.id, status: { notIn: ['delivered', 'cancelled'] } },
      });
      if (activeCount > 0) {
        throw ApiError.conflict(
          `Ce livreur a ${activeCount} course(s) en cours : terminez-les ou recuperez-les avant de le desactiver`,
          'LIVREUR_HAS_ACTIVE_ORDERS',
        );
      }
    }
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: existing.id },
        data: {
          ...(body.full_name !== undefined ? { full_name: body.full_name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.avatar_url !== undefined ? { avatar_url: body.avatar_url } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
        },
        select: livreurUserSelect,
      });
      let livreur = existing.livreur;
      if (body.role === 'livreur' || (body.role === undefined && (existing.role as string) === 'livreur')) {
        livreur = await tx.livreur.upsert({
          where: { user_id: existing.id },
          update: body.vehicle_type !== undefined ? { vehicle_type: body.vehicle_type } : {},
          create: { user_id: existing.id, vehicle_type: body.vehicle_type ?? 'moto' },
        });
      } else if (body.vehicle_type !== undefined && livreur) {
        livreur = await tx.livreur.update({
          where: { id: livreur.id },
          data: { vehicle_type: body.vehicle_type },
        });
      }
      return { ...user, livreur };
    });
    res.json(updated);
  }),
);

adminRouter.delete(
  '/livreurs/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { livreur: true },
    });
    if (!existing) throw ApiError.notFound('Livreur introuvable');
    // Suppression interdite avec des courses non terminees (meme motif que
    // la desactivation). Le garde-fou FK ci-dessous reste en dernier ressort.
    if (existing.livreur) {
      const activeCount = await prisma.order.count({
        where: { livreur_id: existing.livreur.id, status: { notIn: ['delivered', 'cancelled'] } },
      });
      if (activeCount > 0) {
        throw ApiError.conflict(
          `Ce livreur a ${activeCount} course(s) en cours : terminez-les ou recuperez-les avant de le supprimer`,
          'LIVREUR_HAS_ACTIVE_ORDERS',
        );
      }
    }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.livreur.deleteMany({ where: { user_id: existing.id } });
        await tx.user.delete({ where: { id: existing.id } });
      });
    } catch {
      throw ApiError.conflict('Livreur avec historique : désactivez-le plutôt', 'HAS_ORDERS');
    }
    res.status(204).send();
  }),
);
