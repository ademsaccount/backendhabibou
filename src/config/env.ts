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
  DELIVERY_FEE: z.coerce.number().min(0).default(15),
  NEARBY_RADIUS_KM: z.coerce.number().min(0).default(20),
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
