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
  appleLoginSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../schemas';
import { sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { verifyGoogleIdToken } from '../lib/google';
import { exchangeAppleAuthorizationCode, verifyAppleIdentityToken } from '../lib/apple';
import { isMailConfigured, sendEmailVerificationCode, sendPasswordResetCode } from '../lib/mailer';
import {
  RESEND_COOLDOWN_MS,
  generateCode,
  hashResetCode,
  hashVerificationCode,
  resetCodeExpiry,
  verifyStoredCode,
  verificationCodeExpiry,
} from '../lib/passwordReset';
import { toSafeUser } from '../lib/user';
import { sendWelcomeCouponNotification } from '../lib/coupons';
import { grantWelcomeCouponWithClaim, welcomeClaimIdentifiersFromUser } from '../lib/welcomeClaim';
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

/** Meme limite que Google pour la connexion Apple (iOS). */
const appleRateLimit = rateLimit({
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

/** Verification d'email : limite les essais de code par IP (anti brute-force). */
const verifyEmailRateLimit = rateLimit({
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

/** Renvoi d'un code de verification : limite les envois d'emails par IP. */
const resendVerificationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Trop de demandes de verification. Reessayez dans quelques minutes.',
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

/** Un seul code de verification actif : purge aussi les codes consommes. */
async function storeVerificationCode(userId: string, code: string): Promise<void> {
  await prisma.$transaction([
    prisma.emailVerificationCode.deleteMany({ where: { user_id: userId } }),
    prisma.emailVerificationCode.create({
      data: {
        user_id: userId,
        code_hash: hashVerificationCode(code),
        expires_at: verificationCodeExpiry(),
      },
    }),
  ]);
}

type SendVerificationResult =
  | { status: 'sent'; dev_code?: string }
  | { status: 'throttled' }
  | { status: 'failed' };

/**
 * Genere, stocke et envoie un code de verification d'email.
 *
 * - cooldown par compte (RESEND_COOLDOWN_MS) si `respectCooldown` ;
 * - un seul code actif : les anciens (y compris consommes) sont supprimes ;
 * - dev sans Mailjet : le code est retourne comme `dev_code` (jamais en prod) ;
 * - echec d'envoi : le code inutilisable est supprime (pour ne pas bloquer le
 *   prochain envoi par le cooldown) et `failed` est retourne — l'appelant
 *   decide (503 sur /register, 200 silencieux sur /resend-verification,
 *   best effort sur /login). Ne leve jamais.
 *
 * Le code en clair n'est jamais journalise.
 */
async function sendVerificationCode(
  user: { id: string; email: string | null; locale: string | null },
  respectCooldown = true,
): Promise<SendVerificationResult> {
  // Un compte Apple sans email ne passe jamais par la verification d'email.
  if (!user.email) return { status: 'failed' };

  if (respectCooldown) {
    const last = await prisma.emailVerificationCode.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });
    if (last && Date.now() - last.created_at.getTime() < RESEND_COOLDOWN_MS) {
      return { status: 'throttled' };
    }
  }

  const code = generateCode();

  if (!isMailConfigured()) {
    if (isProd) {
      logger.warn('mail', 'Mailjet non configure (prod) : code de verification non envoye');
      return { status: 'failed' };
    }
    await storeVerificationCode(user.id, code);
    logger.warn('mail', `Mailjet non configure : code de verification (dev) user=${user.id}`);
    return { status: 'sent', dev_code: code };
  }

  await storeVerificationCode(user.id, code);
  try {
    await sendEmailVerificationCode(user.email, code, user.locale);
    return { status: 'sent' };
  } catch (error) {
    logger.error(
      'mail',
      "echec de l'envoi du code de verification",
      error instanceof Error ? error : String(error),
    );
    if (isProd) {
      await prisma.emailVerificationCode
        .deleteMany({ where: { user_id: user.id } })
        .catch(() => undefined);
      return { status: 'failed' };
    }
    // Dev : Mailjet mal configure -> on donne le code pour ne pas bloquer.
    return { status: 'sent', dev_code: code };
  }
}

router.post(
  '/register',
  registerUpload.single('avatar'),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, full_name, phone, role } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });

    // Deja verifie : 409 historique, aucune autre information ne fuit.
    if (existing?.email_verified_at) {
      throw ApiError.conflict('Un compte existe deja avec cet email', 'EMAIL_TAKEN');
    }

    // Inscription abandonnee (compte non verifie) : on reprend le compte avec
    // les nouvelles donnees et on renvoie exactement comme un nouveau signup.
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          full_name,
          password_hash: await bcrypt.hash(password, 10),
        },
      });
      const send = await sendVerificationCode(existing);
      if (send.status === 'failed') {
        // L'utilisateur est conserve (non verifie) : l'app pourra proposer
        // un renvoi via /auth/resend-verification.
        throw new ApiError(503, 'MAIL_UNAVAILABLE', "Impossible d'envoyer l'email pour le moment");
      }
      res.status(201).json({
        needs_verification: true,
        email,
        ...(send.status === 'sent' && send.dev_code ? { dev_code: send.dev_code } : {}),
      });
      return;
    }

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
        // Non verifie tant que le code n'a pas ete valide.
        email_verified_at: null,
        // --- DÉSACTIVÉ : plus de compte livreur (l'admin fait office de livreur unique) ---
        // ...(role === 'livreur' ? { livreur: { create: {} } } : {}),
        // --- FIN DÉSACTIVÉ ---
      },
    });

    const send = await sendVerificationCode(user);
    if (send.status === 'failed') {
      // L'utilisateur est conserve (non verifie) : pas de token, l'app
      // pourra proposer un renvoi via /auth/resend-verification.
      throw new ApiError(503, 'MAIL_UNAVAILABLE', "Impossible d'envoyer l'email pour le moment");
    }

    // Pas de token ici : le compte devient utilisable apres /auth/verify-email.
    res.status(201).json({
      needs_verification: true,
      email,
      ...(send.status === 'sent' && send.dev_code ? { dev_code: send.dev_code } : {}),
    });
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

    // Email non verifie : aucun token. Le mot de passe est deja controle, ce
    // 403 ne revele donc pas l'existence du compte a un inconnu. On tente un
    // envoi (cooldown permet) pour que l'app bascule sur l'ecran de code.
    if (!user.email_verified_at) {
      const send = await sendVerificationCode(user).catch(() => ({ status: 'failed' as const }));
      throw new ApiError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Veuillez verifier votre email avant de vous connecter',
        // Uniquement en dev sans Mailjet : sert de fallback `dev_code` a l'app.
        send.status === 'sent' && send.dev_code ? { dev_code: send.dev_code } : undefined,
      );
    }

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
    // Vrai si le compte devient verifie dans CE appel (nouveau ou relicte) :
    // c'est le seul moment ou le coupon de bienvenue est accorde.
    let justVerified = false;

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
        justVerified = !byEmail.email_verified_at;
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: {
            google_id: payload.sub,
            // Le compte prouve la possession de l'email via Google : on le
            // marque verifie s'il ne l'etait pas (inscription locale inachevee).
            ...(byEmail.email_verified_at ? {} : { email_verified_at: new Date() }),
          },
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
            // Google a confirme email_verified === true (controle ci-dessus).
            email_verified_at: new Date(),
          },
        });
        outcome = 'created';
        justVerified = true;
      }
    }

    // Compte Google cree avant la colonne : on le verifie maintenant.
    if (!user.email_verified_at) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { email_verified_at: new Date() },
      });
      justVerified = true;
    }

    logger.info('auth', `google sign-in ${outcome} user=${user.id}`);

    // Coupon de bienvenue : accorde a la premiere verification du compte,
    // SAUF si un identifiant de ce compte (email / telephone / sub) a deja
    // reclame le coupon — y compris via un compte depuis SUPPRIME (anti-abus).
    // Jamais jetant, ne retarde pas la reponse d'authentification.
    if (justVerified) {
      const granted = await grantWelcomeCouponWithClaim(
        user.id,
        welcomeClaimIdentifiersFromUser(user),
      );
      if (granted) void sendWelcomeCouponNotification(user.id);
    }

    // Meme contrat que /login : access + refresh JWT + user safe.
    const tokens = await issueTokens(user.id, user.role);
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

