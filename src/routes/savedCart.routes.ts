import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { ApiError, asyncHandler } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createSavedCartSchema, updateSavedCartSchema, idParam } from '../schemas';
import { mergeSupplementEntries } from '../lib/categoryRules';
import {
  MAX_EXTRA_QTY,
  collectCatalogEntries,
  optionDelta,
  parseProductSizes,
} from './order.routes';

const router = Router();
router.use(requireAuth, requireRole('client'));

/** Limites : 20 paniers par user, 1..30 lignes, 1..50 par ligne, nom 1..30. */
const MAX_SAVED_CARTS = 20;
const NAME_MAX = 30;

type SavedCartItemInput = {
  product_id: string;
  quantity: number;
  notes?: string;
  options?: unknown;
  size_label?: string;
};

/** Shape stockee dans SavedCart.items (snapshot autoritaire, cote serveur). */
type StoredItem = {
  product_id: string;
  quantity: number;
  notes: string | null;
  options: unknown;
  size_label: string | null;
  restaurant_id: string;
  restaurant_name: string;
  name: string;
  image_url: string | null;
  /** Prix unitaire AFFICHE au moment de la sauvegarde (informatif — le serveur recalcule tout a la commande). */
  price: number;
};

/**
 * Valide les quantites d'options d'une ligne : TOUT champ `qty` doit etre un
 * entier 1..MAX_EXTRA_QTY, groupes gratuits inclus — meme regle que
 * validateOptionQuantities de /orders (sinon 400 INVALID_QUANTITY).
 */
function assertOptionQuantities(options: unknown): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'qty') {
          if (
            (typeof value === 'number' && (!Number.isInteger(value) || value < 1 || value > MAX_EXTRA_QTY)) ||
            (typeof value !== 'number' && value !== undefined && value !== null)
          ) {
            throw ApiError.badRequest(
              `Quantite invalide (1 a ${MAX_EXTRA_QTY} attendus)`,
              'INVALID_QUANTITY',
            );
          }
        } else if (value && typeof value === 'object') {
          walk(value);
        }
      }
    }
  };
  walk(options);
}

/** Normalise/tranche le nom ("" -> "untitled"). */
function savedName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed.slice(0, NAME_MAX) : 'untitled';
}

/**
 * Reconstruit le snapshot autoritaire des lignes : nom/prix/image/commerce
 * relus depuis la base (le client n'est JAMAIS cru), produit inconnu -> 400
 * PRODUCT_NOT_FOUND, taille inconnue -> 400 SIZE_NOT_FOUND. `price` = prix
 * unitaire affiche pour la ligne (meme formule que order.routes.ts :
 * base (|taille) + optionDelta(options du produit + supplements, options choisies)).
 */
