/**
 * Regles d'application des salades / sauces / supplements au niveau du commerce
 * (RestaurantSalad / RestaurantSauce / RestaurantSupplement) selon le dish_type
 * du produit.
 *
 * Normalisation : NFD -> suppression des diacritiques -> minuscules.
 * Match EXACT sur la valeur normalisee : pas de devinette sur une faute de frappe.
 *
 * Table des regles :
 *  | dish_type                                  | salades shop | sauces shop | supplements shop              |
 *  | Sandwich, Burger, Makloub, Libanais,       | OUI          | TOUTES      | TOUS                          |
 *  | Baguette farcie                            |              |             |                               |
 *  | Tacos, Cornet                              | AUCUNE       | TOUTES      | TOUS                          |
 *  | Fricassé                                   | AUCUNE       | AUCUNE      | uniquement for_fricasse=true  |
 *  | Pizza, Tajine, Plat, Boisson, inconnu/null | AUCUNE       | AUCUNE      | AUCUN                         |
 */

/** Met en minuscules et retire accents/casse (insensible a la langue du menu). */
export function normalizeDishType(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** Cle canonique d'un nom de garniture (Sauce.name_key / Salad.name_key) :
 *  minuscules + accents supprimés + espaces internes réduits à un seul. */
export function normalizeItemName(raw: string | null | undefined): string {
  return normalizeDishType(raw)
    .replace(/\s+/g, ' ')
    .trim();
}

/** dish_type dont le produit recoit TOUTES les sauces + TOUS les supplements du shop. */
const ALL_TYPES = new Set(
  [
    'Sandwich',
    'Tacos',
    'Makloub',
    'Baguette farcie',
    'Libanais',
    'Cornet',
    'Burger',
  ].map((value) => normalizeDishType(value)),
);

/** dish_type sans sauce, recevant uniquement les supplements for_fricasse=true. */
const FRICASSE_TYPES = new Set(['Fricassé', 'Fricasse'].map((value) => normalizeDishType(value)));

/** dish_type recevant les salades du shop (fraîches, gratuites). */
const SALAD_TYPES = new Set(
  [
    'Sandwich',
    'Burger',
    'Makloub',
    'Libanais',
    'Baguette farcie',
  ].map((value) => normalizeDishType(value)),
);

/** true si deux noms sont identiques en ignorant casse/accents. */
export function sameName(a: string, b: string): boolean {
  const na = normalizeDishType(a);
  return na !== '' && na === normalizeDishType(b);
}

type ShopSupplementRow = { name: string; for_fricasse: boolean };
type ShopSauceRow = { name: string };
type ShopSaladRow = { name: string };

/**
 * Sauces du shop applicables a un produit.
 * Les sauces ne se candidatent jamais sur les Fricasses.
 */
export function applicableSauces<T extends ShopSauceRow>(
  dishType: string | null | undefined,
  shopSauces: T[],
): T[] {
  const normalized = normalizeDishType(dishType);
  if (ALL_TYPES.has(normalized)) return shopSauces;
  return [];
}

/**
 * Salades du shop applicables a un produit (fraîches, GRATUITES).
 * Seulement Sandwich, Burger, Makloub, Libanais et Baguette farcie —
 * aucune autre categorie ne les recoit.
 */
export function applicableSalads<T extends ShopSaladRow>(
  dishType: string | null | undefined,
  shopSalads: T[],
): T[] {
  const normalized = normalizeDishType(dishType);
  if (SALAD_TYPES.has(normalized)) return shopSalads;
  return [];
}

/**
 * Supplements du shop applicables a un produit.
 * Fricasse : uniquement ceux avec for_fricasse = true.
 */
export function applicableSupplements<T extends ShopSupplementRow>(
  dishType: string | null | undefined,
  shopSupplements: T[],
): T[] {
  const normalized = normalizeDishType(dishType);
  if (ALL_TYPES.has(normalized)) return shopSupplements;
  if (FRICASSE_TYPES.has(normalized)) return shopSupplements.filter((s) => s.for_fricasse);
  return [];
}

/**
 * Fusionne pour le pricing commande : supplements shop (prix serveur) + supplements
 * au niveau produit. Le niveau produit GAGNE en cas de conflit de nom (casse ignoree).
 */
export function mergeSupplementEntries(
  dishType: string | null | undefined,
  shopSupplements: (ShopSupplementRow & { extra_price: number })[],
  productEntries: { name: string; price: number }[],
): { name: string; price: number }[] {
  const out = productEntries.map((entry) => ({ ...entry }));
  for (const shop of applicableSupplements(dishType, shopSupplements)) {
    if (productEntries.some((entry) => sameName(entry.name, shop.name))) continue;
    out.push({ name: shop.name, price: shop.extra_price });
  }
  return out;
}
