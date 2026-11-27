import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { OrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { verifyGoogleIdToken } from '../lib/google';
import { removePublicUrl } from '../lib/upload';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { deleteAccountSchema, updateMeSchema } from '../schemas';
import { toSafeUser } from '../lib/user';

/** Categories COMMERCE considerees comme repas (stats « top meals ») :
 *  restaurant + snack. epicerie / pharmacie / tabac écartés. */
const FOOD_CATEGORIES = ['restaurant', 'snack'] as const;

export const userRouter = Router();
userRouter.use(requireAuth);

/** Statuts d'une commande encore "vivante" : la suppression est refusee. */
const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'picked_up',
  'on_the_way',
];

/**
 * Suppression de compte : operation rare et sensible -> limite par IP.
 * (En plus du JWT + de la re-authentification dans le handler.)
 */
const deleteAccountRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Trop de tentatives de suppression. Reessayez dans quelques minutes.',
    },
  },
});

/**
 * DELETE /users/me — suppression DEFINITIVE du compte (Apple 5.1.1(v)).
 *
 * Re-authentification :
 * - compte avec mot de passe local : `password` verifie par bcrypt ;
 * - compte Google SANS mot de passe : `confirmation` = "DELETE" (le JWT prouve
 *   deja la session) OU un `idToken` Google frais dont le `sub` correspond.
 *
 * Les commandes ne sont jamais supprimees : elles sont anonymisees (user_id et
 * address_id NULL, notes libres effacees). Le reste des donnees personnelles
 * est supprime dans UNE transaction. Les fichiers Storage sont supprimes
 * APRES le commit, en best effort : un echec Storage ne bloque pas la
 * suppression du compte (on le loggue).
 *
 * TODO Sign in with Apple : si ce flux est ajoute un jour, revoquer ici le
 * refresh token Apple (https://appleid.apple.com/auth/revoke) avant de
 * supprimer le compte.
 */
userRouter.delete(
  '/me',
  deleteAccountRateLimit,
  validate(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as {
      password?: string;
      confirmation?: string;
      idToken?: string;
    };
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.unauthorized('Utilisateur introuvable', 'USER_NOT_FOUND');

    // Les comptes admin ne passent pas par le flux client (ils gerent le
    // catalogue et les commandes du commerce).
    if (user.role === 'admin') {
      throw ApiError.forbidden(
        'Un compte administrateur ne peut pas etre supprime depuis l application client.',
        'ADMIN_ACCOUNT_PROTECTED',
      );
    }

    // --- Re-authentification (aucun mot de passe / jeton n'est journalise) ---
    if (user.password_hash) {
      if (!body.password) {
        throw ApiError.badRequest('Mot de passe actuel requis', 'REAUTH_REQUIRED');
      }
      const passwordOk = await bcrypt.compare(body.password, user.password_hash);
      if (!passwordOk) {
        // 400 volontairement : un 401 déclencherait le refresh automatique de
        // session côté app alors que le jeton est parfaitement valide.
        throw ApiError.badRequest('Mot de passe incorrect', 'INVALID_CREDENTIALS');
      }
    } else if (body.idToken) {
      let payload: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
      try {
        payload = await verifyGoogleIdToken(body.idToken);
      } catch {
        logger.warn('account', 'delete: google token verification failed');
        throw ApiError.badRequest('Connexion Google invalide ou expiree', 'INVALID_GOOGLE_TOKEN');
      }
      if (!payload?.sub || payload.sub !== user.google_id) {
        throw ApiError.badRequest(
          'Le compte Google ne correspond pas au compte connecte',
          'INVALID_GOOGLE_TOKEN',
        );
      }
    } else if ((body.confirmation ?? '').trim().toUpperCase() !== 'DELETE') {
      throw ApiError.badRequest('Tapez DELETE pour confirmer', 'REAUTH_REQUIRED');
    }

    // --- Suppression + anonymisation dans UNE transaction ---
    const storageUrls = await prisma.$transaction(async (tx) => {
      // Re-verification DANS la transaction : aucune commande active ne doit
      // pouvoir se glisser entre le controle et la suppression.
      const activeOrders = await tx.order.count({
        where: { user_id: user.id, status: { in: ACTIVE_ORDER_STATUSES } },
      });
      if (activeOrders > 0) {
        throw ApiError.conflict(
          "Vous avez une commande en cours. Vous pourrez supprimer votre compte une fois qu'elle sera terminee.",
          'ACTIVE_ORDER',
        );
      }

      const orders = await tx.order.findMany({
        where: { user_id: user.id },
        select: { id: true },
      });
      const orderIds = orders.map((order) => order.id);

      if (orderIds.length > 0) {
        // Detache la commande du compte et de l'adresse personnelle. Les
        // totaux, dates, articles et statuts sont conserves.
        await tx.order.updateMany({
          where: { id: { in: orderIds } },
          data: {
            user_id: null,
            address_id: null,
            coupon_id: null,
            // payment_intent_id est conserve : reference comptable du paiement,
            // sans lien direct avec l'identite du client.
          },
        });
        // Notes libres des articles (adresse / remarques du client).
        await tx.orderItem.updateMany({
          where: { order_id: { in: orderIds } },
          data: { notes: null },
        });
        // Messages / propositions de prix : tout l'historique de discussion
        // de ces commandes est efface (aucun texte personnel conserve).
        await tx.orderMessage.deleteMany({ where: { order_id: { in: orderIds } } });
      }

      // Demandes specifiques : description libre + photo = donnees personnelles.
      const customRequests = await tx.customRequest.findMany({
        where: { user_id: user.id },
        select: { photo_url: true },
      });

      await tx.customRequest.deleteMany({ where: { user_id: user.id } });
      // Les commandes ont deja coupon_id = NULL ci-dessus.
      await tx.coupon.deleteMany({ where: { user_id: user.id } });
      // Plus aucune commande / demande ne reference ces adresses.
      await tx.address.deleteMany({ where: { user_id: user.id } });

      await tx.savedCart.deleteMany({ where: { user_id: user.id } });
      await tx.notification.deleteMany({ where: { user_id: user.id } });
      await tx.cart.deleteMany({ where: { user_id: user.id } });
      await tx.review.deleteMany({ where: { user_id: user.id } });
      await tx.refreshToken.deleteMany({ where: { user_id: user.id } });
      await tx.passwordResetCode.deleteMany({ where: { user_id: user.id } });
      await tx.emailVerificationCode.deleteMany({ where: { user_id: user.id } });
      await tx.livreur.deleteMany({ where: { user_id: user.id } });

      // Hard-delete du compte : les relations restantes sont en CASCADE.
      await tx.user.delete({ where: { id: user.id } });

      return [user.avatar_url, ...customRequests.map((request) => request.photo_url)].filter(
        (url): url is string => Boolean(url),
      );
    }, { timeout: 20_000 });

    // --- Storage : best effort APRES le commit (ne bloque jamais la suppression) ---
    for (const url of storageUrls) {
      try {
        await removePublicUrl(url);
      } catch (error) {
        logger.error(
          'account',
          `suppression Storage impossible apres suppression du compte user=${user.id}`,
          error instanceof Error ? error : String(error),
        );
      }
    }

    logger.info('account', `compte supprime user=${user.id}`);
    res.json({ success: true });
  }),
);

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
