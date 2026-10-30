import type { Prisma, PrismaClient } from '@prisma/client';

import { ApiError } from './errors';
import {
  applicableSalads,
  applicableSauces,
  applicableSupplements,
  normalizeItemName,
  sameName,
} from './categoryRules';

/** Client Prisma : soit une transaction, soit le client principal (seed). */
type Db = Prisma.TransactionClient | PrismaClient;

/** Ligne d'ingrédient reçue de l'admin : id existant OU nom (nouveau). */
export type IngredientInput = {
  ingredient_id?: string | null;
  name?: string | null;
  // true = enregistrer/réutiliser dans le catalogue global, false = local à ce produit.
  add_to_catalog?: boolean;
  sort_order?: number;
};

/** Ligne de supplément reçue de l'admin : id existant OU nom (nouveau). */
export type SupplementInput = {
  supplement_id?: string | null;
  name?: string | null;
  add_to_catalog?: boolean;
  default_extra_price?: number | null;
  // Surcharge du prix par défaut pour ce produit uniquement.
  extra_price_override?: number | null;
  sort_order?: number;
};

export type ProductIngredientDto = { id: string; name: string; sort_order: number };

/** source 'catalog' = lié au produit (ProductSupplement) ; 'shop' = garniture du commerce. */
export type ProductSupplementDto = {
  id: string;
  name: string;
  // Prix effectif pour ce produit : override > défaut catalogue (niveau produit),
  // extra_price (niveau commerce). 
  extra_price: number;
  default_extra_price: number;
  in_catalog: boolean;
  source: 'catalog' | 'shop';
  image_url?: string | null;
};

/** Garniture shop (sauce / salade) résolue vers le catalogue global. */
export type ShopSauceEntry = { id: string; restaurant_id: string; name: string; image_url: string | null };
export type ShopSaladEntry = { id: string; restaurant_id: string; name: string; image_url: string | null };

/** Garnitures d'un commerce, par restaurant (chargées 1x, jamais en N+1).
 *  Les id sont des id de CATALOGUE global (Sauce/Salad/Supplement). */
export type ShopExtras = {
  supplements: { id: string; restaurant_id: string; name: string; image_url: string | null; extra_price: number; for_fricasse: boolean }[];
  sauces: ShopSauceEntry[];
  salads: ShopSaladEntry[];
};

/** Ingrédients + suppléments d'un produit (triés), pour include Prisma. */
export const productCatalogInclude = {
  ingredients: {
    include: { ingredient: true },
    orderBy: [{ sort_order: 'asc' }, { ingredient: { name: 'asc' } }],
  },
  supplements: {
    include: { supplement: true },
    orderBy: [{ sort_order: 'asc' }, { supplement: { name: 'asc' } }],
  },
} satisfies Prisma.ProductInclude;

type CatalogRowsShape = {
  ingredients?:
    | { ingredient_id: string; sort_order: number; ingredient: { id: string; name: string } }[]
    | null;
  supplements?:
    | {
        supplement_id: string;
        sort_order: number;
        extra_price_override: number | null;
        supplement: { id: string; name: string; default_extra_price: number; in_catalog: boolean; image_url: string | null };
      }[]
    | null;
};

export type ProductWithCatalogs<T extends object> = Omit<T, 'ingredients' | 'supplements'> & {
  ingredients: ProductIngredientDto[];
  supplements: ProductSupplementDto[];
  /** Noms des sauces shop applicables (selon dish_type) — gratuites. */
  sauces: string[];
  /** Noms des salades shop applicables (selon dish_type) — gratuites. */
  salads: string[];
  /** Sauces shop applicables, avec l'image du catalogue (gratuites). */
  sauce_items: { id: string; name: string; image_url: string | null }[];
  /** Salades shop applicables, avec l'image du catalogue (gratuites). */
  salad_items: { id: string; name: string; image_url: string | null }[];
};

/**
 * Charge les garnitures (supplements + sauces + salades) de plusieurs commerces
 * en 3 requêtes parallèles avec jointure du catalogue global (toujours aucun N+1).
 * Renvoie une map restaurant_id -> extras ; absente = commerce sans garniture.
 */
