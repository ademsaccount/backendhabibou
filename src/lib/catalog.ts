import type { Prisma, PrismaClient } from '@prisma/client';

import { ApiError } from './errors';

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

export type ProductSupplementDto = {
  id: string;
  name: string;
  // Prix effectif pour ce produit : override > défaut catalogue.
  extra_price: number;
  default_extra_price: number;
  in_catalog: boolean;
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
        supplement: { id: string; name: string; default_extra_price: number; in_catalog: boolean };
      }[]
    | null;
};

export type ProductWithCatalogs<T extends object> = Omit<T, 'ingredients' | 'supplements'> & {
  ingredients: ProductIngredientDto[];
  supplements: ProductSupplementDto[];
};

/** Aplatit les lignes de liaison en DTOs lisibles par l'app (ingrédients + suppléments). */
export function withCatalogs<T extends object>(product: T): ProductWithCatalogs<T> {
  const rows = product as T & CatalogRowsShape;
  return {
    ...product,
    ingredients: (rows.ingredients ?? []).map((row) => ({
      id: row.ingredient_id,
      name: row.ingredient.name,
      sort_order: row.sort_order,
    })),
    supplements: (rows.supplements ?? []).map((row) => ({
      id: row.supplement_id,
      name: row.supplement.name,
      extra_price: row.extra_price_override ?? row.supplement.default_extra_price,
      default_extra_price: row.supplement.default_extra_price,
      in_catalog: row.supplement.in_catalog,
    })),
  } as ProductWithCatalogs<T>;
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
