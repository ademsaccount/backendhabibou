import type { User } from '@prisma/client';

/** Champs jamais exposés côté REST (hash de mot de passe, jetons internes). */
export type SafeUser = Omit<User, 'password_hash' | 'expo_push_token' | 'apple_refresh_token'> & {
  /**
   * Vrai si le compte possède un mot de passe local. L'app s'en sert pour
   * choisir la confirmation de suppression de compte (mot de passe vs saisie
   * de DELETE pour un compte Google / Apple sans mot de passe).
   */
  has_password: boolean;
};

export function toSafeUser(user: User): SafeUser {
  const { password_hash, expo_push_token: _pushToken, apple_refresh_token: _appleToken, ...safe } =
    user;
  return { ...safe, has_password: Boolean(password_hash) };
}
