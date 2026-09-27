import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { loginSchema, refreshSchema, registerSchema } from '../schemas';
import { sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { toSafeUser } from '../lib/user';

const router = Router();

async function issueTokens(userId: string, role: 'client' | 'admin' | 'livreur') {
  const access = signAccessToken({ id: userId, role });
  const refresh = signRefreshToken({ id: userId, role });
  await prisma.refreshToken.create({
    data: {
      user_id: userId,
      token_hash: sha256(refresh),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return { access_token: access, refresh_token: refresh };
}

router.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, full_name, phone, role } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw ApiError.conflict('Un compte existe deja avec cet email', 'EMAIL_TAKEN');

    const user = await prisma.user.create({
      data: {
        email,
        password_hash: await bcrypt.hash(password, 10),
        full_name,
        phone: phone ?? null,
        role: role ?? 'client',
        // --- DÉSACTIVÉ : plus de compte livreur (l'admin fait office de livreur unique) ---
        // ...(role === 'livreur' ? { livreur: { create: {} } } : {}),
        // --- FIN DÉSACTIVÉ ---
      },
    });

    const tokens = await issueTokens(user.id, user.role);
    res.status(201).json({ ...tokens, user: toSafeUser(user) });
  }),
);

router.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw ApiError.unauthorized('Email ou mot de passe incorrect', 'INVALID_CREDENTIALS');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw ApiError.unauthorized('Email ou mot de passe incorrect', 'INVALID_CREDENTIALS');

    // --- DÉSACTIVÉ : plus de compte livreur (l'admin fait office de livreur unique) ---
    // if (user.role === 'livreur') {
    //   await prisma.livreur.upsert({ where: { user_id: user.id }, update: {}, create: { user_id: user.id } });
    // }
    // --- FIN DÉSACTIVÉ ---
    if (user.role === 'livreur') {
      throw ApiError.forbidden('Les comptes livreur ont ete desactivez. Utilisez le compte admin.', 'ROLE_DISABLED');
    }

    const tokens = await issueTokens(user.id, user.role);
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

router.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;
    const payload = verifyRefreshToken(refresh_token);
    const hash = sha256(refresh_token);
    const stored = await prisma.refreshToken.findUnique({ where: { token_hash: hash } });
    if (!stored || stored.expires_at < new Date()) {
      throw ApiError.unauthorized('Refresh token expire', 'REFRESH_EXPIRED');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw ApiError.unauthorized('Utilisateur introuvable', 'USER_NOT_FOUND');

    // Rotation : l'ancien refresh est consomme
    await prisma.refreshToken.delete({ where: { token_hash: hash } }).catch(() => undefined);
    const tokens = await issueTokens(user.id, user.role);
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  }),
);

export default router;
