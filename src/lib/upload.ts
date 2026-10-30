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
