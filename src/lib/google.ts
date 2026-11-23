import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { env } from '../config/env';

/**
 * Verifie un ID token Google cote serveur (flux natif "Sign in with Google").
 *
 * Toutes les audiences configurees sont acceptees : le Web client ID (obligatoire)
 * et, si presentes, les client IDs iOS / Android. Aucun client secret n'est utilise.
 */
const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

const AUDIENCES = [env.GOOGLE_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID].filter(
  (value): value is string => value.length > 0,
);

export async function verifyGoogleIdToken(idToken: string): Promise<TokenPayload | undefined> {
  const ticket = await client.verifyIdToken({ idToken, audience: AUDIENCES });
  return ticket.getPayload();
}
