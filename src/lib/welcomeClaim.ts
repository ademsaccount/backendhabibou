import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Anti-abus du coupon de bienvenue.
 *
 * Probleme : la suppression de compte efface le compte ET son coupon. Rien ne
 * memorisait que « cet email a deja profite du coupon », donc une meme
 * personne pouvait se re-inscrire a l'infini et re-clamer la livraison
 * offerte.
 *
 * Solution : une table WelcomeCouponClaim qui garde des EMPREINTES
 * HMAC-SHA256 (jamais d'identifiant en clair, donc rien de devinable par
 * dictionnaire meme avec la table en main) des identifiants qui ont deja
 * reclame le coupon. La table n'a AUCUNE foreign key vers User : la
 * suppression de compte ne la touche pas — c'est voulu (fraude), et seules
 * des empreintes anonymes y sont conservees.
 *
 * Aucun identifiant ni empreinte n'est jamais journalise.
 */

export type WelcomeClaimKind = 'email' | 'phone' | 'google' | 'apple';

/** Apple relay : adresse jetable, pas un identifiant stable -> pas de cle email. */
const APPLE_PRIVATE_RELAY_SUFFIX = '@privaterelay.appleid.com';

const P2002 = 'P2002';

/** Identifiants d'un compte susceptibles de reclamer le coupon. */
export type WelcomeClaimIdentifiers = {
  email?: string | null;
  phone?: string | null;
  googleId?: string | null;
  appleId?: string | null;
};

let devSecret: string | null = null;

/**
 * Secret HMAC. En production il est verifie au demarrage (env.ts) ; en
 * developpement, si absent, un secret aleatoire par processus evite de
 * hasher avec une cle vide (les empreintes dev deviennent alors non
 * reproductibles — normal, on ne backfill jamais en dev).
 */
function claimSecret(): string {
  const configured = env.WELCOME_CLAIM_SECRET;
  if (configured.length > 0) return configured;
  if (!devSecret) {
    devSecret = crypto.randomBytes(32).toString('hex');
    logger.warn(
      'coupon',
      'WELCOME_CLAIM_SECRET absent : secret aleatoire dev utilise (ne pas backfiller avec)',
    );
  }
  return devSecret;
}

/** Email : trim + minuscules ; Gmail : ni points ni tag « + » ; relay Apple ignore. */
export function normalizeClaimEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  if (email.endsWith(APPLE_PRIVATE_RELAY_SUFFIX)) return null;

  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

/**
 * Telephone : chiffres uniquement, ramene au format international utilise par
 * l'app (Tunisie, indicatif 216) pour que « 55 123 456 », « +216 55 123 456 »
 * et « 00216 55 123 456 » produisent la meme empreinte.
 */
export function normalizeClaimPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits.startsWith('216') && digits.length === 8) digits = `216${digits}`;
  if (digits.length < 8) return null;
  return digits;
}

/** HMAC-SHA256(secret, "kind:valeur_normalisee") en hex. Jamais journalise. */
export function hashWelcomeClaim(kind: WelcomeClaimKind, normalizedValue: string): string {
  return crypto
    .createHmac('sha256', claimSecret())
    .update(`${kind}:${normalizedValue}`, 'utf8')
    .digest('hex');
}

type ClaimRow = { kind: WelcomeClaimKind; key_hash: string };

/**
 * Empreintes de TOUS les identifiants presents pour ce compte. Une liste
 * vide (aucun identifiant exploitable) ne bloque rien : il n'y a alors rien a
 * verifier.
 */
export function buildWelcomeClaims(ids: WelcomeClaimIdentifiers): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const push = (kind: WelcomeClaimKind, value: string | null | undefined) => {
    if (!value) return;
    rows.push({ kind, key_hash: hashWelcomeClaim(kind, value) });
  };
  push('email', normalizeClaimEmail(ids.email));
  push('phone', normalizeClaimPhone(ids.phone));
  if (ids.googleId) push('google', ids.googleId.trim().toLowerCase());
  if (ids.appleId) push('apple', ids.appleId.trim().toLowerCase());
  return rows;
}

