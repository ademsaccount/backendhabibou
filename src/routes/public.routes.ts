import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createAddressSchema,
  idParam,
  productsQuery,
  restaurantDetailQuery,
  restaurantsQuery,
  updateAddressSchema,
} from '../schemas';
import { haversineKm, roundKm } from '../lib/geo';
import { loadShopExtras, productCatalogInclude, withCatalogs } from '../lib/catalog';
import { isOpenNow } from '../lib/open';
import { specialitiesFor } from '../lib/specialities';
import type { Prisma } from '@prisma/client';

export const publicRouter = Router();

/** Produit + restaurant résumé (listes des flux Repas / Épicerie / Pharmacie). */
const productListInclude: Prisma.ProductInclude = {
  restaurant: {
    select: {
      id: true,
      name: true,
      is_open: true,
      category: true,
      opening_hours: true,
      temp_closed_until: true,
    },
  },
};

/** Recalcule l'is_open "effectif" (horaires + fermeture temporaire) d'un produit. */
function withOpenRestaurant<T extends { restaurant?: { is_open: boolean; opening_hours?: unknown; temp_closed_until?: Date | null } | null }>(
  product: T,
): T {
  if (!product.restaurant) return product;
  return { ...product, restaurant: { ...product.restaurant, is_open: isOpenNow(product.restaurant) } };
}

/** Sélection allégée d'un produit pour GET /restaurants/:id?include_products='menu' :
 * assez pour l'écran menu client (nom, image, prix, catégorie… + `sizes` pour
 * l'indice « à partir de ») — rien d'autre (pas d'ingredients/supplements/
 * sauces/salades/options), jamais les garnitures du commerce. */
const menuProductSelect: Prisma.ProductSelect = {
  id: true,
  restaurant_id: true,
  name: true,
  flavor: true,
  description: true,
  image_url: true,
  price: true,
  category: true,
  dish_type: true,
  is_available: true,
  sizes: true,
};

/** Ordre commun des produits (détail full et menu). */
const productMenuOrderBy = [
  { category: 'asc' },
  { name: 'asc' },
] satisfies Prisma.ProductOrderByWithRelationInput[];

