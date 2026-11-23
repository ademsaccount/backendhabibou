/* Vérification : image_url des produits margherita/margarita. */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const rows = await prisma.product.findMany({
  where: {
    OR: [
      { name: { contains: 'margarit', mode: 'insensitive' } },
      { name: { contains: 'margherit', mode: 'insensitive' } },
    ],
  },
  select: { name: true, image_url: true, restaurant: { select: { name: true } } },
});
for (const r of rows) console.log(`${r.name} | ${r.restaurant?.name ?? '—'} | ${r.image_url}`);
await prisma.$disconnect();
