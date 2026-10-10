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

/** Upload un buffer vers Supabase Storage et renvoie l'URL publique. */
export async function uploadBuffer(buffer: Buffer, contentType: string, folder = 'misc'): Promise<string> {
  if (!storageEnabled()) {
    throw ApiError.notImplemented('Stockage fichier non configure (SUPABASE_URL / SERVICE_ROLE_KEY)', 'UPLOADS_DISABLED');
  }
  const ext = MIME_EXT[contentType] ?? 'bin';
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await getSupabase().storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw ApiError.badRequest(`Echec d'upload : ${error.message}`, 'UPLOAD_FAILED');
  const { data } = getSupabase().storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