publicRouter.get(
  '/restaurants',
  validate({ query: restaurantsQuery }),
  asyncHandler(async (req, res) => {
    const { lat, lng, category, q } = req.validated?.query as {
      lat?: number;
      lng?: number;
      category?: string;
      q?: string;
    };

    const restaurants = await prisma.restaurant.findMany({
      where: {
        ...(category ? { category: category as never } : {}),
        // Recherche : nom OU description (insensible casse/accents non requis ici,
        // contains insensitive comme avant sur les deux champs).
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    // Spécialités de TOUS les commerces renvoyés : UNE seule requête groupBy
    // (restaurant_id x dish_type des produits disponibles), puis mapping JS.
    const ids = restaurants.map((r) => r.id);
    const grouped =
      ids.length > 0
        ? await prisma.product.groupBy({
            by: ['restaurant_id', 'dish_type'],
            where: { restaurant_id: { in: ids }, is_available: true, dish_type: { not: null } },
          })
        : [];
    const dishTypesByRestaurant = new Map<string, (string | null)[]>();
    for (const row of grouped) {
      const list = dishTypesByRestaurant.get(row.restaurant_id);
      if (list) list.push(row.dish_type);
      else dishTypesByRestaurant.set(row.restaurant_id, [row.dish_type]);
    }

    const result = restaurants.map((r) => ({
      ...r,
      is_open: isOpenNow(r),
      distance_km:
        lat != null && lng != null ? roundKm(haversineKm(lat, lng, r.latitude, r.longitude)) : null,
      specialities: specialitiesFor(dishTypesByRestaurant.get(r.id) ?? []),
    }));

    // Ouverts d'abord, puis par distance croissante (les fermetures passent en fin de liste).
    result.sort((a, b) => {
      if (a.is_open !== b.is_open) return a.is_open ? -1 : 1;
      if (lat == null || lng == null) return 0;
      return (a.distance_km ?? 0) - (b.distance_km ?? 0);
    });

    res.json(result);
  }),
);

publicRouter.get(
  '/restaurants/:id',
  validate({ params: idParam, query: restaurantDetailQuery }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { include_products } = (req.validated?.query ?? {}) as {
      include_products?: 'full' | 'menu' | 'none';
    };
    const mode = include_products ?? 'full';

    // 'none' : colonnes du commerce uniquement, is_open recalculé comme
    // partout, products vide — aucune requête produits/garnitures.
    if (mode === 'none') {
      const restaurant = await prisma.restaurant.findUnique({ where: { id } });
      if (!restaurant) throw ApiError.notFound('Commerce introuvable');
      res.json({ ...restaurant, is_open: isOpenNow(restaurant), products: [] });
      return;
    }

    // 'menu' : produits allégés (disponibles ET indisponibles, comme 'full'),
    // sans ingredients/supplements/options ni garnitures du commerce.
    if (mode === 'menu') {
      const restaurant = await prisma.restaurant.findUnique({
        where: { id },
        include: {
          products: {
            select: menuProductSelect,
            orderBy: productMenuOrderBy,
          },
        },
      });
      if (!restaurant) throw ApiError.notFound('Commerce introuvable');
      res.json({ ...restaurant, is_open: isOpenNow(restaurant), products: restaurant.products });
      return;
    }

    // 'full' (défaut) : comportement historique exact.
    const restaurant = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        products: {
          where: {},
          include: productCatalogInclude,
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');
    // Garnitures du commerce : 1 double requête (pas de N+1 sur les produits).
    const extrasMap = await loadShopExtras(prisma, [restaurant.id]);
    res.json({
      ...restaurant,
      is_open: isOpenNow(restaurant),
      products: restaurant.products.map((p) => withCatalogs(p, extrasMap.get(p.restaurant_id))),
    });
  }),
);

/* ------------- Stories d'offres (vitrine Instagram) ------------- */

publicRouter.get(
  '/stories',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const stories = await prisma.story.findMany({
      where: {
        is_active: true,
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      },
      include: {
        restaurant: { select: { id: true, name: true, logo_url: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(stories);
  }),
);

/* ------------- Flux Repas → "Par type de plat" (transverse aux commerces) ------------- */

publicRouter.get(
  '/dish-types',
  asyncHandler(async (_req, res) => {
    const grouped = await prisma.product.groupBy({
      by: ['dish_type'],
      where: { dish_type: { not: null }, is_available: true },
      _count: { _all: true },
    });

    const dishTypes = grouped
      .filter((g): g is typeof g & { dish_type: string } => Boolean(g.dish_type))
      .map((g) => ({ dish_type: g.dish_type, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.dish_type.localeCompare(b.dish_type, 'fr'));

    res.json(dishTypes);
  }),
);

/* --------------------- Catalogue produits (listes transverses) --------------------- */

publicRouter.get(
  '/products',
  validate({ query: productsQuery }),
  asyncHandler(async (req, res) => {
    const q = req.validated?.query as {
      dish_type?: string;
      flow?: 'epicerie' | 'pharmacie';
      category?: string;
      medication_category_id?: string;
      restaurant_id?: string;
      q?: string;
    };

    const where: Prisma.ProductWhereInput = { is_available: true };
    if (q.dish_type) where.dish_type = q.dish_type;
    if (q.restaurant_id) where.restaurant_id = q.restaurant_id;
    if (q.medication_category_id) where.medication_category_id = q.medication_category_id;
    if (q.flow) where.restaurant = { category: q.flow };
    // Épicerie : chips de catégories (match insensible à la casse).
    if (q.category) where.category = { equals: q.category, mode: 'insensitive' };
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
      ];
    }

    const products = await prisma.product.findMany({
      where,
      include: productListInclude,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 300,
    });
    // Garnitures shop pour les sauces/merges : 1 double requête pour tous les commerces.
    const extrasMap = await loadShopExtras(prisma, products.map((p) => p.restaurant_id));
    res.json(products.map((p) => withCatalogs(withOpenRestaurant(p), extrasMap.get(p.restaurant_id))));
  }),
);

/* --------------------- Flux Pharmacie → catégories de médicaments --------------------- */

publicRouter.get(
  '/medication-categories',
  asyncHandler(async (_req, res) => {
    const categories = await prisma.medicationCategory.findMany({
      where: { is_active: true },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    res.json(categories);
  }),
);

/* --------------------- Flux Épicerie → catégories produits (chips client) --------------------- */

publicRouter.get(
  '/grocery-categories',
  asyncHandler(async (_req, res) => {
    // Une seule requête groupBy : catégories distinctes des produits disponibles
    // des commerces de catégorie épicerie (additif : les vieux clients l'ignorent).
    const grouped = await prisma.product.groupBy({
      by: ['category'],
      where: { is_available: true, restaurant: { category: 'epicerie' } },
      _count: { _all: true },
    });
    const categories = grouped
      .map((g) => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => a.category.localeCompare(b.category, 'fr'));
    res.json(categories);
  }),
);

publicRouter.get(
  '/products/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            is_open: true,
            opening_hours: true,
            temp_closed_until: true,
          },
        },
        ...productCatalogInclude,
      },
    });
    if (!product) throw ApiError.notFound('Produit introuvable');
    const extrasMap = await loadShopExtras(prisma, [product.restaurant_id]);
    res.json(withCatalogs(withOpenRestaurant(product), extrasMap.get(product.restaurant_id)));
  }),
);

export const addressRouter = Router();
addressRouter.use(requireAuth);

// REST JSON = "type", colonne Prisma = address_type.
type AddressRow = { address_type: string; street_name: string | null } & Record<string, unknown>;
const addressJson = (row: AddressRow) => {
  const { address_type, ...rest } = row;
  return { ...rest, type: address_type ?? 'other' };
};

addressRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const addresses = await prisma.address.findMany({
      where: { user_id: req.user!.id },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
    res.json((addresses as unknown as AddressRow[]).map(addressJson));
  }),
);

