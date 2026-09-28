/**
 * Catalogue des codes d'erreur **stables**.
 *
 * Contrat client : les apps (habichou / sudo_habichou) traduisent localement via
 * `errors.codes.<CODE>` et n'affichent le message serveur qu'en secours. Toute
 * nouvelle erreur doit donc être ajoutée ici AVANT d'être utilisée — le type
 * `ErrorCode` est branché sur les helpers de `errors.ts` et refuse tout code inconnu.
 *
 * Règles :
 * - un code ne change jamais de sens (on en crée un nouveau à la place) ;
 * - snake_case majuscules, préfixe métier explicite quand c'est utile (`PRODUCT_*`) ;
 * - le champ `message` reste du texte lisible (français) pour les logs et le debug,
 *   il n'est plus la source de vérité pour l'affichage.
 */
export const ERROR_CODES = [
  // génériques / transport
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
  'INVALID_REFRESH_TOKEN',
  'REFRESH_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'CONFLICT',
  'ALREADY_EXISTS',
  'INTERNAL_ERROR',
  'DATABASE_UNAVAILABLE',
  'UPLOAD_FAILED',
  'UPLOADS_DISABLED',
  'FILE_REQUIRED',
  'INVALID_FILE_TYPE',
  // auth
  'USER_NOT_FOUND',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'ROLE_DISABLED',
  // catalogue / commerce
  'MEDICATION_CATEGORY_NOT_FOUND',
  'INGREDIENT_NOT_FOUND',
  'SUPPLEMENT_NOT_FOUND',
  'HAS_ORDERS',
  'HAS_PRODUCTS',
  // commande
  'EMPTY_CART',
  'INVALID_ITEMS',
  'MULTI_RESTAURANT',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_UNAVAILABLE',
  'RESTAURANT_CLOSED',
  'ORDER_EXISTS',
  'ORDER_CLOSED',
  'INVALID_TRANSITION',
  'CANNOT_CANCEL',
  'NOT_DELIVERED',
  'ALREADY_REVIEWED',
  'NOT_CARD_PAYMENT',
  'ALREADY_PAID',
  'NO_LIVREUR',
  'NOT_LIVREUR',
  // adresse
  'ADDRESS_IN_USE',
  // demande spécifique
  'NOT_QUOTED',
  'REQUEST_CLOSED',
  'REQUEST_NOT_ACCEPTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}