export async function loadShopExtras(
  db: Prisma.TransactionClient | PrismaClient,
  restaurantIds: string[],
): Promise<Map<string, ShopExtras>> {
  const ids = Array.from(new Set(restaurantIds)).filter(Boolean);
  if (ids.length === 0) return new Map();
  const [supplements, sauces, salads] = await Promise.all([
    db.restaurantSupplement.findMany({
      where: { restaurant_id: { in: ids } },
      include: { supplement: true },
      orderBy: [{ sort_order: 'asc' }, { supplement: { name: 'asc' } }],
    }),
    db.restaurantSauce.findMany({
      where: { restaurant_id: { in: ids } },
      include: { sauce: true },
      orderBy: [{ sort_order: 'asc' }, { sauce: { name: 'asc' } }],
    }),
    db.restaurantSalad.findMany({
      where: { restaurant_id: { in: ids } },
      include: { salad: true },
      orderBy: [{ sort_order: 'asc' }, { salad: { name: 'asc' } }],
    }),
  ]);
  const map = new Map<string, ShopExtras>();
  for (const row of supplements) {
    const extras = map.get(row.restaurant_id) ?? { supplements: [], sauces: [], salads: [] };
    extras.supplements.push({
      // id = id global du Supplement du catalogue (même convention que ProductSupplement).
      id: row.supplement.id,
      restaurant_id: row.restaurant_id,
      name: row.supplement.name,
      image_url: row.supplement.image_url,
      extra_price: row.extra_price,
      for_fricasse: row.for_fricasse,
    });
    map.set(row.restaurant_id, extras);
  }
  for (const row of sauces) {
    const extras = map.get(row.restaurant_id) ?? { supplements: [], sauces: [], salads: [] };
    extras.sauces.push({
      id: row.sauce.id,
      restaurant_id: row.restaurant_id,
      name: row.sauce.name,
      image_url: row.sauce.image_url,
    });
    map.set(row.restaurant_id, extras);
  }
  for (const row of salads) {
    const extras = map.get(row.restaurant_id) ?? { supplements: [], sauces: [], salads: [] };
    extras.salads.push({
      id: row.salad.id,
      restaurant_id: row.restaurant_id,
      name: row.salad.name,
      image_url: row.salad.image_url,
    });
    map.set(row.restaurant_id, extras);
  }
  return map;
}

/**
 * Merges shop-level extras into a product DTO: applicable supplements appended
 * (produit gagne sur conflit de nom) + sauces applicables (gratuites).
 * Nécessite product.dish_type et product.restaurant_id.
 */
export function applyShopExtras<T extends object>(
  product: T,
  extras?: ShopExtras,
): ProductWithCatalogs<T> & { flavor?: string | null } {
  const rows = product as T & CatalogRowsShape & { dish_type?: string | null; restaurant_id?: string };
  const dishType = rows.dish_type ?? null;

  const productSupplements: ProductSupplementDto[] = (rows.supplements ?? []).map((row) => ({
    id: row.supplement_id,
    name: row.supplement.name,
    extra_price: row.extra_price_override ?? row.supplement.default_extra_price,
    default_extra_price: row.supplement.default_extra_price,
    in_catalog: row.supplement.in_catalog,
    image_url: row.supplement.image_url,
    source: 'catalog' as const,
  }));

  const shopSupplements = extras
    ? applicableSupplements(dishType, extras.supplements)
        .filter((shop) => !productSupplements.some((p) => sameName(p.name, shop.name)))
        .map((shop) => ({
          id: shop.id,
          name: shop.name,
          extra_price: shop.extra_price,
          default_extra_price: shop.extra_price,
          in_catalog: false,
          image_url: shop.image_url,
          source: 'shop' as const,
        }))
    : [];
  const sauceRows = extras ? applicableSauces(dishType, extras.sauces) : [];
  const saladRows = extras ? applicableSalads(dishType, extras.salads) : [];
  // Noms seuls (contrat client inchangé) + items enrichis (image du catalogue).
  const sauces = sauceRows.map((s) => s.name);
  const salads = saladRows.map((s) => s.name);

  return {
    ...product,
    ingredients: (rows.ingredients ?? []).map((row) => ({
      id: row.ingredient_id,
      name: row.ingredient.name,
      sort_order: row.sort_order,
    })),
    supplements: [...productSupplements, ...shopSupplements],
    sauces,
    salads,
    sauce_items: sauceRows.map((s) => ({ id: s.id, name: s.name, image_url: s.image_url })),
    salad_items: saladRows.map((s) => ({ id: s.id, name: s.name, image_url: s.image_url })),
  } as ProductWithCatalogs<T> & { flavor?: string | null };
}

