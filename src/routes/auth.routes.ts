import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { env, isProd } from '../config/env';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '../schemas';
import { sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { verifyGoogleIdToken } from '../lib/google';
import { isMailConfigured, sendPasswordResetCode } from '../lib/mailer';
import {
  RESET_RESEND_COOLDOWN_MS,
  generateResetCode,
  hashResetCode,
  isResetCodeExpired,
  resetCodeExpiry,
  sameHash,
} from '../lib/passwordReset';
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

/**
 * Mot de passe oublie : limite les envois d'emails par IP (anti-spam) et la
 * verification des codes (anti brute-force). Le cooldown par compte est gere
 * dans le handler.
 */
const forgotPasswordRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Trop de demandes de reinitialisation. Reessayez dans quelques minutes.',
    },
  },
});

const resetPasswordRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Trop de tentatives. Reessayez dans quelques minutes.',
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

/** Remplace tout code existant : un seul code actif par utilisateur. */
async function storeResetCode(userId: string, code: string): Promise<void> {
  await prisma.$transaction([
    prisma.passwordResetCode.deleteMany({ where: { user_id: userId } }),
    prisma.passwordResetCode.create({
      data: {
        user_id: userId,
        code_hash: hashResetCode(code),
        expires_at: resetCodeExpiry(),
      },
    }),
  ]);
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

/**
 * Mot de passe oublie, etape 1 : envoi d'un code a 6 chiffres par email.
 *
 * Anti-enumeration : la reponse est TOUJOURS 200 `{ ok: true }`, que le compte
 * existe ou non (et meme pendant le cooldown). En developpement, si Brevo n'est
 * pas configure (ou echoue), le code est renvoye dans `dev_code` (jamais en
 * production, jamais journalise).
 */
router.post(
  '/forgot-password',
  forgotPasswordRateLimit,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };
    const ok = { ok: true as const };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(ok);

    // Cooldown par compte : ne pas renvoyer un code a chaque clic.
    const last = await prisma.passwordResetCode.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });
    if (last && Date.now() - last.created_at.getTime() < RESET_RESEND_COOLDOWN_MS) {
      return res.json(ok);
    }

    const code = generateResetCode();
    await storeResetCode(user.id, code);

    if (!isMailConfigured()) {
      if (isProd) {
        throw new ApiError(503, 'MAIL_UNAVAILABLE', "L'envoi d'email n'est pas configure");
      }
      logger.warn(
        'mail',
        `Brevo non configure : code de reinitialisation (dev) user=${user.id}`,
      );
      return res.json({ ...ok, dev_code: code });
    }

    try {
      await sendPasswordResetCode(user.email, code, user.locale);
    } catch (error) {
      logger.error(
        'mail',
        "echec de l'envoi du code de reinitialisation",
        error instanceof Error ? error : String(error),
      );
      if (isProd) {
        throw new ApiError(503, 'MAIL_UNAVAILABLE', "Impossible d'envoyer l'email pour le moment");
      }
      // Dev : Brevo mal configure -> on donne le code pour ne pas bloquer.
      logger.warn('mail', `fallback dev : code de reinitialisation user=${user.id}`);
      return res.json({ ...ok, dev_code: code });
    }

    return res.json(ok);
  }),
);

/**
 * Mot de passe oublie, etape 2 : verification du code + nouveau mot de passe.
 *
 * - code hashe en base, expire apres PASSWORD_RESET_TTL_MIN, 5 essais max ;
 * - toutes les sessions (refresh tokens) sont invalidees apres le reset ;
 * - un compte Google-only peut definir un mot de passe de cette facon.
 */
router.post(
  '/reset-password',
  resetPasswordRateLimit,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email, code, password } = req.body as {
      email: string;
      code: string;
      password: string;
    };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw ApiError.badRequest('Code invalide ou expire', 'INVALID_RESET_CODE');

    const record = await prisma.passwordResetCode.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });

    if (
      !record ||
      isResetCodeExpired(record.expires_at) ||
      record.attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS ||
      !sameHash(record.code_hash, hashResetCode(code))
    ) {
      if (record) {
        if (
          isResetCodeExpired(record.expires_at) ||
          record.attempts + 1 >= env.PASSWORD_RESET_MAX_ATTEMPTS
        ) {
          await prisma.passwordResetCode
            .delete({ where: { id: record.id } })
            .catch(() => undefined);
        } else {
          await prisma.passwordResetCode
            .update({ where: { id: record.id }, data: { attempts: { increment: 1 } } })
            .catch(() => undefined);
        }
      }
      throw ApiError.badRequest('Code invalide ou expire', 'INVALID_RESET_CODE');
    }

    const password_hash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password_hash } }),
      prisma.passwordResetCode.deleteMany({ where: { user_id: user.id } }),
      // Deconnexion de tous les appareils apres un changement de mot de passe.
      prisma.refreshToken.deleteMany({ where: { user_id: user.id } }),
    ]);

    logger.info('auth', `password reset user=${user.id}`);
    return res.json({ ok: true });
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
