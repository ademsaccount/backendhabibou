import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { pushTokenSchema } from '../schemas';

/**
 * Appareils / jetons de notification push.
 * POST /devices/push-token — enregistre (ou retire avec null) le jeton Expo
 * de l'utilisateur connecte (utilise par sudo_habichou pour l'alerte entrante).
 */
export const deviceRouter = Router();
deviceRouter.use(requireAuth);

deviceRouter.post(
  '/push-token',
  validate(pushTokenSchema),
  asyncHandler(async (req, res) => {
    const { push_token } = req.validated?.body as { push_token: string | null };
    if (!req.user?.id) throw ApiError.unauthorized();
    await prisma.user.update({
      where: { id: req.user.id },
      data: { expo_push_token: push_token },
    });
    logger.info('push', `jeton ${push_token ? 'enregistre' : 'retire'} user=${req.user.id}`);
    res.json({ ok: true, registered: Boolean(push_token) });
  }),
);
