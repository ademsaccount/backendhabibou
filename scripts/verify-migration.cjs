// Vérification post-migration : colonne Product.flavor + tables garnitures.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const cols = await prisma.$queryRaw`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'Product' AND column_name = 'flavor')
       OR (table_name IN ('RestaurantSupplement','RestaurantSauce') AND column_name = 'id')
    ORDER BY table_name`;
  console.log(JSON.stringify(cols));
  const c = await prisma.restaurantSupplement.count();
  const s = await prisma.restaurantSauce.count();
  console.log(`RestaurantSupplement: ${c} lignes, RestaurantSauce: ${s} lignes`);
  const flavored = await prisma.product.count({ where: { flavor: { not: null } } });
  console.log(`products avec flavor: ${flavored}`);
})().finally(() => prisma.$disconnect());