addressRouter.post(
  '/',
  validate(createAddressSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const body = req.validated?.body as {
      label: string;
      type?: string;
      latitude: number;
      longitude: number;
      address_text: string;
      street_name?: string;
      geocode?: Record<string, string>;
      is_default?: boolean;
    };
    // REST JSON = "type", colonne Prisma = address_type.
    const { label, type, latitude, longitude, address_text, street_name, geocode, is_default } = body;
    const count = await prisma.address.count({ where: { user_id: userId } });
    const makeDefault = is_default || count === 0;

    const address = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({ where: { user_id: userId }, data: { is_default: false } });
      }
      return tx.address.create({
        data: {
          label,
          address_type: type ?? 'other',
          latitude,
          longitude,
          address_text,
          street_name,
          geocode,
          is_default: makeDefault,
          user_id: userId,
        },
      });
    });
    res.status(201).json(addressJson(address as unknown as AddressRow));
  }),
);

addressRouter.put(
  '/:id',
  validate(updateAddressSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.user_id !== userId) throw ApiError.notFound('Adresse introuvable');

    const body = req.validated?.body as Record<string, unknown> | undefined;
    // REST JSON = "type", colonne Prisma = address_type.
    const { type, ...bodyRest } = body ?? {};
    const data: Record<string, unknown> = { ...bodyRest };
    if (typeof type === 'string') data.address_type = type;
    const address = await prisma.$transaction(async (tx) => {
      if (data.is_default) {
        await tx.address.updateMany({ where: { user_id: userId }, data: { is_default: false } });
      }
      return tx.address.update({ where: { id: existing.id }, data });
    });
    res.json(addressJson(address as unknown as AddressRow));
  }),
);

addressRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.user_id !== userId) throw ApiError.notFound('Adresse introuvable');

    const [orderCount, crCount] = await Promise.all([
      prisma.order.count({ where: { address_id: existing.id } }),
      prisma.customRequest.count({ where: { address_id: existing.id } }),
    ]);
    if (orderCount > 0 || crCount > 0) {
      throw ApiError.conflict('Adresse utilisee par des commandes / demandes', 'ADDRESS_IN_USE');
    }

    await prisma.address.delete({ where: { id: existing.id } });
    res.status(204).send();
  }),
);