/**
 * Connexion Apple native (iOS uniquement) : l'app envoie le jeton d'identite
 * obtenu par `AppleAuthentication.signInAsync()`, le nonce brut et le code
 * d'autorisation. Le backend verifie le jeton, retrouve/cree le compte par
 * `apple_id` (jamais par l'email comme cle primaire) puis emet NOS tokens.
 *
 * Regles : 400 (champs manquants, via Zod), 401 (jeton invalide / nonce),
 * 409 (email deja lie a un autre compte Apple). Aucun jeton n'est journalise.
 */
router.post(
  '/apple',
  appleRateLimit,
  validate(appleLoginSchema),
  asyncHandler(async (req, res) => {
    const {
      identityToken,
      authorizationCode,
      rawNonce,
      fullName,
      email: clientEmail,
    } = req.body as {
      identityToken: string;
      authorizationCode?: string;
      rawNonce: string;
      fullName?: string;
      email?: string;
    };

    let payload;
    try {
      payload = await verifyAppleIdentityToken(identityToken, rawNonce);
    } catch {
      // Ne jamais journaliser le jeton ni le message brut de verification.
      logger.warn('auth', 'apple token verification failed');
      throw ApiError.unauthorized('Connexion Apple invalide ou expiree', 'INVALID_APPLE_TOKEN');
    }

    if (!payload.sub) {
      throw ApiError.unauthorized('Jeton Apple incomplet', 'INVALID_APPLE_TOKEN');
    }

    // Email prouve par Apple. Il peut etre absent (utilisateur qui masque son
    // email) ou etre une adresse relais privee. L'email envoye par le client
    // n'est utilise qu'en secours et ne sert JAMAIS a lier un compte existant.
    const verifiedEmail = payload.email?.trim().toLowerCase();
    const email = verifiedEmail ?? clientEmail?.trim().toLowerCase();

    const appleName = (fullName ?? '').trim();
    const fallbackName =
      appleName ||
      (email && !email.endsWith('@privaterelay.appleid.com') ? email.split('@')[0] : '') ||
      'Client Habichou';

    let user = await prisma.user.findUnique({ where: { apple_id: payload.sub } });
    let outcome: 'existing' | 'linked' | 'created' = 'existing';
    let justVerified = false;

    if (!user && verifiedEmail) {
      // Compte local existant avec le meme email VERIFIE par Apple : on lie
      // Apple sans toucher au mot de passe ni a auth_provider.
      const byEmail = await prisma.user.findUnique({ where: { email: verifiedEmail } });
      if (byEmail) {
        if (byEmail.apple_id && byEmail.apple_id !== payload.sub) {
          throw ApiError.conflict(
            'Cet email est deja associe a un autre compte Apple',
            'APPLE_ACCOUNT_LINKED',
          );
        }
        justVerified = !byEmail.email_verified_at;
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: {
            apple_id: payload.sub,
            ...(byEmail.email_verified_at ? {} : { email_verified_at: new Date() }),
          },
        });
        outcome = 'linked';
      }
    }

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: email ?? null,
          password_hash: null,
          // Le nom n'est fourni qu'a la premiere autorisation : sans lui, un
          // placeholder editable est affiche dans le profil.
          full_name: fallbackName,
          role: 'client',
          apple_id: payload.sub,
          auth_provider: 'apple',
          // Apple a delivre un jeton signe : le compte est verifie meme sans
          // email (l'app ne depend pas de l'email pour s'authentifier).
          email_verified_at: new Date(),
        },
      });
      outcome = 'created';
      justVerified = true;
    }

    // Compte Apple cree avant la colonne / compte non verifie : on le verifie.
    if (!user.email_verified_at) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { email_verified_at: new Date() },
      });
      justVerified = true;
    }

    // Refresh token Apple : necessaire uniquement pour revoquer l'acces lors de
    // la suppression du compte. Best effort (ne bloque jamais la connexion).
    if (authorizationCode) {
      const appleRefreshToken = await exchangeAppleAuthorizationCode(authorizationCode);
      if (appleRefreshToken) {
        await prisma.user.update({
          where: { id: user.id },
          data: { apple_refresh_token: appleRefreshToken },
        });
      }
    }

    logger.info('auth', `apple sign-in ${outcome} user=${user.id}`);

    // Coupon de bienvenue : accorde a la premiere verification du compte,
    // sauf si un identifiant du compte a deja reclame le coupon (anti-abus).
    if (justVerified) {
      const granted = await grantWelcomeCouponWithClaim(
        user.id,
        welcomeClaimIdentifiersFromUser(user),
      );
      if (granted) void sendWelcomeCouponNotification(user.id);
    }

    const tokens = await issueTokens(user.id, user.role);
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

