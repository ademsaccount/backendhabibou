import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PrismaClient } from '@prisma/client';

import { normalizeItemName } from '../src/lib/categoryRules';
import { uploadBuffer } from '../src/lib/upload';

/* --------------------------------------------------------------------------- *
 *  import-extras-images — import en masse des images du catalogue garnitures.  *
 *                                                                              *
 *  Dossiers lus : scripts/extras-images/{sauces,salads,supplements}            *
 *    - chaque .png / .jpg / .jpeg / .webp => une ligne du catalogue global      *
 *      (Sauce / Salad / Supplement), trouvee ou creee par NOM NORMALISE        *
 *      (casse/accents/espaces ignores — cf. categoryRules.normalizeItemName)   *
 *    - slug = nom de fichier sans extension ; nom affiché = names.json         *
 *      (slug -> nom) du même dossier si présent, sinon lisez-moi :             *
 *      « harissa » -> « Harissa », « salade-mechwia » -> « Salade mechwia ».    *
 *                                                                              *
 *  Stockage : MEME bucket que la route /uploads, chemin STABLE                 *
 *      extras/<type>/<slug>.<ext>  — un re-run REMPLACE l'image (upsert) et    *
 *      pose un cache-buster « ?v=<mtime> » sur l'URL publique.                 *
 *                                                                              *
 *  Idempotent : rejouable autant de fois que voulu.                            *
 *  Flags : --dry-run (n'ecrit rien, imprime le plan) | --seed-defaults          *
 *          (cree les garnitures SANS image) | --yes (accepte sans confirmer).  *
 * --------------------------------------------------------------------------- */

type CatalogType = 'sauces' | 'salads' | 'supplements';

const ALLOWED_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Taille max "raisonnable" d'une vignette : au-dela, simple avertissement. */
const MAX_SIZE_BYTES = 300 * 1024;

/** Tolerance sur le ratio (1.0 = carre exact). */
const SQUARE_TOLERANCE = 0.05;

/** Garnitures par defaut creees par --seed-defaults (SANS image). */
const DEFAULTS: Record<CatalogType, readonly string[]> = {
  sauces: [
    'Harissa',
    'Mayonnaise',
    'Ketchup',
    'Sauce blanche',
    'Algérienne',
    'Barbecue',
    'Biggy',
    'Samouraï',
    'Fromagère',
  ],
  salads: ['Laitue', 'Tomate', 'Oignon', 'Concombre'],
  supplements: [
    'Thon',
    'Escalope',
    'Kwika',
    'Salami',
    'Œuf',
    'Œuf frit',
    'Fromage triangle',
    'Mozzarella',
    'Zitoun',
    'Jambon',
    'Champignon',
    'Pepperoni',
    'Chawarma',
    'Cordon bleu',
    'Frites',
  ],
};

type Summary = { created: number; updated: number; skipped: number; warnings: number };
const summary: Summary = { created: 0, updated: 0, skipped: 0, warnings: 0 };

const warn = (message: string) => {
  console.warn(`  ! avertissement : ${message}`);
  summary.warnings += 1;
};

/* ---------------- Dimensions PNG / JPEG / WEBP sans dependance ---------------- */

function sniffDimensions(buf: Buffer): { w: number; h: number } | null {
  // PNG : IHDR à offset fixe.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG : recherche du marqueur SOF (hauteur/largeur).
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1];
      // marqueurs sans longueur : SOI/RST
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 && // DHT
        marker !== 0xc8 && // JPG
        marker !== 0xcc // DAC
      ) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      off += 2 + len;
    }
    return null;
  }
  // WEBP : RIFF....WEBP + chunk VP8 / VP8L / VP8X.
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    return null;
  }
  return null;
}

/* ------------------------------ Divers utiles ------------------------------- */

/** « harissa » -> « Harissa », « salade-mechwia » -> « Salade mechwia ». */
function prettifySlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function databaseHost(): string {
  const url = process.env.DATABASE_URL ?? '';
  try {
    return new URL(url).host;
  } catch {
    return 'inconnu';
  }
}

