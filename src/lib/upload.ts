import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { ApiError } from './errors';

let client: SupabaseClient | null = null;

export const storageEnabled = () => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

/** Upload un buffer vers Supabase Storage et renvoie l'URL publique.
 *  stablePath optionnel : chemin déterministe (extras/<type>/<slug>.<ext>) —
 *  le fichier est REMPLACÉ à chaque upload (upsert) ; sans lui, un chemin
 *  unique timestampé est généré comme avant. */
export async function uploadBuffer(
  buffer: Buffer,
  contentType: string,
  folder = 'misc',
  stablePath?: string,
): Promise<string> {
  if (!storageEnabled()) {
    throw ApiError.notImplemented('Stockage fichier non configure (SUPABASE_URL / SERVICE_ROLE_KEY)', 'UPLOADS_DISABLED');
  }
  const ext = MIME_EXT[contentType] ?? 'bin';
  const path = stablePath ?? `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await getSupabase().storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, buffer, {
    contentType,
    upsert: Boolean(stablePath),
  });
  if (error) throw ApiError.badRequest(`Echec d'upload : ${error.message}`, 'UPLOAD_FAILED');
  const { data } = getSupabase().storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** Upload vers un bucket SPECIFIQUE (ex. medias de categories) avec chemin
 *  immutable : le nom de fichier est le hash de contenu, cacheControl long
 *  (CDN + cache permanent device, jamais de revalidation). upsert=true : le
 *  meme contenu ecrase le meme chemin (idempotent). */
export async function uploadToBucket(
  bucket: string,
  path: string,
  buffer: Buffer,
  opts: { contentType: string; cacheControl?: string } = { contentType: 'application/octet-stream' },
): Promise<string> {
  if (!storageEnabled()) {
    throw ApiError.notImplemented('Stockage fichier non configure (SUPABASE_URL / SERVICE_ROLE_KEY)', 'UPLOADS_DISABLED');
  }
  const { error } = await getSupabase().storage.from(bucket).upload(path, buffer, {
    contentType: opts.contentType,
    cacheControl: opts.cacheControl ?? '31536000',
    upsert: true,
  });
  if (error) throw ApiError.badRequest(`Echec d'upload : ${error.message}`, 'UPLOAD_FAILED');
  const { data } = getSupabase().storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/** Supprime un objet de Storage. Object absent = OK (remove ne passe pas en erreur). */
export async function removeFromBucket(bucket: string, path: string): Promise<void> {
  if (!storageEnabled()) return;
  const { error } = await getSupabase().storage.from(bucket).remove([path]);
  if (error) throw ApiError.badRequest(`Echec de suppression : ${error.message}`, 'UPLOAD_FAILED');
}

/**
 * Extrait le chemin Storage d'une URL publique Supabase
 * (`.../storage/v1/object/public/<bucket>/<path>`). Retourne null pour une URL
 * externe (ex. photo Google) ou une URL d'un autre bucket : ces fichiers ne
 * nous appartiennent pas et ne doivent pas etre supprimes.
 */
export function storagePathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${env.SUPABASE_STORAGE_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = url.slice(index + marker.length).split('?')[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Supprime (best effort cote appelant) le fichier designe par une URL publique du bucket principal. */
export async function removePublicUrl(url: string | null | undefined): Promise<void> {
  const path = storagePathFromPublicUrl(url);
  if (!path) return;
  await removeFromBucket(env.SUPABASE_STORAGE_BUCKET, path);
}

/** Cree le bucket s'il n'existe pas (public). Utilise par le seed — le bucket
 *  public est aussi creable manuellement (voir README : Storage -> New bucket). */
export async function ensurePublicBucket(bucket: string): Promise<void> {
  if (!storageEnabled()) {
    throw ApiError.notImplemented('Stockage fichier non configure (SUPABASE_URL / SERVICE_ROLE_KEY)', 'UPLOADS_DISABLED');
  }
  const { error: getError } = await getSupabase().storage.getBucket(bucket);
  if (!getError) return; // deja la
  // Un erreur RESEAU ne veut pas dire "bucket absent" : on ne tente pas de
  // creation (sinon message trompeur), on echoue clairement et reproductible.
  if (!/not found|does not exist|missing/i.test(getError.message)) {
    throw ApiError.badRequest(`Lecture du bucket "${bucket}" impossible : ${getError.message}`, 'UPLOAD_FAILED');
  }
  const { error: createError } = await getSupabase().storage.createBucket(bucket, { public: true });
  if (createError && !/already exists/i.test(createError.message)) {
    throw ApiError.badRequest(`Impossible de creer le bucket "${bucket}" : ${createError.message}`, 'UPLOAD_FAILED');
  }
}
