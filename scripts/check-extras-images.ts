import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const sauces = await prisma.sauce.findMany({ orderBy: { name: 'asc' } });
    const salads = await prisma.salad.findMany({ orderBy: { name: 'asc' } });
    const supps = await prisma.supplement.findMany({
      where: { in_catalog: true },
      orderBy: { name: 'asc' },
    });
    const fmt = (rows: { name: string; image_url: string | null }[]) =>
      rows.map((r) => `${r.name} -> ${r.image_url ? 'IMAGE' : 'null'}`);
    console.log('SAUCES:', JSON.stringify(fmt(sauces), null, 1));
    console.log('SALADES:', JSON.stringify(fmt(salads), null, 1));
    console.log('SUPPLEMENTS:', JSON.stringify(fmt(supps), null, 1));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
