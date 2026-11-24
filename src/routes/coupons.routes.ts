import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idParam } from '../schemas';

/**
 * Coupons de l'utilisateur connecte.
 * - GET /coupons/me : liste (AVAILABLE d'abord, puis plus recents).
 * - POST /coupons/:id/seen : marque le coupon comme vu (idempotent) — appele
 *   a la fermeture du modal de bienvenue.
 * Aucun coupon d'un autre utilisateur n'est jamais expose : un id etranger
 * repond NOT_FOUND (pas de fuite d'existence).
 */
export const couponRouter = Router();
couponRouter.use(requireAuth);

/** Meme forme que les autres rate-limits (lecture) : en-tetes draft-8 + code stable. */
const couponsReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de requetes, reessayez plus tard' } },
});

couponRouter.get(
  '/me',
  couponsReadRateLimit,
  asyncHandler(async (req, res) => {
    if (!req.user?.id) throw ApiError.unauthorized();
    const coupons = await prisma.coupon.findMany({
      where: { user_id: req.user.id },
      // AVAILABLE d'abord (enum : AVAILABLE < USED en ordre alphabetique, mais
      // on reste explicite via un tri applicatif stable).
      orderBy: [{ created_at: 'desc' }],
    });
    const sorted = [...coupons].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'AVAILABLE' ? -1 : 1;
      return b.created_at.getTime() - a.created_at.getTime();
    });
    res.json(sorted);
  }),
);

couponRouter.post(
  '/:id/seen',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    if (!req.user?.id) throw ApiError.unauthorized();
    const coupon = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    // Coupon d'un autre utilisateur = introuvable (jamais de donnee d'autrui).
    if (!coupon || coupon.user_id !== req.user.id) {
      throw ApiError.notFound('Coupon introuvable', 'COUPON_NOT_FOUND');
    }
    // Idempotent : ne reecrit pas une date deja posee.
    if (coupon.seen_at) return res.json(coupon);
    const updated = await prisma.coupon.update({
      where: { id: coupon.id },
      data: { seen_at: new Date() },
    });
    res.json(updated);
  }),
);
