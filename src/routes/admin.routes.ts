import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  // --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
  // assignSchema,
  // updateLivreurSchema,
  // --- FIN DÉSACTIVÉ ---
  createIngredientSchema,
  createMedicationCategorySchema,
  createProductSchema,
  createRestaurantSchema,
  createSupplementSchema,
  idParam,
  adminOrderStatusSchema,
  orderStatusFilterQuery,
  updateMedicationCategorySchema,
  updateProductSchema,
  updateRestaurantSchema,
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
import type { Prisma } from '@prisma/client';

type ProductBody = {
  ingredients?: IngredientInput[];
  supplements?: SupplementInput[];
} & Record<string, unknown>;

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
    const orderCount = await prisma.order.count({ where: { restaurant_id: existing.id } });
    if (orderCount > 0) {
      await prisma.restaurant.update({ where: { id: existing.id }, data: { is_open: false } });
      throw ApiError.conflict('Commerce deja commande : fermeture a la place de la suppression', 'HAS_ORDERS');
    }
    await prisma.restaurant.delete({ where: { id: existing.id } });
    res.status(204).send();
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
    const updated = await changeOrderStatus(order, status, { actorRole: 'admin', actorUserId: req.user!.id });
    res.json(updated);
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

/* ---------------- Livreurs ---------------- */
// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
// adminRouter.get(
//   '/livreurs',
//   asyncHandler(async (_req, res) => {
//     const livreurs = await prisma.livreur.findMany({ include: livreurInclude, orderBy: { created_at: 'desc' } });
//     const activeCounts = await prisma.order.groupBy({
//       by: ['livreur_id'],
//       where: { livreur_id: { not: null }, status: { in: ['confirmed', 'preparing', 'picked_up', 'on_the_way'] } },
//       _count: { _all: true },
//     });
//     res.json(
//       livreurs.map((l) => ({
//         ...l,
//         active_orders: activeCounts.find((c) => c.livreur_id === l.id)?._count._all ?? 0,
//       })),
//     );
//   }),
// );

// adminRouter.put(
//   '/livreurs/:id',
//   validate(updateLivreurSchema),
//   asyncHandler(async (req, res) => {
//     const existing = await prisma.livreur.findUnique({ where: { user_id: req.params.id } });
//     if (!existing) throw ApiError.notFound('Livreur introuvable');
//     const body = req.validated?.body as Record<string, unknown>;
//     const livreur = await prisma.livreur.update({ where: { id: existing.id }, data: body, include: livreurInclude });
//     res.json(livreur);
//   }),
// );

// adminRouter.get(
//   '/livreurs/map',
//   asyncHandler(async (req, res) => {
//     const lat = Number(req.query.lat);
//     const lng = Number(req.query.lng);
//     const livreurs = await prisma.livreur.findMany({
//       where: { current_lat: { not: null }, current_lng: { not: null } },
//       include: { user: { select: { id: true, full_name: true, phone: true } } },
//     });
//     res.json(
//       livreurs.map((l) => ({
//         ...l,
//         distance_km:
//           Number.isFinite(lat) && Number.isFinite(lng)
//             ? roundKm(haversineKm(lat, lng, l.current_lat!, l.current_lng!))
//             : null,
//       })),
//     );
//   }),
// );
// --- FIN DÉSACTIVÉ ---