/**
 * Verification de l'email, etape 2 : validation du code + connexion.
 *
 * - code hashe en base, expire apres EMAIL_VERIFICATION_TTL_MIN, essais max ;
 * - usage unique (consumed_at) : un code deja valide ne peut plus servir ;
 * - reponse identique a /login pour connecter l'app directement.
 */
router.post(
  '/verify-email',
  verifyEmailRateLimit,
  validate(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body as { email: string; code: string };

    const user = await prisma.user.findUnique({ where: { email } });
    const record = user
      ? await prisma.emailVerificationCode.findFirst({
          where: { user_id: user.id },
          orderBy: { created_at: 'desc' },
        })
      : null;

    // Meme message dans tous les cas (inconnu / sans code / expire / consomme
    // / epuise / faux code) : aucun detail ne doit fuiter.
    if (!user || !record) {
      throw ApiError.badRequest('Code invalide ou expire', 'INVALID_VERIFICATION_CODE');
    }

    const valid = await verifyStoredCode({
      record,
      enteredHash: hashVerificationCode(code),
      maxAttempts: env.EMAIL_VERIFICATION_MAX_ATTEMPTS,
      consumed: record.consumed_at !== null,
      destroy: () => prisma.emailVerificationCode.delete({ where: { id: record.id } }),
      addAttempt: () =>
        prisma.emailVerificationCode.update({
          where: { id: record.id },
          data: { attempts: { increment: 1 } },
        }),
    });
    if (!valid) {
      throw ApiError.badRequest('Code invalide ou expire', 'INVALID_VERIFICATION_CODE');
    }

    const verifiedAt = new Date();
    // Un code n'existe que pour un compte non verifie (register / resend) :
    // on capture l'etat avant pour ne jamais accorder de coupon a un compte
    // deja verifie (pas de backfill).
    const wasVerified = user.email_verified_at !== null;
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { email_verified_at: verifiedAt } }),
      prisma.emailVerificationCode.update({
        where: { id: record.id },
        data: { consumed_at: verifiedAt },
      }),
    ]);
    // Reflete la verification dans la reponse (l objet `user` est anterieur).
    user.email_verified_at = verifiedAt;

    if (user.role === 'livreur') {
      await prisma.livreur.upsert({ where: { user_id: user.id }, update: {}, create: { user_id: user.id } });
    }

    // Meme contrat que /login : l'app connecte l'utilisateur directement.
    const tokens = await issueTokens(user.id, user.role);
    logger.info('auth', `email verified user=${user.id}`);
    // Coupon de bienvenue : premiere verification du compte (jamais jetant,
    // n'interrompt pas la connexion). Refuse si un identifiant du compte a
    // deja reclame le coupon, y compris apres une suppression de compte.
    if (!wasVerified) {
      const granted = await grantWelcomeCouponWithClaim(
        user.id,
        welcomeClaimIdentifiersFromUser(user),
      );
      if (granted) void sendWelcomeCouponNotification(user.id);
    }
    res.json({ ...tokens, user: toSafeUser(user) });
  }),
);

