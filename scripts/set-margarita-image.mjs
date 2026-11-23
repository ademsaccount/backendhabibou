/* Image « margaritta » : upload de l'asset vers Supabase Storage puis
 * affectation de l'URL publique à TOUT produit pizza margherita/margarita
 * en base (image_url). Dry-run par défaut ; --apply pour écrire.
 *
 * Usage :
 *   node scripts/set-margarita-image.mjs           # aperçu des produits + upload test
 *   node scripts/set-margarita-image.mjs --apply   # upload + écriture en base
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
/* JPEG de la pizza margherita (projet sudo_habichou). */
const IMAGE_PATH = new URL('../../sudo_habichou/assets/margaritta.jpg', import.meta.url);
/* Chemin stable dans le bucket : le fichier est REMPLACÉ à chaque run (upsert),
 * toutes les pizzas margherita pointent vers la même URL. */
const STORAGE_PATH = 'products/margarita.jpg';

/* .env du backend lu à la main (même parse que Prisma : première '='). */
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

const prisma = new PrismaClient();

/** minuscules + accents retirés : margarita / margherita / margaritta... */
function normalize(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
/** Variants acceptés : margarita, margherita, margaritta, margheritta... */
function isMargarita(name) {
  const n = normalize(name);
  return n.includes('margarit') || n.includes('margherit');
}

const candidates = await prisma.product.findMany({
  select: { id: true, name: true, image_url: true, restaurant: { select: { name: true } } },
  orderBy: { name: 'asc' },
});
const products = candidates.filter((p) => isMargarita(p.name));

console.log(`Produits « margherita / margarita » trouvés : ${products.length}`);
for (const p of products) {
  console.log(`  - ${p.name} (${p.restaurant?.name ?? '—'}) — image actuelle : ${p.image_url ?? 'aucune'}`);
}
if (products.length === 0) process.exit(0);

if (!APPLY) {
  console.log('\nDry-run : rien écrit. Relancez avec --apply pour uploader + mettre à jour.');
  await prisma.$disconnect();
  process.exit(0);
}

/* Upload : buffer du JPEG vers products/margarita.jpg (upsert). */
const jpeg = readFileSync(IMAGE_PATH);
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const { error } = await supabase.storage
  .from(bucket)
  .upload(STORAGE_PATH, jpeg, { contentType: 'image/jpeg', upsert: true });
if (error) {
  console.error(`Echec d'upload : ${error.message}`);
  await prisma.$disconnect();
  process.exit(1);
}
const { data } = await supabase.storage.from(bucket).getPublicUrl(STORAGE_PATH);
const url = data.publicUrl;
console.log(`\nUpload OK : ${url}`);

for (const p of products) {
  await prisma.product.update({ where: { id: p.id }, data: { image_url: url } });
  console.log(`  image_url mise à jour : ${p.name}`);
}
console.log(`\n${products.length} produit(s) mis(es) à jour.`);

await prisma.$disconnect();