/* --------------------------------- Main ------------------------------------ */

async function confirm(dryRun: boolean, yes: boolean): Promise<boolean> {
  if (dryRun || yes) return true;
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("\nEcrire dans la base ci-dessus ? (oui/non) ");
  rl.close();
  return /^(o|oui|y|yes)\s*$/i.test(answer.trim());
}

/** Trouve ou cree une ligne de catalogue par nom normalise. */
async function findOrCreate(
  prisma: PrismaClient,
  type: CatalogType,
  name: string,
): Promise<{ id: string; created: boolean }> {
  if (type === 'supplements') {
    // Pas de colonne name_key : le catalogue est petit, comparaison en code.
    const key = normalizeItemName(name);
    const all = await prisma.supplement.findMany();
    const found = all.find((row) => normalizeItemName(row.name) === key);
    if (found) return { id: found.id, created: false };
    const created = await prisma.supplement.create({
      data: { name, default_extra_price: 0, in_catalog: true },
    });
    return { id: created.id, created: true };
  }
  const db = type === 'sauces' ? prisma.sauce : prisma.salad;
  const key = normalizeItemName(name);
  const existing = await db.findUnique({ where: { name_key: key } });
  if (existing) return { id: existing.id, created: false };
  const created = await db.create({ data: { name, name_key: key } });
  return { id: created.id, created: true };
}

/** Pose image_url sur la ligne (les sauces/salades gardent leur nom canonique). */
async function setImage(
  prisma: PrismaClient,
  type: CatalogType,
  id: string,
  imageUrl: string | null,
): Promise<void> {
  if (imageUrl === null) {
    // --seed-defaults : ne touche jamais une image existante.
    return;
  }
  if (type === 'sauces') await prisma.sauce.update({ where: { id }, data: { image_url: imageUrl } });
  else if (type === 'salads') await prisma.salad.update({ where: { id }, data: { image_url: imageUrl } });
  else await prisma.supplement.update({ where: { id }, data: { image_url: imageUrl } });
}

async function importFiles(prisma: PrismaClient, dryRun: boolean): Promise<void> {
  const baseDir = join(__dirname, 'extras-images');
  for (const type of ['sauces', 'salads', 'supplements'] as CatalogType[]) {
    console.log(`\n— ${type} —`);
    let overrides: Record<string, string> = {};
    let files: string[] = [];
    const dir = join(baseDir, type);
    try {
      const entries = readdirSync(dir);
      overrides = (() => {
        try {
          return JSON.parse(readFileSync(join(dir, 'names.json'), 'utf8')) as Record<string, string>;
        } catch {
          return {};
        }
      })();
      files = entries.filter((entry) => ALLOWED_EXT[extname(entry).toLowerCase()]);
    } catch {
      console.log('  (dossier absent ou illisible : ignore)');
      continue;
    }

    if (files.length === 0 && Object.keys(overrides).length === 0) {
      console.log('  (aucune image)');
      continue;
    }

    for (const file of files) {
      const ext = extname(file).toLowerCase();
      const slug = file.slice(0, file.length - ext.length);
      const displayName = overrides[slug] ?? prettifySlug(slug);
      const mime = ALLOWED_EXT[ext];

      let buffer: Buffer;
      try {
        buffer = await readFile(join(dir, file));
      } catch {
        warn(`${type}/${file} : fichier illisible — ignoré.`);
        summary.skipped += 1;
        continue;
      }
      if (buffer.length > MAX_SIZE_BYTES) {
        warn(`${type}/${file} : ${(buffer.length / 1024).toFixed(0)} Ko > 300 Ko (importé quand même).`);
      }
      const dims = sniffDimensions(buffer);
      if (!dims) {
        warn(`${type}/${file} : dimensions non décodables (PNG/JPEG/WEBP invalide ?) — importé quand même.`);
      } else {
        const ratio = dims.w / Math.max(dims.h, 1);
        if (Math.abs(ratio - 1) > SQUARE_TOLERANCE) {
          warn(`${type}/${file} : pas carré (${dims.w}x${dims.h}) — importé quand même.`);
        }
      }

      // Chemin STABLE : re-run == remplacement dans le bucket (upsert).
      const stablePath = `extras/${type}/${slug}${ext}`;
      const cacheBuster = `v=${Math.round(statSync(join(dir, file)).mtimeMs)}`;

      let uploadedUrl: string | null = null;
      if (dryRun) {
        uploadedUrl = null; // plan seulement
      } else {
        try {
          const rawUrl = await uploadBuffer(buffer, mime, 'extras', stablePath);
          // Cache-buster : la réécriture du fichier ne change pas l'URL publique.
          uploadedUrl = rawUrl.includes('?') ? `${rawUrl}&${cacheBuster}` : `${rawUrl}?${cacheBuster}`;
        } catch (error) {
          warn(`${type}/${file} : échec d'upload (${error instanceof Error ? error.message : String(error)}) — ignoré.`);
          summary.skipped += 1;
          continue;
        }
      }

      // Trouver ou créer la ligne puis poser l'image (create-or-update).
      if (dryRun) {
        console.log(`  [dry-run] ${type}/${file} -> nom="${displayName}" chemin=${stablePath}`);
        summary.skipped += 1;
        continue;
      }
      try {
        const { id, created } = await findOrCreate(prisma, type, displayName);
        if (created) {
          summary.created += 1;
        }
        await setImage(prisma, type, id, uploadedUrl);
        summary.updated += 1;
        console.log(
          `  ${created ? 'créé' : 'à jour'} : ${displayName} (${type}/${file})${uploadedUrl ? '' : ' [seed sans image]'}`,
        );
      } catch (error) {
        warn(`${type}/${file} : échec DB (${error instanceof Error ? error.message : String(error)}) — ignoré.`);
        summary.skipped += 1;
      }
    }
  }
}

