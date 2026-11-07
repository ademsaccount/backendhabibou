import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateMeSchema } from '../schemas';
import { toSafeUser } from '../lib/user';

/** Categories COMMERCE considerees comme repas (stats « top meals ») :
 *  restaurant + snack. epicerie / pharmacie / tabac écartés. */
const FOOD_CATEGORIES = ['restaurant', 'snack'] as const;

export const userRouter = Router();
userRouter.use(requireAuth);

/**
 * Stat « Top 2 repas » du profil : les 2 produits les plus commandés par ce
 * client, classés par QUANTITE totale ligne (sizes confondues) et uniquement
 * parmi les commandes DELIVERED de produits « repas » (pas epicerie/pharmacie/tabac).
 */
userRouter.get(
  '/me/top-meals',
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const grouped = await prisma.orderItem.groupBy({
      by: ['product_id'],
      where: {
        order: { user_id: req.user!.id, status: 'delivered' },
        product: {
          medication_category_id: null,
          restaurant: { category: { in: [...FOOD_CATEGORIES] } },
        },
      },
      _sum: { quantity: true },
      orderBy: [{ _sum: { quantity: 'desc' } }, { product_id: 'asc' }],
      take: 2,
    });
    if (grouped.length === 0) {
      res.json({ meals: [] });
      return;
    }
    // Rang conservé : group by → hydratation via un Map (l'ordre findMany in est libre).
    const sumByProduct = new Map(grouped.map((row) => [row.product_id, row._sum.quantity ?? 0]));
    const products = await prisma.product.findMany({
      where: { id: { in: grouped.map((row) => row.product_id) } },
      select: {
        id: true,
        name: true,
        flavor: true,
        image_url: true,
        restaurant: { select: { id: true, name: true, logo_url: true } },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    res.json({
      meals: grouped
        .map((row) => {
          const product = byId.get(row.product_id);
          if (!product) return null;
          return {
            ...product,
            times: sumByProduct.get(row.product_id) ?? 0,
          };
        })
        .filter((meal): meal is NonNullable<typeof meal> => !!meal),
    });
  }),
);

/** Profil : nom / téléphone / avatar du compte connecté (tous rôles). */
userRouter.put(
  '/me',
  validate(updateMeSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      full_name?: string;
      phone?: string | null;
      avatar_url?: string | null;
      vehicle_type?: string;
    };
    if (
      body.full_name === undefined &&
      body.phone === undefined &&
      body.avatar_url === undefined &&
      body.vehicle_type === undefined
    ) {
      res.json(req.user);
      return;
    }
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: req.user!.id },
        data: {
          ...(body.full_name !== undefined ? { full_name: body.full_name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.avatar_url !== undefined ? { avatar_url: body.avatar_url } : {}),
        },
      });
      // Véhicule : seulement pour les livreurs (le rôle admin garde ses propres routes).
      if (body.vehicle_type !== undefined && user.role === 'livreur') {
        await tx.livreur.upsert({
          where: { user_id: user.id },
          update: { vehicle_type: body.vehicle_type },
          create: { user_id: user.id, vehicle_type: body.vehicle_type },
        });
      }
      return user;
    });
    res.json(toSafeUser(updated));
  }),
);
