// api/_lib/handlers/crm-deal-photo.js
// POST /api/crm/deal-photo
//
// Agent uploads a listing photo from the Command Center. The image (already
// resized client-side to a JPEG data URL) is stored in the 'deal-photos'
// Supabase Storage bucket and its public URL is saved to deals.photo_override
// (db/026) — independent of the deals.json sync, so it's never overwritten.
//
// Body: { source_key: string, image: "data:image/jpeg;base64,...." }

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail, readJson } from '../cors.js';

const BUCKET = 'deal-photos';
const MAX_BYTES = 6 * 1024 * 1024;   // ~6MB decoded ceiling — client resizes well below this

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const body = await readJson(req);
    const sourceKey = String(body.source_key || '').trim();
    const image = String(body.image || '');
    if (!sourceKey) return fail(res, 400, 'source_key required');

    // Parse the data URL. Accept jpeg/png/webp.
    const m = /^data:(image\/(jpe?g|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m) return fail(res, 400, 'image must be a base64 image data URL');
    const contentType = m[1];
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const buffer = Buffer.from(m[3], 'base64');
    if (!buffer.length) return fail(res, 400, 'empty image');
    if (buffer.length > MAX_BYTES) return fail(res, 413, 'image too large — it should be resized before upload');

    const supa = adminClient();

    // Stable path per deal (overwrite prior upload); slugify the source_key.
    const slug = sourceKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'deal';
    const path = `${slug}.${ext}`;

    const up = await supa.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
    if (up.error) {
      if (/bucket|not found|does not exist/i.test(up.error.message || '')) {
        return fail(res, 409, "storage bucket 'deal-photos' missing — run db/026_deal_photo_override.sql");
      }
      return fail(res, 500, up.error.message);
    }

    // Public URL + cache-buster so the browser reloads after an overwrite.
    const pub = supa.storage.from(BUCKET).getPublicUrl(path);
    const url = `${pub.data.publicUrl}?v=${buffer.length}`;

    const { error: updErr } = await supa.from('deals').update({ photo_override: url }).eq('source_key', sourceKey);
    if (updErr) {
      if (/photo_override|schema cache|column/i.test(updErr.message || '')) {
        return fail(res, 409, 'photo_override column missing — run db/026_deal_photo_override.sql');
      }
      return fail(res, 500, updErr.message);
    }

    return ok(res, { url, source_key: sourceKey });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
