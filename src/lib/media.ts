import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { MediaAsset } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from './prisma';
import { ApiError } from './errors';
import { logger } from './logger';
import { removeFromBucket, uploadToBucket } from './upload';

/**
 * Pipeline des medias de categories (GIF de l'ecran Restaurants) :
 *  validation (mime + octets magiques + 3 Mo max) -> conversion WebP anime
 *  (sharp, cote le plus long <= 256 px, <= 150 Ko) -> Supabase Storage avec
 *  nom de fichier immutable <hash-sha256>.webp (cacheControl 1 an) -> ligne
 *  MediaAsset. Le disque Render n'est JAMAIS utilise (memoryStorage + Storage).
 *
 * Render free : peu de RAM -> une seule conversion a la fois (file interne),
 * plafonds d'entree (frames / pixels) avant decodage, echec propre (ApiError)
 * plutot que crash.
 */

/** Taille max du fichier RECUPERE (octets) — au-dela multer rejette. */
export const MEDIA_MAX_INPUT_BYTES = 3 * 1024 * 1024;
/** Cible du fichier CONVERTI : <= 150 Ko, sinon retry puis rejet. */
export const MEDIA_TARGET_BYTES = 150 * 1024;
/** Plafond de frames avant decodage (protection RAM). */
const MAX_FRAMES = 600;
/** Plafond de pixels d'entree (decompression bomb guard). */
const MAX_INPUT_PIXELS = 100_000_000;

/** Tentatives de conversion : [cote max, qualite WebP]. La 1re est la cible
 *  officielle (256 px / q70) ; les suivantes ne servent que si > 150 Ko. */
const ATTEMPTS = [
  { maxSize: 256, quality: 70 },
  { maxSize: 256, quality: 50 },
  { maxSize: 192, quality: 40 },
] as const;

export type ConvertedImage = {
  buffer: Buffer;
  width: number;
  height: number;
  /** Hash SHA-256 du contenu converti (devient version + nom de fichier). */
  version: string;
};

/* ---------------- Validation ---------------- */

