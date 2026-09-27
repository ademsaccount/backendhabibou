import { z } from 'zod';

export const idParam = z.object({ id: z.string().min(1) });

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const registerSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().regex(emailRe, 'Email invalide'),
    password: z.string().min(8, 'Mot de passe : 8 caracteres minimum'),
    full_name: z.string().trim().min(2, 'Nom complet requis'),
    phone: z.string().trim().min(6).optional(),
    // --- DÉSACTIVÉ : plus de compte livreur (l'admin fait office de livreur unique) ---
    // role: z.enum(['client', 'livreur']).optional(),
    role: z.enum(['client']).optional(),
    // --- FIN DÉSACTIVÉ ---
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().regex(emailRe, 'Email invalide'),
    password: z.string().min(1, 'Mot de passe requis'),
  }),
});

export const refreshSchema = z.object({
  body: z.object({ refresh_token: z.string().min(10, 'Refresh token requis') }),
});

export const restaurantsQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  category: z.enum(['restaurant', 'snack', 'epicerie', 'pharmacie', 'tabac']).optional(),
  q: z.string().trim().min(1).optional(),
});

/** Filtres du catalogue produits (flux Repas / Épicerie / Pharmacie). */
export const productsQuery = z.object({
  // "Par type de plat" : Makloub, Pizza, Fricassé...
  dish_type: z.string().trim().min(1).optional(),
  // Épicerie : produits des commerces de catégorie épicerie
  flow: z.enum(['epicerie', 'pharmacie']).optional(),
  // Pharmacie : produits rattachés à une catégorie de médicaments
  medication_category_id: z.string().trim().min(1).optional(),
  restaurant_id: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

export const createAddressSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1, 'Label requis'),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    address_text: z.string().trim().min(3, 'Adresse requise'),
    is_default: z.boolean().optional(),
  }),
});

export const updateAddressSchema = z.object({
  params: idParam,
  body: z.object({
    label: z.string().trim().min(1).optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    address_text: z.string().trim().min(3).optional(),
    is_default: z.boolean().optional(),
  }),
});

/* ------------- Demandes spécifiques ("Demande spécifique" côté client) ------------- */
export const createCustomRequestSchema = z.object({
  body: z.object({
    description_text: z.string().trim().min(5, 'Decrivez votre besoin (5 caracteres min)'),
    photo_url: z.string().min(1).optional(),
    estimated_budget: z.coerce.number().min(0).optional(),
    address_id: z.string().min(1, 'Adresse requise'),
  }),
});

export const quoteSchema = z.object({
  params: idParam,
  body: z.object({ admin_quote_price: z.coerce.number().positive('Prix positif requis') }),
});
// --- FIN DÉSACTIVÉ ---

export const createOrderSchema = z.object({
  body: z
    .object({
      address_id: z.string().min(1, 'Adresse requise'),
      payment_method: z.enum(['card', 'cash']).default('cash'),
      // Commande issue d'une "Demande spécifique" acceptée (devis admin).
      custom_request_id: z.string().optional(),
      items: z
        .array(
          z.object({
            product_id: z.string().min(1),
            quantity: z.number().int().min(1).max(50),
            notes: z.string().max(300).optional(),
            options: z.unknown().optional(),
          }),
        )
        .min(1)
        .optional(),
    })
    .refine((d) => Boolean(d.custom_request_id) || Boolean(d.items?.length), {
      message: 'items ou custom_request_id requis',
      path: ['items'],
    }),
});

export const rateOrderSchema = z.object({
  params: idParam,
  body: z.object({
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
  }),
});

export const orderStatusSchema = z.object({
  params: idParam,
  body: z.object({ status: z.enum(['picked_up', 'on_the_way', 'delivered']) }),
});

export const adminOrderStatusSchema = z.object({
  params: idParam,
  body: z.object({
    status: z.enum(['confirmed', 'preparing', 'picked_up', 'on_the_way', 'delivered', 'cancelled']),
  }),
});

// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
export const assignSchema = z.object({
  params: idParam,
  body: z.object({
    livreur_id: z.string().min(1).optional(),
    auto: z.boolean().optional(),
  }),
});
// --- FIN DÉSACTIVÉ ---

export const locationSchema = z.object({
  body: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    order_id: z.string().optional(),
  }),
});

export const orderStatusFilterQuery = z.object({
  status: z
    .enum(['all', 'pending', 'confirmed', 'preparing', 'picked_up', 'on_the_way', 'delivered', 'cancelled'])
    .optional(),
});

export const customRequestStatusFilterQuery = z.object({
  status: z.enum(['all', 'pending', 'quoted', 'accepted', 'rejected']).optional(),
});