async function buildStoredItems(items: SavedCartItemInput[]): Promise<StoredItem[]> {
  const productIds = [...new Set(items.map((i) => i.product_id))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    include: {
      restaurant: { select: { id: true, name: true } },
      supplements: { include: { supplement: true } },
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const item of items) {
    if (!byId.has(item.product_id)) {
      throw ApiError.badRequest(`Produit introuvable : ${item.product_id}`, 'PRODUCT_NOT_FOUND');
    }
  }

  // Garnitures shop : UNE requete pour tous les commerces impliques.
  const restaurantIds = [...new Set(products.map((p) => p.restaurant_id))];
  const shopSupplementRows = await prisma.restaurantSupplement.findMany({
    where: { restaurant_id: { in: restaurantIds } },
    include: { supplement: { select: { name: true } } },
  });
  const shopSuppsByRestaurant = new Map<string, { name: string; for_fricasse: boolean; extra_price: number }[]>();
  for (const row of shopSupplementRows) {
    const list = shopSuppsByRestaurant.get(row.restaurant_id) ?? [];
    list.push({ name: row.supplement.name, for_fricasse: row.for_fricasse, extra_price: row.extra_price });
    shopSuppsByRestaurant.set(row.restaurant_id, list);
  }

  return items.map((item) => {
    const product = byId.get(item.product_id)!;
    assertOptionQuantities(item.options);

    const sizes = parseProductSizes(product.sizes);
    let basePrice = product.price;
    if (item.size_label) {
      const found = sizes.find((entry) => entry.label === item.size_label);
      if (!found) throw ApiError.badRequest(`Taille inconnue : ${item.size_label}`, 'SIZE_NOT_FOUND');
      // Une seule taille enregistree : sizes ignore pour le prix (price = verite).
      if (sizes.length >= 2) basePrice = found.price;
    }

    const catalog: { name: string; price: number }[] = [];
    collectCatalogEntries(product.options, catalog);
    // Suppléments produit + garnitures shop applicables au dish_type (prix serveur).
    catalog.push(
      ...mergeSupplementEntries(
        product.dish_type,
        shopSuppsByRestaurant.get(product.restaurant_id) ?? [],
        product.supplements.map((row) => ({
          name: row.supplement.name,
          price: row.extra_price_override ?? row.supplement.default_extra_price,
        })),
      ),
    );
    const unit = basePrice + optionDelta(catalog, item.options);

    return {
      product_id: product.id,
      quantity: item.quantity,
      notes: item.notes ?? null,
      options: item.options ?? null,
      size_label: item.size_label ?? null,
      restaurant_id: product.restaurant_id,
      restaurant_name: product.restaurant?.name ?? 'Commerce',
      name: product.name,
      image_url: product.image_url ?? null,
      price: unit,
    };
  });
}

/** DTO de ligne enfin enrichi (produit + commerce relus en base). */
type SavedCartItemDTO = {
  product_id: string;
  quantity: number;
  size_label: string | null;
  options: unknown;
  notes: string | null;
  name: string;
  image_url: string | null;
  flavor: string | null;
  restaurant_id: string;
  restaurant_name: string;
  restaurant_logo_url: string | null;
  /** Prix unitaire au moment de la sauvegarde (informatif). */
  price: number;
  /** Prix actuel du produit+tailles+supplements recalculé serveur (indéfini : produit disparu). */
  current_price: number | null;
  /** Produit existant ET is_available. */
  available: boolean;
};

type SavedCartDTO = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  items: SavedCartItemDTO[];
  /** Σ (current_price ?? price) × qty sur les lignes disponibles. */
  total: number;
};

/**
 * Enrichissement DTO batche pour UN ensemble de paniers (aucun N+1) :
 * available/current_price/restaurant_logo_url relus en base,
 * current_price = MEME formule que buildStoredItems / order.routes.ts.
 */
