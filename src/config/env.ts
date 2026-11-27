import 'dotenv/config';
import { z } from 'zod';
import { logger } from '../lib/logger';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL manquant : complete le fichier .env (voir .env.example)'),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_STORAGE_BUCKET: z.string().default('habichou'),
  /** Bucket public des medias de categories (GIF specialites). */
  SUPABASE_MEDIA_BUCKET: z.string().default('category-media'),
  JWT_ACCESS_SECRET: z.string().min(8, 'JWT_ACCESS_SECRET doit faire au moins 8 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(8, 'JWT_REFRESH_SECRET doit faire au moins 8 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  /** Connexion Google : Web client ID (audience principale, obligatoire). */
  GOOGLE_CLIENT_ID: z
    .string()
    .default('')
    .refine(
      (value) => value.length > 0,
      'GOOGLE_CLIENT_ID manquant : ajoute le Web client ID Google (voir .env.example)',
    ),
  /** Audiences supplementaires acceptees (iOS / Android), optionnelles. */
  GOOGLE_IOS_CLIENT_ID: z.string().default(''),
  GOOGLE_ANDROID_CLIENT_ID: z.string().default(''),
  /**
   * Sign in with Apple (iOS uniquement). L'audience du jeton d'identite et le
   * client_id Apple est le bundle identifier de l'app.
   *
   * APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY sont necessaires pour
   * construire le client_secret ES256 (echange du code + revocation). Sans
   * eux, la connexion Apple par jeton reste possible mais aucun refresh token
   * n'est stocke (la revocation a la suppression est alors ignoree).
   */
  APPLE_BUNDLE_ID: z.string().default('com.adem1.habichou'),
  APPLE_TEAM_ID: z.string().default(''),
  APPLE_KEY_ID: z.string().default(''),
  /** Cle privee .p8 Apple ; les "\n" litteraux sont remplaces au chargement. */
  APPLE_PRIVATE_KEY: z.string().default(''),
  /**
   * Secret HMAC des empreintes de coupon de bienvenue (anti-abus apres
   * suppression de compte). Vide par defaut : en production il est REFUSE au
   * demarrage s'il manque ou s'il fait moins de 32 caracteres.
   * Doit avoir la MEME valeur localement et sur Render (sinon les empreintes
   * locales ne correspondront pas a celles de la base).
   */
  WELCOME_CLAIM_SECRET: z.string().default(''),
  /**
   * Envoi d'emails (reinitialisation de mot de passe) via l'API HTTP Mailjet.
   * Optionnel : sans configuration, le code n'est renvoye qu'en developpement.
   * (SMTP inutilisable : Render bloque les ports 25/465/587.)
   */
  MAILJET_API_KEY: z.string().default(''),
  MAILJET_SECRET_KEY: z.string().default(''),
  /** Expediteur verifie dans Mailjet, ex. "no-reply@habichou.tn". */
  MAILJET_SENDER_EMAIL: z.string().default(''),
  /** Nom affiche de l'expediteur, ex. "Habichou". */
  MAILJET_SENDER_NAME: z.string().default(''),
  /** Duree de vie du code de reinitialisation (minutes). */
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(15),
  /** Nombre d'essais autorises avant invalidation du code. */
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Duree de vie du code de verification d'email (minutes). */
  EMAIL_VERIFICATION_TTL_MIN: z.coerce.number().int().positive().default(15),
  /** Nombre d'essais autorises avant invalidation du code de verification. */
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Frais fixes par course. */
  DELIVERY_BASE_FEE: z.coerce.number().min(0).default(2),
  /** Frais au kilometre : ligne droite, chaque troncon arrondi au km superieur. */
  DELIVERY_PER_KM_FEE: z.coerce.number().min(0).default(0.5),
  /** Supplement par commerce supplementaire dans une meme commande (tour du livreur). */
  DELIVERY_HOP_FEE: z.coerce.number().min(0).default(0.5),
  /** Fuseau horaire utilise pour comparer opening_hours a l'heure courante. */
  BUSINESS_TZ: z.string().default('Africa/Tunis'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_CURRENCY: z.string().default('mad'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error('env', 'invalid environment variables');
  for (const issue of parsed.error.issues) {
    logger.error('env', `${issue.path.join('.')}: ${issue.message}`);
  }
  logger.error('env', 'copy .env.example to .env and complete the values');
  process.exit(1);
}

/**
 * Secret des empreintes du coupon de bienvenue : REFUSE en production s'il
 * manque ou s'il fait moins de 32 caracteres. Un secret court rendrait les
 * empreintes devinables par dictionnaire (emails en clair recuperables).
 * Jamais journalise.
 */
if (parsed.data.NODE_ENV === 'production' && parsed.data.WELCOME_CLAIM_SECRET.length < 32) {
  logger.error('env', 'WELCOME_CLAIM_SECRET manquant ou trop court : 32 caracteres minimum');
  logger.error('env', 'ajoute la meme valeur dans le .env de Render et dans .env.example');
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