/** Horaires simples "HH:MM" (24h) — consommes par l'app client : { open, close }. */
export const openingHoursSchema = z.object({
  open: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Heure d'ouverture au format HH:MM"),
  close: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Heure de fermeture au format HH:MM"),
});

export const createRestaurantSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2),
    category: z.enum(['restaurant', 'snack', 'epicerie', 'pharmacie', 'tabac']),
    description: z.string().trim().max(1000).optional(),
    logo_url: z.string().min(1).nullable().optional(),
    cover_url: z.string().min(1).nullable().optional(),
    address: z.string().trim().min(3),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    is_open: z.boolean().optional(),
    opening_hours: openingHoursSchema.nullable().optional(),
  }),
});

export const updateRestaurantSchema = z.object({
  params: idParam,
  body: createRestaurantSchema.shape.body.partial(),
});

/** Ingrédient d'un plat : id de catalogue existant OU nouveau nom. */
export const ingredientInput = z
  .object({
    ingredient_id: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1).nullable().optional(),
    // true = enregistrer dans le catalogue global réutilisable, false = local au produit.
    add_to_catalog: z.boolean().optional(),
    sort_order: z.coerce.number().int().optional(),
  })
  .refine((d) => Boolean(d.ingredient_id) || Boolean(d.name), {
    message: 'ingredient_id ou name requis',
    path: ['name'],
  });

/** Supplément d'un plat (ajout optionnel payant) : id de catalogue OU nouveau nom. */
export const supplementInput = z
  .object({
    supplement_id: z.string().trim().min(1).nullable().optional(),
    name: z.string().trim().min(1).nullable().optional(),
    add_to_catalog: z.boolean().optional(),
    // Prix par défaut du catalogue pour un nouveau supplément.
    default_extra_price: z.coerce.number().min(0).nullable().optional(),
    // Surcharge du prix pour CE produit (null = prix catalogue).
    extra_price_override: z.coerce.number().min(0).nullable().optional(),
    sort_order: z.coerce.number().int().optional(),
  })
  .refine((d) => Boolean(d.supplement_id) || Boolean(d.name), {
    message: 'supplement_id ou name requis',
    path: ['name'],
  });

export const createProductSchema = z.object({
  params: idParam,
  body: z.object({
    name: z.string().trim().min(2),
    description: z.string().trim().max(1000).optional(),
    price: z.coerce.number().min(0),
    image_url: z.string().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    dish_type: z.string().trim().min(1).nullable().optional(),
    medication_category_id: z.string().trim().min(1).nullable().optional(),
    is_available: z.boolean().optional(),
    options: z.unknown().optional(),
    ingredients: z.array(ingredientInput).max(80).optional(),
    supplements: z.array(supplementInput).max(80).optional(),
  }),
});

export const updateProductSchema = z.object({
  params: idParam,
  body: z
    .object({
      name: z.string().trim().min(2).optional(),
      description: z.string().trim().max(1000).optional(),
      price: z.coerce.number().min(0).optional(),
      image_url: z.string().min(1).nullable().optional(),
      category: z.string().trim().min(1).optional(),
      dish_type: z.string().trim().min(1).nullable().optional(),
      medication_category_id: z.string().trim().min(1).nullable().optional(),
      is_available: z.boolean().optional(),
      options: z.unknown().nullable().optional(),
      ingredients: z.array(ingredientInput).max(80).optional(),
      supplements: z.array(supplementInput).max(80).optional(),
    }),
});

/* ------------- Catalogues globaux (ingrédients / suppléments) — admin ------------- */

export const createIngredientSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Nom requis'),
    in_catalog: z.boolean().optional(),
  }),
});

export const createSupplementSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Nom requis'),
    default_extra_price: z.coerce.number().min(0).optional(),
    in_catalog: z.boolean().optional(),
  }),
});

/* ------------- Catégories de médicaments (flux Pharmacie, admin) ------------- */

export const createMedicationCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(2),
    description: z.string().trim().max(300).optional(),
    icon: z.string().trim().max(60).optional(),
    sort_order: z.coerce.number().int().optional(),
    is_active: z.boolean().optional(),
  }),
});

export const updateMedicationCategorySchema = z.object({
  params: idParam,
  body: createMedicationCategorySchema.shape.body.partial(),
});

// --- DÉSACTIVÉ : gestion de plusieurs livreurs (l'admin fait office de livreur unique) ---
export const updateLivreurSchema = z.object({
  params: idParam,
  body: z.object({
    is_online: z.boolean().optional(),
    vehicle_type: z.string().trim().min(2).optional(),
  }),
});
// --- FIN DÉSACTIVÉ ---

/* ------------- Push notifications (app sudo_habichou) ------------- */

// push_token: null = désinscription du jeton.
export const pushTokenSchema = z.object({
  body: z.object({
    push_token: z.string().trim().min(1).max(300).nullable(),
  }),
});
