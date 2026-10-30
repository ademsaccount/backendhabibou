import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const counts = await Promise.all([
      prisma.sauce.count(),
      prisma.sauce.count({ where: { image_url: { not: null } } }),
      prisma.salad.count(),
      prisma.salad.count({ where: { image_url: { not: null } } }),
      prisma.supplement.count({ where: { in_catalog: true } }),
      prisma.supplement.count(),
      prisma.restaurantSauce.count(),
      prisma.restaurantSalad.count(),
      prisma.restaurantSupplement.count(),
      prisma.productSupplement.count(),
    ]);
    console.log(JSON.stringify({
      sauces: counts[0],
      sauces_avec_image: counts[1],
      salads: counts[2],
      salads_avec_image: counts[3],
      supplements_in_catalog: counts[4],
      supplements_total: counts[5],
      liens_restaurant_sauce: counts[6],
      liens_restaurant_salade: counts[7],
      liens_restaurant_supplement: counts[8],
      product_supplements: counts[9],
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
