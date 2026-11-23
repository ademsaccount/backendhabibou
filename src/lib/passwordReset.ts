import crypto from 'crypto';

import { env } from '../config/env';
import { sha256 } from './jwt';

/**
 * Helpers partages pour les codes a 6 chiffres envoyes par email :
 * reinitialisation de mot de passe ET verification d'inscription.
 *
 * Regles communes :
 * - le code en clair n'est jamais stocke ni journalise (hash SHA-256 seul) ;
 * - un seul code actif par utilisateur (les anciens sont supprimes a l'envoi) ;
 * - duree de vie courte, nombre d'essais limite, comparaison a temps constant.
 */

/** Delai minimal entre deux envois de code pour un meme compte (reset + verification). */
export const RESEND_COOLDOWN_MS = 60_000;

/** Code numerique a 6 chiffres (cryptographiquement aleatoire). */
export function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Hash d'un code de reinitialisation (scope distinct : pas d'interchangeabilite). */
export function hashResetCode(code: string): string {
  return sha256(`password-reset:${code}`);
}

/** Hash d'un code de verification d'email. */
export function hashVerificationCode(code: string): string {
  return sha256(`email-verification:${code}`);
}

export function resetCodeExpiry(): Date {
  return new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000);
}

export function verificationCodeExpiry(): Date {
  return new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_MIN * 60_000);
}

export function isCodeExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

/** Comparaison a temps constant de deux hashes hexadecimaux. */
export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Sous-ensemble commun aux codes Prisma (reset et verification). */
export type StoredCode = {
  id: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
};

/**
 * Verifie un code stocke et gere ses tentatives, de facon identique pour le
 * reset et la verification d'email :
 * - valide -> true (aucune ecriture) ;
 * - invalide -> false, et le code est supprime s'il est devenu inutilisable
 *   (expire / epuise / deja consomme), sinon son compteur d'essais augmente.
 *
 * Les effets de bord sont injectes car les deux modeles Prisma different.
 */
export async function verifyStoredCode(opts: {
  record: StoredCode | null;
  /** Hash du code saisi, calcule par l'appelant. */
  enteredHash: string;
  maxAttempts: number;
  /** Vrai si le code a deja ete valide (usage unique). */
  consumed?: boolean;
  /** Supprimer le code (expire / epuise / consomme). */
  destroy: () => Promise<unknown>;
  /** Incrementer le compteur d'essais. */
  addAttempt: () => Promise<unknown>;
}): Promise<boolean> {
  const { record, enteredHash, maxAttempts, consumed = false, destroy, addAttempt } = opts;
  if (!record) return false;

  const expired = isCodeExpired(record.expires_at);
  const exhausted = record.attempts >= maxAttempts;
  const mismatch = !sameHash(record.code_hash, enteredHash);
  if (!expired && !exhausted && !consumed && !mismatch) return true;

  if (expired || exhausted || consumed || record.attempts + 1 >= maxAttempts) {
    await destroy().catch(() => undefined);
  } else {
    await addAttempt().catch(() => undefined);
  }
  return false;
}