/** Aplatit les lignes de liaison en DTOs lisibles par l'app (ingrédients + suppléments). */
export function withCatalogs<T extends object>(
  product: T,
  extras?: ShopExtras,
): ProductWithCatalogs<T> {
  return applyShopExtras(product, extras);
}

async function resolveIngredient(tx: Db, row: IngredientInput, adminId?: string): Promise<string | null> {
  if (row.ingredient_id) {
    const existing = await tx.ingredient.findUnique({ where: { id: row.ingredient_id } });
    if (!existing) {
      throw ApiError.badRequest(`Ingredient introuvable : ${row.ingredient_id}`, 'INGREDIENT_NOT_FOUND');
    }
    return existing.id;
  }

  const name = row.name?.trim();
  if (!name) return null;

  const found = await tx.ingredient.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (found) {
    if (row.add_to_catalog && !found.in_catalog) {
      await tx.ingredient.update({ where: { id: found.id }, data: { in_catalog: true } });
    }
    return found.id;
  }

  const created = await tx.ingredient.create({
    data: {
      name,
      in_catalog: row.add_to_catalog ?? false,
      created_by_admin: row.add_to_catalog ? (adminId ?? null) : null,
    },
  });
  return created.id;
}

async function resolveSupplement(tx: Db, row: SupplementInput, adminId?: string): Promise<string | null> {
  if (row.supplement_id) {
    const existing = await tx.supplement.findUnique({ where: { id: row.supplement_id } });
    if (!existing) {
      throw ApiError.badRequest(`Supplement introuvable : ${row.supplement_id}`, 'SUPPLEMENT_NOT_FOUND');
    }
    if (row.add_to_catalog && !existing.in_catalog) {
      await tx.supplement.update({ where: { id: existing.id }, data: { in_catalog: true } });
    }
    return existing.id;
  }

  const name = row.name?.trim();
  if (!name) return null;

  const price = row.default_extra_price ?? row.extra_price_override ?? 0;
  const found = await tx.supplement.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (found) {
    if (row.add_to_catalog && !found.in_catalog) {
      await tx.supplement.update({ where: { id: found.id }, data: { in_catalog: true } });
    }
    return found.id;
  }

  const created = await tx.supplement.create({
    data: {
      name,
      default_extra_price: price,
      in_catalog: row.add_to_catalog ?? false,
      created_by_admin: row.add_to_catalog ? (adminId ?? null) : null,
    },
  });
  return created.id;
}

/**
 * Remplace la liste d'ingrédients d'un produit (undefined = ne pas toucher).
 * Résout chaque ligne : id de catalogue existant ou création/recherche par nom.
 */
export async function syncProductIngredients(
  tx: Db,
  productId: string,
  rows: IngredientInput[] | undefined,
  adminId?: string,
): Promise<void> {
  if (!rows) return;
  await tx.productIngredient.deleteMany({ where: { product_id: productId } });

  const seen = new Set<string>();
  let index = 0;
  for (const row of rows) {
    const ingredientId = await resolveIngredient(tx, row, adminId);
    if (!ingredientId || seen.has(ingredientId)) continue;
    seen.add(ingredientId);
    await tx.productIngredient.create({
      data: { product_id: productId, ingredient_id: ingredientId, sort_order: row.sort_order ?? index },
    });
    index += 1;
  }
}