/** Octets magiques : GIF (GIF87a/GIF89a) ou WebP (RIFF....WEBP). */
function sniffMime(buffer: Buffer): 'image/gif' | 'image/webp' | null {
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buffer.length >= 12) {
    const riff = buffer.subarray(0, 4).toString('latin1');
    const webp = buffer.subarray(8, 12).toString('latin1');
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

/** Valide l'entree : presence, taille, mime DIT et contenu RÉEL (magics). */
export function validateMediaInput(file: { buffer?: Buffer; mimetype?: string }): void {
  if (!file.buffer || file.buffer.length === 0) {
    throw ApiError.badRequest('Fichier manquant (champ "file")', 'FILE_REQUIRED');
  }
  if (file.buffer.length > MEDIA_MAX_INPUT_BYTES) {
    throw ApiError.badRequest('Fichier trop volumineux (3 Mo maximum)', 'MEDIA_TOO_LARGE');
  }
  const declared = (file.mimetype ?? '').toLowerCase();
  if (declared !== 'image/gif' && declared !== 'image/webp') {
    throw ApiError.badRequest('Formats acceptes : GIF ou WebP', 'MEDIA_TYPE_UNSUPPORTED');
  }
  const sniffed = sniffMime(file.buffer);
  if (!sniffed) throw ApiError.badRequest('Contenu illisible (octets magiques invalides)', 'MEDIA_INVALID');
  if (sniffed !== declared) {
    throw ApiError.badRequest(`Type annonce "${declared}" mais le contenu est "${sniffed}"`, 'MEDIA_INVALID');
  }
}

/* ---------------- Conversion ---------------- */

/**
 * Convertit une entree animee en WebP anime compact :
 * - resize cote le plus long <= maxSize sans agrandissement ;
 * - quality / effort modere ;
 * - si le resultat reste > 150 Ko, replie sur qualite puis taille inferieure ;
 * - toujours > 150 Ko -> MEDIA_TOO_HEAVY.
 */
export async function convertToCategoryWebp(input: Buffer): Promise<ConvertedImage> {
  // Garde-fous AVANT decodage : metadata ne decode pas les pixels.
  let meta: import('sharp').Metadata;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (err) {
    throw ApiError.badRequest('Image illisible ou trop volumineuse a decoder', 'MEDIA_INVALID');
  }
  const pages = meta.pages ?? 1;
  if (pages > MAX_FRAMES) {
    throw ApiError.badRequest(`Animation trop longue (${pages} frames, max ${MAX_FRAMES})`, 'MEDIA_TOO_HEAVY');
  }

  let lastSize = 0;
  for (const attempt of ATTEMPTS) {
    const { data, info } = await sharp(input, { animated: true, limitInputPixels: MAX_INPUT_PIXELS })
      .resize(attempt.maxSize, attempt.maxSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: attempt.quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    lastSize = data.length;
    if (data.length <= MEDIA_TARGET_BYTES) {
      return {
        buffer: data,
        width: info.width,
        height: info.height,
        version: createHash('sha256').update(data).digest('hex'),
      };
    }
  }
  throw ApiError.badRequest(
    `GIF trop lourd apres compression (${Math.ceil(lastSize / 1024)} Ko > 150 Ko)`,
    'MEDIA_TOO_HEAVY',
  );
}

/* ---------------- Persistance (Storage + DB) ---------------- */

/**
 * Stocke une image convertie : chemin immutable `<hash>.webp`, upload Storage
 * (cacheControl 1 an), ligne MediaAsset. Idempotent : meme contenu = meme
 * hash = meme ligne retournee (rejeu du seed ou double upload sans doublon).
 */
export async function storeCategoryMedia(name: string, image: ConvertedImage): Promise<MediaAsset> {
  const storagePath = `${image.version}.webp`;
  const existing = await prisma.mediaAsset.findUnique({ where: { storage_path: storagePath } });
  if (existing) return existing;

  const bucket = env.SUPABASE_MEDIA_BUCKET;
  const publicUrl = await uploadToBucket(bucket, storagePath, image.buffer, {
    contentType: 'image/webp',
    cacheControl: '31536000',
  });
  try {
    return await prisma.mediaAsset.create({
      data: {
        name,
        storage_path: storagePath,
        public_url: publicUrl,
        mime_type: 'image/webp',
        width: image.width,
        height: image.height,
        size_bytes: image.buffer.length,
        version: image.version,
      },
    });
  } catch (err) {
    // Course improbable (seed + upload simultane) : unique(storage_path) ->
    // on retourne la ligne existante plutot que d'echouer.
    const raced = await prisma.mediaAsset.findUnique({ where: { storage_path: storagePath } });
    if (raced) return raced;
    throw err;
  }
}

/* ---------------- File d'attente (concurrency 1) ---------------- */

let chain: Promise<unknown> = Promise.resolve();

/** Execute les taches de conversion une APRES l'autre (RAM Render libre). */
export function withMediaQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ---------------- Use-case admin : upload ---------------- */

function sanitizeName(originalname: string | undefined): string {
  const base = (originalname ?? 'media').split(/[\\/]/).pop() ?? 'media';
  const cleaned = base.replace(/[\r\n"]/g, '').trim();
  return (cleaned || 'media').slice(0, 120);
}

/** Pipeline complet d'un upload admin : validate -> (queue) -> convert -> store. */
export async function processCategoryUpload(file: { buffer: Buffer; mimetype: string; originalname?: string }): Promise<MediaAsset> {
  validateMediaInput(file);
  return withMediaQueue(async () => {
    const image = await convertToCategoryWebp(file.buffer);
    const asset = await storeCategoryMedia(sanitizeName(file.originalname), image);
    logger.info('media', `upload ok name=${asset.name} path=${asset.storage_path} size=${asset.size_bytes}B ${asset.width}x${asset.height}`);
    return asset;
  });
}

/* ---------------- Use-case admin : suppression ---------------- */

/**
 * Supprime un media. Option retenue (la plus sure) : REFUSE si une categorie
 * le reference (MEDIA_IN_USE) — on ne casse jamais un lien a l'insu de l'admin ;
 * il faut d'abord delier ou changer le GIF de la categorie.
 * Le fichier Storage est supprime AVANT la ligne : si Storage echoue, la ligne
 * reste (rien n'est perdu, l'admin peut reessayer).
 */
export async function deleteMediaAsset(id: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id },
    include: { _count: { select: { categories: true } } },
  });
  if (!asset) throw ApiError.notFound('Media introuvable');
  if (asset._count.categories > 0) {
    throw ApiError.conflict(
      `Ce GIF est lie a ${asset._count.categories} categorie(s) : deliez-le d'abord`,
      'MEDIA_IN_USE',
    );
  }
  await removeFromBucket(env.SUPABASE_MEDIA_BUCKET, asset.storage_path);
  await prisma.mediaAsset.delete({ where: { id } });
  logger.info('media', `delete ok id=${id} path=${asset.storage_path}`);
}
