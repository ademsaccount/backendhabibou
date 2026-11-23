/* Liste de tous les produits (nom + commerce + image actuelle) pour le
 * rapprochement images ↔ produits. */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const rows = await prisma.product.findMany({
  select: {
    name: true,
    image_url: true,
    category: true,
    dish_type: true,
    restaurant: { select: { name: true, category: true } },
  },
  orderBy: [{ restaurant: { name: 'asc' } }, { name: 'asc' }],
});
for (const r of rows) {
  const img = r.image_url ? r.image_url.split('/').pop() : '—';
  console.log(`${r.restaurant?.name ?? '—'} | ${r.name} | cat=${r.dish_type ?? r.category ?? ''} | ${img}`);
}
await prisma.$disconnect();