/**
 * Renvoi d'un code de verification.
 *
 * Anti-enumeration : reponse TOUJOURS 200 `{ ok: true }` (compte inconnu,
 * deja verifie ou cooldown). Le code n'est envoye que si le compte existe et
 * n'est pas verifie ; un echec d'envoi ne change pas la reponse. En dev sans
 * Mailjet, `dev_code` est renvoye (jamais en production).
 */
router.post(
  '/resend-verification',
  resendVerificationRateLimit,
  validate(resendVerificationSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };
    const ok = { ok: true as const };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.email_verified_at) return res.json(ok);

    const send = await sendVerificationCode(user);
    if (send.status === 'failed') return res.json(ok);
    return res.json(send.status === 'sent' && send.dev_code ? { ...ok, dev_code: send.dev_code } : ok);
  }),
);

/**
 * Mot de passe oublie, etape 1 : envoi d'un code a 6 chiffres par email.
 *
 * Anti-enumeration : la reponse est TOUJOURS 200 `{ ok: true }`, que le compte
 * existe ou non (et meme pendant le cooldown). En developpement, si Mailjet n'est
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
    if (!user || !user.email) return res.json(ok);

    // Cooldown par compte : ne pas renvoyer un code a chaque clic.
    const last = await prisma.passwordResetCode.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });
    if (last && Date.now() - last.created_at.getTime() < RESEND_COOLDOWN_MS) {
      return res.json(ok);
    }

    const code = generateCode();
    await storeResetCode(user.id, code);

    if (!isMailConfigured()) {
      if (isProd) {
        throw new ApiError(503, 'MAIL_UNAVAILABLE', "L'envoi d'email n'est pas configure");
      }
      logger.warn(
        'mail',
        `Mailjet non configure : code de reinitialisation (dev) user=${user.id}`,
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
      // Dev : Mailjet mal configure -> on donne le code pour ne pas bloquer.
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
    if (!user || !user.email) {
      throw ApiError.badRequest('Code invalide ou expire', 'INVALID_RESET_CODE');
    }

    const record = await prisma.passwordResetCode.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });
    if (!record) throw ApiError.badRequest('Code invalide ou expire', 'INVALID_RESET_CODE');

    const valid = await verifyStoredCode({
      record,
      enteredHash: hashResetCode(code),
      maxAttempts: env.PASSWORD_RESET_MAX_ATTEMPTS,
      destroy: () => prisma.passwordResetCode.delete({ where: { id: record.id } }),
      addAttempt: () =>
        prisma.passwordResetCode.update({
          where: { id: record.id },
          data: { attempts: { increment: 1 } },
        }),
    });
    if (!valid) throw ApiError.badRequest('Code invalide ou expire', 'INVALID_RESET_CODE');

    const password_hash = await bcrypt.hash(password, 10);
    // Le reset ne verifie le compte que s'il ne l'etait pas : dans ce cas
    // (premiere verification) le coupon de bienvenue est accorde.
    const justVerified = !user.email_verified_at;
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          password_hash,
          // Le possesseur de la boite mail a prouve sa propriete : on verifie
          // l'email s'il ne l'etait pas (compte non verifie avant le reset).
          ...(user.email_verified_at ? {} : { email_verified_at: new Date() }),
        },
      }),
      prisma.passwordResetCode.deleteMany({ where: { user_id: user.id } }),
      // Deconnexion de tous les appareils apres un changement de mot de passe.
      prisma.refreshToken.deleteMany({ where: { user_id: user.id } }),
    ]);

    logger.info('auth', `password reset user=${user.id}`);
    // Meme regle que les autres inscriptions : verification d'un compte
    // inacheve = potentiellement un re-inscrit apres suppression (anti-abus).
    if (justVerified) {
      const granted = await grantWelcomeCouponWithClaim(
        user.id,
        welcomeClaimIdentifiersFromUser(user),
      );
      if (granted) void sendWelcomeCouponNotification(user.id);
    }
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
    // Aucun nouveau token pour un compte dont l'email n'a pas ete verifie.
    if (!user.email_verified_at) {
      throw ApiError.forbidden('Email non verifie', 'EMAIL_NOT_VERIFIED');
    }

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
