import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { googleLoginSchema, loginSchema, refreshSchema, registerSchema } from '../schemas';
import { sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { verifyGoogleIdToken } from '../lib/google';
import { toSafeUser } from '../lib/user';
import { uploadBuffer } from '../lib/upload';

const router = Router();

/**
 * Limite les tentatives de connexion Google par IP.
 * `trust proxy` est configure dans app.ts pour que req.ip reste l'IP reelle
 * du client derriere le proxy Render.
 */
const googleRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Trop de tentatives de connexion. Reessayez dans quelques minutes.',
    },
  },
});

// Avatar optionnel en multipart (photo choisie dans l'app à l'inscription).
// Multer ignore les requêtes JSON (Content-Type non multipart), donc les
// anciens clients JSON continuent de fonctionner à l'identique.
const registerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

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
  registerUpload.single('avatar'),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, full_name, phone, role } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw ApiError.conflict('Un compte existe deja avec cet email', 'EMAIL_TAKEN');

    // Photo d'avatar optionnelle (champ "avatar" du FormData) : upload AVANT
    // la création du compte — si le stockage échoue, aucun utilisateur n'est
    // créé et l'inscription peut être relancée proprement.
    let avatar_url: string | null = null;
    if (req.file) {
      if (!req.file.mimetype.startsWith('image/')) {
        throw ApiError.badRequest('Seuls les images sont acceptees', 'INVALID_FILE_TYPE');
      }
      logger.info(
        'auth',
        `register avatar upload file=${req.file.originalname} mime=${req.file.mimetype} size=${req.file.size}B`,
      );
      avatar_url = await uploadBuffer(req.file.buffer, req.file.mimetype, 'avatars');
    }

    const user = await prisma.user.create({
      data: {
        email,
        password_hash: await bcrypt.hash(password, 10),
        full_name,
        phone: phone ?? null,
        role: role ?? 'client',
        avatar_url,
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
    // Compte cree via Google : aucun mot de passe local a comparer.
    if (!user.password_hash) {
      throw ApiError.unauthorized(
        'Ce compte a ete cree avec Google. Utilisez « Continuer avec Google ».',
        'GOOGLE_ACCOUNT',
      );
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw ApiError.unauthorized('Email ou mot de passe incorrect', 'INVALID_CREDENTIALS');

    if (user.role === 'livreur') {
      await prisma.livreur.upsert({ where: { user_id: user.id }, update: {}, create: { user_id: user.id } });
    }

    const tokens = await issueTokens(user.id, user.role);
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

/**
 * Connexion Google native : l'app envoie l'ID token obtenu par
 * `GoogleSignin.signIn()`. Le backend verifie le token aupres de Google,
 * retrouve/cree le compte puis emet NOS tokens (meme helper que /login).
 *
 * Regles : 400 (idToken manquant, via Zod), 401 (token invalide / email absent
 * ou non verifie). Aucun token n'est journalise.
 */
router.post(
  '/google',
  googleRateLimit,
  validate(googleLoginSchema),
  asyncHandler(async (req, res) => {
    const { idToken } = req.body as { idToken: string };

    let payload;
    try {
      payload = await verifyGoogleIdToken(idToken);
    } catch {
      // Ne JAMAIS logguer l'idToken ni le message brut de verification
      // (il peut contenir un fragment du jeton).
      logger.warn('auth', 'google token verification failed');
      throw ApiError.unauthorized('Connexion Google invalide ou expiree', 'INVALID_GOOGLE_TOKEN');
    }

    if (!payload?.sub) {
      throw ApiError.unauthorized('Jeton Google incomplet', 'INVALID_GOOGLE_TOKEN');
    }
    const email = payload.email?.trim().toLowerCase();
    if (!email) {
      throw ApiError.unauthorized('Aucun email associe au compte Google', 'INVALID_GOOGLE_TOKEN');
    }
    if (payload.email_verified !== true) {
      throw ApiError.unauthorized('Email Google non verifie', 'INVALID_GOOGLE_TOKEN');
    }

    let user = await prisma.user.findUnique({ where: { google_id: payload.sub } });
    let outcome: 'existing' | 'linked' | 'created' = 'existing';

    if (!user) {
      // Compte local existant avec le meme email : on lie Google sans toucher
      // au mot de passe ni a auth_provider (les deux modes restent possibles).
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail) {
        if (byEmail.google_id && byEmail.google_id !== payload.sub) {
          // L'email est deja lie a un AUTRE compte Google : ne jamais ecraser
          // ce lien silencieusement.
          throw ApiError.conflict(
            'Cet email est deja associe a un autre compte Google',
            'GOOGLE_ACCOUNT_LINKED',
          );
        }
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { google_id: payload.sub },
        });
        outcome = 'linked';
      } else {
        user = await prisma.user.create({
          data: {
            email,
            password_hash: null,
            full_name: (payload.name ?? '').trim() || email.split('@')[0],
            role: 'client',
            avatar_url: payload.picture ?? null,
            google_id: payload.sub,
            auth_provider: 'google',
          },
        });
        outcome = 'created';
      }
    }

    logger.info('auth', `google sign-in ${outcome} user=${user.id}`);

    // Meme contrat que /login : access + refresh JWT + user safe.
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
