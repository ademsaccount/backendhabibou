/* Images pizzas : upload des assets sudo_habichou vers Supabase Storage puis
 * affectation de l'URL publique aux produits PIZZA correspondants (les noms
 * des produits existent en fr et en ang — les deux sont reliés par mots-clés
 * insensibles casse/accents). Dry-run par défaut ; --apply pour écrire.
 *
 * Usage :
 *   node scripts/set-pizza-images.mjs           # aperçu des rapprochements
 *   node scripts/set-pizza-images.mjs --apply   # upload + écriture en base
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');

/* .env du backend lu à la main (première '=' par ligne). */
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const envs = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);
const supabaseUrl = envs.SUPABASE_URL ?? '';
const supabaseKey = envs.SUPABASE_SERVICE_ROLE_KEY ?? '';
const bucket = envs.SUPABASE_STORAGE_BUCKET || 'habichou';
if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents du .env — upload impossible.');
  process.exit(1);
}

/** minuscules + accents retirés + espaces/dashes réduits. */
function normalize(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-_''.]+/g, ' ')
    .trim();
}

/* Un fichier image = un « type » de pizza ; chaque entrée liste le fichier
 * asset, le chemin stable dans le bucket et les MOTS-CLÉS (fr/ang) qui
 * identifient les produits concernés. Seuls les produits de catégorie
 * PIZZA sont touchés (un « Makloub Pepperoni » n'est pas une pizza). */
const IMAGES = [
  {
    file: '02_Pepperoni.png',
    storagePath: 'products/pepperoni.png',
    keywords: ['pepperoni'],
  },
  {
    file: '04_Veggie.png',
    storagePath: 'products/veggie.png',
    keywords: ['vegetarien', 'veggie', 'vegan'],
  },
  {
    file: '05_BBQ_Chicken (1).png',
    storagePath: 'products/bbq-chicken.png',
    keywords: ['bbq', 'barbecue'],
  },
  {
    file: '07_Four_Cheese (1).png',
    storagePath: 'products/four-cheese.png',
    keywords: ['4 fromage', 'quatre fromage', 'four cheese', '4 cheese'],
  },
  {
    file: '10_Neptune (2).png',
    storagePath: 'products/neptune.png',
    keywords: ['neptune'],
  },
  {
    file: '11_Mexicana.png',
    storagePath: 'products/mexicana.png',
    keywords: ['mexica'],
  },
  {
    file: '12_Mushroom.png',
    storagePath: 'products/mushroom.png',
    keywords: ['champignon', 'funghi', 'mushroom'],
  },
  {
    file: '4saison.png',
    storagePath: 'products/4saison.png',
    keywords: ['4 saison', 'quatre saison', '4 seasons', 'four seasons'],
  },
];

const prisma = new PrismaClient();
const products = await prisma.product.findMany({
  select: { id: true, name: true, image_url: true, dish_type: true, category: true, restaurant: { select: { name: true } } },
});
/* Pizza = clé de regroupement dish_type ?? category vaut « pizza ». */
const pizzas = products.filter((p) => normalize(p.dish_type ?? p.category ?? '') === 'pizza');
console.log(`Produits pizza en base : ${pizzas.length}`);

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const updates = []; // { productId, name, url }

for (const image of IMAGES) {
  const matched = pizzas.filter((p) => {
    const n = normalize(p.name);
    return image.keywords.some((k) => n.includes(normalize(k)));
  });
  console.log(`\n${image.file} → ${image.storagePath} : ${matched.length} produit(s)`);
  for (const p of matched) {
    console.log(`  - ${p.name} (${p.restaurant?.name ?? '—'}) — image actuelle : ${p.image_url ?? 'aucune'}`);
    updates.push({ productId: p.id, name: p.name, storagePath: image.storagePath });
  }
  if (matched.length === 0) console.log('  (aucun produit correspondant)');
}

if (!APPLY) {
  console.log('\nDry-run : rien écrit. Relancez avec --apply pour uploader + mettre à jour.');
  await prisma.$disconnect();
  process.exit(0);
}

/* Upload une seule fois par fichier (les produits partagent l'URL). */
const urls = new Map();
for (const image of IMAGES) {
  if (!updates.some((u) => u.storagePath === image.storagePath)) continue;
  const buffer = readFileSync(new URL(`../../sudo_habichou/assets/${image.file}`, import.meta.url));
  const { error } = await supabase.storage
    .from(bucket)
    .upload(image.storagePath, buffer, { contentType: 'image/png', upsert: true });
  if (error) {
    console.error(`Echec d'upload ${image.file} : ${error.message}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const { data } = await supabase.storage.from(bucket).getPublicUrl(image.storagePath);
  /* Cache-buster : même chemin stable, mais l'URL change à chaque run → les
   * clients (cache expo-image par URL) rechargent la version plus nette. */
  urls.set(image.storagePath, `${data.publicUrl}?v=${Date.now()}`);
  console.log(`Upload OK : ${image.file} → ${urls.get(image.storagePath)}`);
}

for (const u of updates) {
  await prisma.product.update({ where: { id: u.productId }, data: { image_url: urls.get(u.storagePath) } });
  console.log(`  image_url mise à jour : ${u.name}`);
}
console.log(`\n${updates.length} produit(s) mis(es) à jour.`);
await prisma.$disconnect();
