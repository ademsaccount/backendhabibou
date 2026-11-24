/**
 * Seed des medias de categories (GIF de l'ecran Restaurants du client habichou).
 *
 * Idempotent : re-jouable sans doublon.
 * - convertit les GIFs locaux via le MEME pipeline que l'upload admin
 *   (lib/media.ts : WebP anime <= 256 px / <= 150 Ko) ;
 * - les envoie sur Supabase Storage (`category-media`, nom immutable <hash>.webp) ;
 * - cree/met a jour les lignes Category (slugs/names/positions identiques a
 *   l'app actuelle : fast_food, burger, pizza, plats) et lie le media ;
 * - meme contenu -> meme hash -> meme ligne MediaAsset (rejeu = no-op).
 *
 * Usage : npm run seed:categories   (necessite db:migrate + SUPABASE_* dans .env)
 *
 * Les GIF sources sont COPIES dans backendHabichou/seed-assets/ (assets du
 * client habichou) pour que le script soit autonome au repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { ensurePublicBucket } from '../src/lib/upload';
import { convertToCategoryWebp, storeCategoryMedia, withMediaQueue } from '../src/lib/media';
import { env } from '../src/config/env';

type Row = { slug: string; file: string | null };

/** Ordre = KNOWN_SPECIALITIES de habichou (src/app/meals/restaurants.tsx). */
const CATEGORIES: Row[] = [
  { slug: 'fast_food', file: null },
  { slug: 'burger', file: 'burger.gif' },
  { slug: 'pizza', file: 'pizza.gif' },
  { slug: 'plats', file: null },
];

/** Libelles = meals.speciality.<slug> des locales du client (source des noms). */
const LOCALES_DIR = path.resolve(__dirname, '../../habichou/locales');
const FALLBACK_NAMES: Record<string, { fr: string; en: string; aeb: string }> = {
  fast_food: { fr: 'Fast food', en: 'Fast food', aeb: 'فاست فود' },
  burger: { fr: 'Burger', en: 'Burgers', aeb: 'برجر' },
  pizza: { fr: 'Pizza', en: 'Pizza', aeb: 'بيتزا' },
  plats: { fr: 'Plats', en: 'Main dishes', aeb: 'أطباق' },
};

function readLocaleNames(): Record<string, { fr: string; en: string; aeb: string }> {
  const out: Record<string, { fr: string; en: string; aeb: string }> = {};
  const files: Record<'fr' | 'en' | 'aeb', string> = {
    fr: path.join(LOCALES_DIR, 'fr.json'),
    en: path.join(LOCALES_DIR, 'en.json'),
    aeb: path.join(LOCALES_DIR, 'aeb.json'),
  };
  try {
    const parsed = Object.fromEntries(
      (Object.keys(files) as Array<'fr' | 'en' | 'aeb'>).map((lang) => [
        lang,
        JSON.parse(fs.readFileSync(files[lang], 'utf8')) as {
          meals: { speciality: Record<string, string> };
        },
      ]),
    ) as Record<'fr' | 'en' | 'aeb', { meals: { speciality: Record<string, string> } }>;
    for (const { slug } of CATEGORIES) {
      out[slug] = {
        fr: parsed.fr.meals.speciality?.[slug] ?? FALLBACK_NAMES[slug].fr,
        en: parsed.en.meals.speciality?.[slug] ?? FALLBACK_NAMES[slug].en,
        aeb: parsed.aeb.meals.speciality?.[slug] ?? FALLBACK_NAMES[slug].aeb,
      };
    }
    return out;
  } catch (err) {
    console.warn(`[seed:categories] locales introuvablees (${LOCALES_DIR}) -> noms de repli`, err);
    return FALLBACK_NAMES;
  }
}

function humanSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} Ko (${bytes} o)`;
}

async function main() {
  const names = readLocaleNames();

  // 1. Bucket public (creable aussi manuellement : Supabase -> Storage).
  await ensurePublicBucket(env.SUPABASE_MEDIA_BUCKET);
  console.log(`[seed:categories] bucket "${env.SUPABASE_MEDIA_BUCKET}" OK`);

  const report: Array<{ slug: string; before: string; after: string; url: string }> = [];

  for (let position = 0; position < CATEGORIES.length; position++) {
    const { slug, file } = CATEGORIES[position];
    const name = names[slug];

    let mediaAssetId: string | null = null;
    let before = '-';
    let after = '-';
    let url = '-';

    if (file) {
      const sourcePath = path.resolve(__dirname, '../seed-assets', file);
      const input = fs.readFileSync(sourcePath);
      before = humanSize(input.length);
      // Meme pipeline que POST /admin/media (queue incluse).
      const image = await withMediaQueue(() => convertToCategoryWebp(input));
      const asset = await storeCategoryMedia(file, image);
      mediaAssetId = asset.id;
      after = humanSize(asset.size_bytes);
      url = asset.public_url;
    }

    const category = await prisma.category.upsert({
      where: { slug },
      update: {
        name_fr: name.fr,
        name_en: name.en,
        name_aeb: name.aeb,
        position,
        media_asset_id: mediaAssetId,
      },
      create: {
        slug,
        name_fr: name.fr,
        name_en: name.en,
        name_aeb: name.aeb,
        position,
        is_active: true,
        media_asset_id: mediaAssetId,
      },
    });

    report.push({ slug: `${category.slug}${mediaAssetId ? '' : ' (sans GIF)'}`, before, after, url });
  }

  console.log('\nCategories (slug | avant | apres | url) :');
  for (const row of report) {
    console.log(`  ${row.slug.padEnd(18)} ${row.before.padEnd(22)} ${row.after.padEnd(22)} ${row.url}`);
  }

  const total = await prisma.mediaAsset.count();
  console.log(`\n[seed:categories] OK — ${report.length} categories, ${total} media(s) en bibliotheque.`);
}

main()
  .catch((err) => {
    console.error('[seed:categories] ECHEC :', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
