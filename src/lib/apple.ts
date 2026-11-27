import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { sha256 } from './jwt';
import { logger } from './logger';

/**
 * Sign in with Apple — verification cote serveur.
 *
 * Le client iOS envoie le jeton d'identite Apple (JWT RS256 signe par Apple).
 * On verifie la signature avec les cles publiques Apple (JWKS mis en cache),
 * puis l'emetteur, l'audience (bundle id) et le nonce.
 *
 * Aucun jeton ni cle privee n'est journalise.
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = `${APPLE_ISSUER}/auth/keys`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`;
/** Les cles Apple changent rarement : cache d'une heure. */
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface AppleIdentityPayload extends jwt.JwtPayload {
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  nonce?: string;
}

type AppleJwk = {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
};

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;

async function fetchAppleKeys(force = false): Promise<AppleJwk[]> {
  if (!force && cachedKeys && Date.now() - cachedKeys.fetchedAt < JWKS_TTL_MS) {
    return cachedKeys.keys;
  }

  const response = await fetch(APPLE_KEYS_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Apple JWKS HTTP ${response.status}`);
  }
  const body = (await response.json()) as { keys?: AppleJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw new Error('Apple JWKS vide');

  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

function jwkToPem(jwk: AppleJwk): string {
  if (!jwk.n || !jwk.e) throw new Error('Cle Apple RSA incomplete');
  const key = crypto.createPublicKey({
    key: { kty: jwk.kty ?? 'RSA', n: jwk.n, e: jwk.e },
    format: 'jwk',
  });
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Verifie un jeton d'identite Apple.
 *
 * - signature RS256 via la cle publique correspondant au `kid` ;
 * - `iss` = https://appleid.apple.com ;
 * - `aud` = APPLE_BUNDLE_ID ;
 * - expiration (`exp`) verifiee par jsonwebtoken ;
 * - `nonce` = SHA-256 hex du rawNonce envoye par le client.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  rawNonce: string,
): Promise<AppleIdentityPayload> {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('Jeton Apple sans kid');
  }

  let keys = await fetchAppleKeys();
  let jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    // Rotation de cle Apple : on force un rafraichissement une fois.
    keys = await fetchAppleKeys(true);
    jwk = keys.find((key) => key.kid === decoded.header.kid);
  }
  if (!jwk) throw new Error('Cle publique Apple introuvable');

  const payload = jwt.verify(identityToken, jwkToPem(jwk), {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: env.APPLE_BUNDLE_ID,
  }) as AppleIdentityPayload;

  if (!rawNonce || !payload.nonce || payload.nonce !== sha256(rawNonce)) {
    throw new Error('Nonce Apple invalide');
  }

  return payload;
}

/** Vrai si la cle privee Apple est configuree (echange / revocation possibles). */
export function isAppleServerConfigured(): boolean {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

/**
 * client_secret Apple : JWT ES256 signe avec la cle .p8.
 * `sub` = bundle id, `iss` = Team ID, `aud` = https://appleid.apple.com,
 * expiration 5 minutes.
 */
function buildAppleClientSecret(): string {
  if (!isAppleServerConfigured()) {
    throw new Error('Configuration Apple serveur incomplete');
  }
  // Render / les .env stockent souvent la cle avec des "\n" litteraux.
  const privateKey = env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  return jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    keyid: env.APPLE_KEY_ID,
    issuer: env.APPLE_TEAM_ID,
    audience: APPLE_ISSUER,
    subject: env.APPLE_BUNDLE_ID,
    expiresIn: '5m',
  });
}

/**
 * Echange l'authorizationCode Apple contre des tokens, et retourne le
 * refresh_token a conserver pour la revocation. Ne leve jamais : un echec
 * d'echange ne doit pas bloquer la connexion.
 */
export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
): Promise<string | null> {
  if (!isAppleServerConfigured()) {
    logger.warn('apple', 'client_secret non configure : refresh token non recupere');
    return null;
  }

  try {
    const body = new URLSearchParams({
      client_id: env.APPLE_BUNDLE_ID,
      client_secret: buildAppleClientSecret(),
      code: authorizationCode,
      grant_type: 'authorization_code',
    });
    const response = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      logger.warn('apple', `echange authorizationCode refuse status=${response.status}`);
      return null;
    }
    const data = (await response.json()) as { refresh_token?: string };
    return data.refresh_token ?? null;
  } catch (error) {
    logger.warn(
      'apple',
      "echange authorizationCode impossible",
      error instanceof Error ? error : String(error),
    );
    return null;
  }
}

/**
 * Revoque le refresh token Apple (suppression de compte). Leve en cas d'echec :
 * l'appelant loggue puis poursuit la suppression (best effort).
 */
export async function revokeAppleRefreshToken(refreshToken: string): Promise<void> {
  if (!isAppleServerConfigured()) {
    logger.warn('apple', 'client_secret non configure : revocation Apple ignoree');
    return;
  }

  const body = new URLSearchParams({
    client_id: env.APPLE_BUNDLE_ID,
    client_secret: buildAppleClientSecret(),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  const response = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Apple revoke HTTP ${response.status}`);
  }
}