async function seedDefaults(prisma: PrismaClient, dryRun: boolean): Promise<void> {
  console.log('\n— seed-defaults (garnitures sans image) —');
  for (const type of ['sauces', 'salads', 'supplements'] as CatalogType[]) {
    for (const name of DEFAULTS[type]) {
      if (dryRun) {
        console.log(`  [dry-run] ${type} : ${name}`);
        continue;
      }
      try {
        const { id, created } = await findOrCreate(prisma, type, name);
        // Un re-run ne touche jamais l'image (image_url = null ici).
        await setImage(prisma, type, id, null);
        if (created) {
          summary.created += 1;
          console.log(`  créé : ${type} : ${name}`);
        } else {
          summary.skipped += 1;
          console.log(`  déjà là : ${type} : ${name}`);
        }
      } catch (error) {
        warn(`${type} : ${name} — échec DB (${error instanceof Error ? error.message : String(error)}).`);
        summary.skipped += 1;
      }
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const seedDefaultsFlag = args.has('--seed-defaults');
  const yes = args.has('--yes');

  console.log(`Import des images du catalogue garnitures.`);
  console.log(`Base : ${databaseHost()} (hôte seul — le mot de passe n'est jamais affiché).`);
  console.log(`Flags : ${[dryRun && '--dry-run', seedDefaultsFlag && '--seed-defaults', yes && '--yes'].filter(Boolean).join(' ') || '(aucun)'}`);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('\nStockage fichier non configure (SUPABASE_URL / SERVICE_ROLE_KEY) :');
    console.log('les images ne pourront PAS être uploadées — seul --seed-defaults reste utilisable.');
  }

  if (!(await confirm(dryRun, yes))) {
    console.log('Annulé (aucune écriture).');
    return;
  }

  const prisma = new PrismaClient();
  try {
    if (seedDefaultsFlag) await seedDefaults(prisma, dryRun);
    await importFiles(prisma, dryRun);
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\nRésumé : ${summary.created} créé(s), ${summary.updated} à jour, ${summary.skipped} ignoré(s), ${summary.warnings} avertissement(s).`,
  );
  if (dryRun) console.log('(dry-run : rien n\'a été écrit ni uploadé)');
}

main().catch((error) => {
  console.error(`Import interrompu : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
