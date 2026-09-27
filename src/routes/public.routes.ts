import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createAddressSchema,
  idParam,
  productsQuery,
  restaurantsQuery,
  updateAddressSchema,
} from '../schemas';
import { haversineKm, roundKm } from '../lib/geo';
import { productCatalogInclude, withCatalogs } from '../lib/catalog';
import { env } from '../config/env';
import type { Prisma } from '@prisma/client';

export const publicRouter = Router();

/** Produit + restaurant résumé (listes des flux Repas / Épicerie / Pharmacie). */
const productListInclude: Prisma.ProductInclude = {
  restaurant: { select: { id: true, name: true, is_open: true, category: true } },
};

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
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    let result = restaurants.map((r) => ({
      ...r,
      distance_km:
        lat != null && lng != null ? roundKm(haversineKm(lat, lng, r.latitude, r.longitude)) : null,
    }));

    if (lat != null && lng != null) {
      result = result.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
      // Rayon de proximite : on le garde comme priorite, mais jamais au prix d'une liste
      // vide (utilisateur hors zone => on renvoie tous les commerces tries par distance).
      const nearby = result.filter((r) => r.distance_km != null && r.distance_km <= env.NEARBY_RADIUS_KM);
      if (nearby.length > 0) result = nearby;
    }

    res.json(result);
  }),
);

publicRouter.get(
  '/restaurants/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const restaurant = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        products: {
          where: {},
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!restaurant) throw ApiError.notFound('Commerce introuvable');
    res.json(restaurant);
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
      medication_category_id?: string;
      restaurant_id?: string;
      q?: string;
    };

    const where: Prisma.ProductWhereInput = { is_available: true };
    if (q.dish_type) where.dish_type = q.dish_type;
    if (q.restaurant_id) where.restaurant_id = q.restaurant_id;
    if (q.medication_category_id) where.medication_category_id = q.medication_category_id;
    if (q.flow) where.restaurant = { category: q.flow };
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
    res.json(products);
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

publicRouter.get(
  '/products/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        restaurant: { select: { id: true, name: true, is_open: true } },
        ...productCatalogInclude,
      },
    });
    if (!product) throw ApiError.notFound('Produit introuvable');
    res.json(withCatalogs(product));
  }),
);

export const addressRouter = Router();
addressRouter.use(requireAuth);

addressRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const addresses = await prisma.address.findMany({
      where: { user_id: req.user!.id },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
    res.json(addresses);
  }),
);

addressRouter.post(
  '/',
  validate(createAddressSchema),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const body = req.validated?.body as {
      label: string;
      latitude: number;
      longitude: number;
      address_text: string;
      is_default?: boolean;
    };
    const count = await prisma.address.count({ where: { user_id: userId } });
    const makeDefault = body.is_default || count === 0;

    const address = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({ where: { user_id: userId }, data: { is_default: false } });
      }
      return tx.address.create({
        data: { ...body, is_default: makeDefault, user_id: userId },
      });
    });
    res.status(201).json(address);
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
    const address = await prisma.$transaction(async (tx) => {
      if (body?.is_default) {
        await tx.address.updateMany({ where: { user_id: userId }, data: { is_default: false } });
      }
      return tx.address.update({ where: { id: existing.id }, data: body ?? {} });
    });
    res.json(address);
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