/** Vrai si l'un de ces identifiants a deja reclame le coupon. */
export async function hasWelcomeClaim(ids: WelcomeClaimIdentifiers): Promise<boolean> {
  const rows = buildWelcomeClaims(ids);
  if (rows.length === 0) return false;
  try {
    const found = await prisma.welcomeCouponClaim.findFirst({
      where: { key_hash: { in: rows.map((row) => row.key_hash) } },
      select: { id: true },
    });
    return Boolean(found);
  } catch (err) {
    // En cas d'incertitude on n'accelere pas l'abus : on considere que non.
    logger.error('coupon', 'verification des empreintes impossible', err instanceof Error ? err : String(err));
    return false;
  }
}

/** Insere les empreintes en ignorant les doublons (unique). Jamais journalise. */
export async function recordWelcomeClaims(ids: WelcomeClaimIdentifiers): Promise<void> {
  const rows = buildWelcomeClaims(ids);
  for (const row of rows) {
    try {
      await prisma.welcomeCouponClaim.create({ data: row });
    } catch (err) {
      if ((err as { code?: string })?.code !== P2002) {
        logger.error('coupon', 'ecriture empreinte coupon impossible', err instanceof Error ? err : String(err));
      }
    }
  }
}

/**
 * Accorde le coupon de bienvenue en VERIFIANT les empreintes d'abord :
 *
 * - un identifiant deja reclame (autre compte, ou meme compte supprime puis
 *   re-inscrit) -> PAS de coupon, PAS de notification ;
 * - sinon, coupon + empreintes ecrits dans LA MEME transaction : si la
 *   transaction echoue, ni l'un ni l'autre n'est enregistre.
 *
 * Idempotent pour un compte qui possede deja son coupon. Ne leve jamais.
 * Renvoie true seulement si le compte a (ou a deja) le coupon, pour que
 * l'appelant decide d'envoyer ou non la notification.
 */
export async function grantWelcomeCouponWithClaim(
  userId: string,
  ids: WelcomeClaimIdentifiers,
): Promise<boolean> {
  const claims = buildWelcomeClaims(ids);

  try {
    return await prisma.$transaction(async (tx) => {
      if (claims.length > 0) {
        const taken = await tx.welcomeCouponClaim.findFirst({
          where: { key_hash: { in: claims.map((claim) => claim.key_hash) } },
          select: { id: true },
        });
        if (taken) {
          // Compte cree normalement, mais l'identite a deja profite du coupon.
          logger.info('coupon', 'coupon bienvenue refuse : identite deja utilisee');
          return false;
        }
        for (const claim of claims) {
          await tx.welcomeCouponClaim.create({ data: claim });
        }
      }

      const existing = await tx.coupon.findUnique({
        where: { user_id_source: { user_id: userId, source: 'WELCOME' } },
        select: { id: true },
      });
      if (!existing) {
        await tx.coupon.create({
          data: { user_id: userId, source: 'WELCOME', type: 'FREE_DELIVERY' },
        });
        logger.info('coupon', `coupon bienvenue accorde user=${userId}`);
      }
      return true;
    });
  } catch (err) {
    // Transaction annulee (doublon concurrent sur une empreinte, reseau…) :
    // on ne sait pas qui a gagne, on regarde l'etat reel du compte.
    logger.error('coupon', 'transaction coupon bienvenue echouee', err instanceof Error ? err : String(err));
    try {
      const existing = await prisma.coupon.findUnique({
        where: { user_id_source: { user_id: userId, source: 'WELCOME' } },
        select: { id: true },
      });
      // Coupon deja la -> l'appelant a le droit a la notification ; sinon non.
      return Boolean(existing);
    } catch {
      return false;
    }
  }
}

/** Identifiants extraits d'une ligne User (les colonnes sont toutes nullables). */
export function welcomeClaimIdentifiersFromUser(user: {
  email?: string | null;
  phone?: string | null;
  google_id?: string | null;
  apple_id?: string | null;
}): WelcomeClaimIdentifiers {
  return {
    email: user.email,
    phone: user.phone,
    googleId: user.google_id,
    appleId: user.apple_id,
  };
}
