import { normalizeDishType } from './categoryRules';

/**
 * Spécialités « commerce » (écran liste client) : une clé -> les types de plat
 * qui la composent. Un commerce appartient à CHAQUE spécialité pour laquelle il
 * possède au moins un produit DISPONIBLE (un Burger donne 'burger' ET
 * 'fast_food').
 *
 * Matching insensible à la casse ET aux accents (normalizeDishType) —
 * « Fricassé » et « fricasse » sont le même dish_type. Boisson et tout
 * dish_type inconnu (ou null) ne mappent vers aucune spécialité.
 *
 * L'ORDRE du tableau est l'ordre stable renvoyé dans `specialities[]`.
 */
const SPECIALITY_TABLE: ReadonlyArray<{ key: string; dishTypes: readonly string[] }> = [
  {
    key: 'fast_food',
    dishTypes: ['Sandwich', 'Makloub', 'Baguette farcie', 'Libanais', 'Cornet', 'Tacos', 'Fricassé', 'Burger'],
  },
  { key: 'burger', dishTypes: ['Burger'] },
  { key: 'pizza', dishTypes: ['Pizza'] },
  { key: 'plats', dishTypes: ['Plat', 'Tajine'] },
];

/** Set normalisé par ligne, construit une seule fois au boot. */
const TABLE = SPECIALITY_TABLE.map((entry) => ({
  key: entry.key,
  normalized: new Set(entry.dishTypes.map((type) => normalizeDishType(type))),
}));

/** Clés de la table (ordre stable) — le client y adosse ses labels. */
export const SPECIALITY_KEYS = TABLE.map((entry) => entry.key);

/**
 * Clés de spécialité d'un commerce à partir de la liste de ses dish_type
 * (distints, produits is_available = true — le caller groupe une fois).
 */
export function specialitiesFor(dishTypes: ReadonlyArray<string | null | undefined>): string[] {
  const normalized = new Set<string>();
  for (const raw of dishTypes) {
    const value = normalizeDishType(raw);
    if (value !== '') normalized.add(value);
  }
  if (normalized.size === 0) return [];
  return TABLE.filter((entry) => {
    for (const type of entry.normalized) {
      if (normalized.has(type)) return true;
    }
    return false;
  }).map((entry) => entry.key);
}
