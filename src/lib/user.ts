import type { User } from '@prisma/client';

/** Champs jamais exposés côté REST (hash de mot de passe, jeton push interne). */
export type SafeUser = Omit<User, 'password_hash' | 'expo_push_token'>;

export function toSafeUser(user: User): SafeUser {
  const { password_hash: _hash, expo_push_token: _pushToken, ...safe } = user;
  return safe;
}
