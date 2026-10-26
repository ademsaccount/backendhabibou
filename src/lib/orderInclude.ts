import type { Prisma } from '@prisma/client';

/** Include standard d'une commande detaillee (client, livreur, restaurant, adresse, items, nego, avis, etats par shop). */
export const orderInclude = {
  items: { include: { product: { select: { id: true, name: true, image_url: true, restaurant_id: true } } } },
  restaurant: true,
  address: true,
  livreur: {
    include: { user: { select: { id: true, full_name: true, phone: true, avatar_url: true } } },
  },
  user: { select: { id: true, full_name: true, phone: true, avatar_url: true } },
  custom_request: true,
  review: true,
  /** Pipeline multi-commerces : etat de chaque branche (tap livreur par commerce). */
  shop_statuses: { select: { restaurant_id: true, status: true } },
} satisfies Prisma.OrderInclude;
