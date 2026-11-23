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
   * Envoi d'emails (reinitialisation de mot de passe) via l'API HTTP Brevo.
   * Optionnel : sans configuration, le code n'est renvoye qu'en developpement.
   * (SMTP inutilisable : Render bloque les ports 25/465/587.)
   */
  BREVO_API_KEY: z.string().default(''),
  /** Expediteur, ex. "no-reply@habichou.tn". */
  MAIL_FROM_EMAIL: z.string().default(''),
  /** Nom affiche de l'expediteur. */
  MAIL_FROM_NAME: z.string().default('Habichou'),
  /** Duree de vie du code de reinitialisation (minutes). */
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(15),
  /** Nombre d'essais autorises avant invalidation du code. */
  PASSWORD_RESET_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
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

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