async function toDTOs(
  carts: { id: string; name: string; created_at: Date; updated_at: Date; items: unknown }[],
): Promise<SavedCartDTO[]> {
  // 1) Tous les product_ids de tous les paniers.
  const ids = new Set<string>();
  for (const cart of carts) {
    const raw = Array.isArray(cart.items) ? (cart.items as Record<string, unknown>[]) : [];
    for (const item of raw) {
      const pid = (item as { product_id?: unknown })?.product_id;
      if (typeof pid === 'string') ids.add(pid);
    }
  }
  const products = ids.size
    ? await prisma.product.findMany({
        where: { id: { in: [...ids] } },
        include: {
          restaurant: { select: { id: true, name: true, logo_url: true, is_open: true } },
          supplements: { include: { supplement: { select: { name: true, default_extra_price: true } } } },
        },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  // Garnitures shop : UNE requete pour tous les commerces impliques.
  const restaurantIds = [...new Set(products.map((p) => p.restaurant_id))];
  const shopSupplementRows = restaurantIds.length
    ? await prisma.restaurantSupplement.findMany({
        where: { restaurant_id: { in: restaurantIds } },
        include: { supplement: { select: { name: true } } },
      })
    : [];
  const shopSuppsByRestaurant = new Map<string, { name: string; for_fricasse: boolean; extra_price: number }[]>();
  for (const row of shopSupplementRows) {
    const list = shopSuppsByRestaurant.get(row.restaurant_id) ?? [];
    list.push({ name: row.supplement.name, for_fricasse: row.for_fricasse, extra_price: row.extra_price });
    shopSuppsByRestaurant.set(row.restaurant_id, list);
  }

  const unitFor = (item: Record<string, unknown>, product: (typeof products)[number]): number | null => {
    const options = item.options ?? null;
    const sizeLabel = item.size_label;
    if (sizeLabel != null && typeof sizeLabel !== 'string') return null;
    const sizes = parseProductSizes(product.sizes);
    let basePrice = product.price;
    if (sizeLabel) {
      const found = sizes.find((entry) => entry.label === sizeLabel);
      if (!found) return null; // taille supprimée du produit depuis la sauvegarde
      if (sizes.length >= 2) basePrice = found.price;
    }
    const catalog: { name: string; price: number }[] = [];
    collectCatalogEntries(product.options, catalog);
    catalog.push(
      ...mergeSupplementEntries(
        product.dish_type,
        shopSuppsByRestaurant.get(product.restaurant_id) ?? [],
        product.supplements.map((row) => ({
          name: row.supplement.name,
          price: row.extra_price_override ?? row.supplement.default_extra_price,
        })),
      ),
    );
    return basePrice + optionDelta(catalog, options);
  };

  return carts.map((cart) => {
    const raw = Array.isArray(cart.items) ? (cart.items as Record<string, unknown>[]) : [];
    const items: SavedCartItemDTO[] = raw.map((item) => {
      const product = typeof item.product_id === 'string' ? productById.get(item.product_id) : undefined;
      const snapshotPrice = typeof item.price === 'number' ? item.price : 0;
      const current = product ? unitFor(item, product) : null;
      return {
        product_id: String(item.product_id ?? ''),
        quantity: typeof item.quantity === 'number' ? item.quantity : 0,
        size_label: typeof item.size_label === 'string' ? item.size_label : null,
        options: item.options ?? null,
        notes: typeof item.notes === 'string' ? item.notes : null,
        name: typeof item.name === 'string' ? item.name : (product?.name ?? ''),
        image_url: typeof item.image_url === 'string' ? item.image_url : null,
        flavor: product?.flavor ?? null,
        restaurant_id: product?.restaurant_id ?? String(item.restaurant_id ?? ''),
        restaurant_name: product?.restaurant?.name ?? String(item.restaurant_name ?? ''),
        restaurant_logo_url: product?.restaurant?.logo_url ?? null,
        price: snapshotPrice,
        current_price: current,
        available: !!product && product.is_available,
      };
    });
    return {
      id: cart.id,
      name: cart.name,
      created_at: cart.created_at.toISOString(),
      updated_at: cart.updated_at.toISOString(),
      items,
      total: items
        .filter((item) => item.available)
        .reduce((sum, item) => sum + (item.current_price ?? item.price) * item.quantity, 0),
    };
  });
}

const ownership = async (id: string, userId: string) => {
  const cart = await prisma.savedCart.findUnique({ where: { id } });
  if (!cart || cart.user_id !== userId) {
    throw ApiError.notFound('Panier sauvegarde introuvable', 'SAVED_CART_NOT_FOUND');
  }
  return cart;
};

/* --------------------------- Routes --------------------------- */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const carts = await prisma.savedCart.findMany({
      where: { user_id: req.user!.id },
      orderBy: { updated_at: 'desc' },
    });
    res.json(await toDTOs(carts));
  }),
);

router.post(
  '/',
  validate(createSavedCartSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as { name?: string; items: SavedCartItemInput[] };
    const count = await prisma.savedCart.count({ where: { user_id: req.user!.id } });
    if (count >= MAX_SAVED_CARTS) {
      throw ApiError.conflict('Maximum de paniers sauvegardes atteint', 'SAVED_CART_LIMIT');
    }
    const stored = await buildStoredItems(body.items);
    const created = await prisma.savedCart.create({
      data: { user_id: req.user!.id, name: savedName(body.name), items: stored as object },
    });
    const [dto] = await toDTOs([
      { id: created.id, name: created.name, created_at: created.created_at, updated_at: created.updated_at, items: stored },
    ]);
    res.status(201).json(dto);
  }),
);

router.put(
  '/:id',
  validate(updateSavedCartSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated?.body as { name?: string; items?: SavedCartItemInput[] };
    const cart = await ownership(req.params.id, req.user!.id);
    const stored = body.items ? await buildStoredItems(body.items) : cart.items;
    const updated = await prisma.savedCart.update({
      where: { id: cart.id },
      data: {
        ...(body.name !== undefined ? { name: savedName(body.name) } : {}),
        ...(body.items ? { items: stored as object } : {}),
      },
    });
    const [dto] = await toDTOs([updated]);
    res.json(dto);
  }),
);

router.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const cart = await ownership(req.params.id, req.user!.id);
    await prisma.savedCart.delete({ where: { id: cart.id } });
    res.status(204).send();
  }),
);

export default router;
