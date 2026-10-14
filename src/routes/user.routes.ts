import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateMeSchema } from '../schemas';
import { toSafeUser } from '../lib/user';

export const userRouter = Router();
userRouter.use(requireAuth);

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
