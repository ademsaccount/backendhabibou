import crypto from 'crypto';

import { env } from '../config/env';
import { sha256 } from './jwt';

/** Delai minimal entre deux envois de code pour un meme compte. */
export const RESET_RESEND_COOLDOWN_MS = 60_000;

/** Code numerique a 6 chiffres (cryptographiquement aleatoire). */
export function generateResetCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Le code en clair n'est jamais stocke ni loggue : uniquement son hash. */
export function hashResetCode(code: string): string {
  return sha256(`password-reset:${code}`);
}

export function resetCodeExpiry(): Date {
  return new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000);
}

export function isResetCodeExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

/** Comparaison a temps constant de deux hashes hexadecimaux. */
export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