/** Remplace la liste de suppléments d'un produit (undefined = ne pas toucher). */
export async function syncProductSupplements(
  tx: Db,
  productId: string,
  rows: SupplementInput[] | undefined,
  adminId?: string,
): Promise<void> {
  if (!rows) return;
  await tx.productSupplement.deleteMany({ where: { product_id: productId } });

  const seen = new Set<string>();
  let index = 0;
  for (const row of rows) {
    const supplementId = await resolveSupplement(tx, row, adminId);
    if (!supplementId || seen.has(supplementId)) continue;
    seen.add(supplementId);
    await tx.productSupplement.create({
      data: {
        product_id: productId,
        supplement_id: supplementId,
        extra_price_override: row.extra_price_override ?? null,
        sort_order: row.sort_order ?? index,
      },
    });
    index += 1;
  }
}

/* ------------- Catalogue global des garnitures shop (sauces / salades / supplements) ------------- */

/** Ligne de garniture shop reçue de l'admin : id de catalogue OU nom (find-or-create). */
export type ShopExtraItemInput = { id?: string | null; name?: string | null };

/**
 * Résout (find-or-create) une sauce du catalogue global par son id ou son nom
 * normalisé. Un nom inconnu crée la ligne SANS image — l'import de menu
 * (qui ne connaît que des noms) continue de fonctionner.
 */
export async function resolveCatalogSauce(tx: Db, row: ShopExtraItemInput): Promise<string | null> {
  if (row.id) {
    const existing = await tx.sauce.findUnique({ where: { id: row.id } });
    if (!existing) throw ApiError.badRequest(`Sauce introuvable : ${row.id}`, 'SAUCE_NOT_FOUND');
    return existing.id;
  }
  const name = row.name?.trim();
  if (!name) return null;
  const key = normalizeItemName(name);
  const found = await tx.sauce.findUnique({ where: { name_key: key } });
  if (found) return found.id;
  const created = await tx.sauce.create({ data: { name, name_key: key } });
  return created.id;
}

/** Pareil pour les salades fraîches (gratuites, jamais tarifées). */
export async function resolveCatalogSalad(tx: Db, row: ShopExtraItemInput): Promise<string | null> {
  if (row.id) {
    const existing = await tx.salad.findUnique({ where: { id: row.id } });
    if (!existing) throw ApiError.badRequest(`Salade introuvable : ${row.id}`, 'SALAD_NOT_FOUND');
    return existing.id;
  }
  const name = row.name?.trim();
  if (!name) return null;
  const key = normalizeItemName(name);
  const found = await tx.salad.findUnique({ where: { name_key: key } });
  if (found) return found.id;
  const created = await tx.salad.create({ data: { name, name_key: key } });
  return created.id;
}

/**
 * Pareil pour les suppléments du catalogue global "Supplement" (pas de colonne
 * name_key) : le catalogue est petit, on le charge et on compare les noms
 * normalisés — « Thon » et « thon » ne créent donc jamais deux lignes.
 * Une ligne existante avec in_catalog=false est promue in_catalog=true
 * (elle est désormais une garniture shop => elle doit être visible du
 * catalogue) et son image reste inchangée.
 */
export async function resolveCatalogSupplement(tx: Db, row: ShopExtraItemInput): Promise<string | null> {
  if (row.id) {
    const existing = await tx.supplement.findUnique({ where: { id: row.id } });
    if (!existing) throw ApiError.badRequest(`Supplement introuvable : ${row.id}`, 'SUPPLEMENT_NOT_FOUND');
    return existing.id;
  }
  const name = row.name?.trim();
  if (!name) return null;
  const key = normalizeItemName(name);
  const all = await tx.supplement.findMany();
  const found = all.find((item) => normalizeItemName(item.name) === key);
  if (found) {
    if (!found.in_catalog) {
      await tx.supplement.update({ where: { id: found.id }, data: { in_catalog: true } });
    }
    return found.id;
  }
  const created = await tx.supplement.create({
    data: { name, default_extra_price: 0, in_catalog: true },
  });
  return created.id;
}
