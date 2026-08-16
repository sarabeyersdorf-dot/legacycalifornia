// api/cron/photo-backfill.js — GET /api/cron/photo-backfill?key=<PUBLISH_SECRET>
//
// Backfills real, licensed listing photos for properties that have an MLS
// number but no usable photo — the tell-tale of a curated-collection capture
// made before the IDX card's lazy image loaded (it grabbed the MetroList
// placeholder logo, or nothing). For each such row we pull the photos straight
// from the MetroList RESO feed by MLS and store them, so the tile stops showing
// "no photo available."
//
// Safe to run any time and idempotent: a row that already has real photos is
// skipped, and a row whose MLS the feed can't resolve is left untouched.
//
// No-ops cleanly when the MetroList feed isn't configured (isConfigured()===false),
// so it never errors in an environment without the METROLIST_* secrets.
//
// Optional query params:
//   ?id=<uuid>           heal one property by id (ignores the placeholder filter)
//   ?mls=<listingId>     heal every property carrying this MLS number
//   ?limit=<n>           cap the batch (default 40, max 200)

import { adminClient } from '../_lib/supabase.js';
import { isConfigured, photosByMls } from '../_metrolist.js';
import { isPlaceholderPhoto } from '../_lib/handlers/curate-search.js';

// A stored photos array is "usable" only if it has at least one real (non
// placeholder) URL — mirrors what the collection render actually shows.
function hasRealPhoto(photos) {
  return Array.isArray(photos) && photos.some((p) => p && !isPlaceholderPhoto(p));
}

export default async function handler(req, res) {
  if (!process.env.PUBLISH_SECRET || req.query.key !== process.env.PUBLISH_SECRET) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  if (!isConfigured()) {
    return res.status(200).json({
      success: true, disabled: true,
      note: 'MetroList feed not configured (set METROLIST_TOKEN_URL / API_BASE / CLIENT_ID / CLIENT_SECRET) — photo backfill is inert.'
    });
  }

  const supa = adminClient();
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '40', 10) || 40, 1), 200);

  try {
    // Candidate rows: anything with an MLS number. We filter down to the ones
    // that actually need healing in JS (Postgres can't easily test the array for
    // "all placeholder"). ?id / ?mls narrow to a specific target and force a heal.
    let q = supa.from('properties')
      .select('id, mls_number, photos')
      .not('mls_number', 'is', null);
    if (req.query.id)  q = q.eq('id', req.query.id);
    if (req.query.mls) q = q.eq('mls_number', String(req.query.mls).trim());
    q = q.limit(600);

    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });

    const forced = Boolean(req.query.id || req.query.mls);
    const needy = (rows || [])
      .filter((r) => r.mls_number && (forced || !hasRealPhoto(r.photos)))
      .slice(0, limit);

    const healed = [];
    const missed = [];
    for (const r of needy) {
      const photos = await photosByMls(r.mls_number);
      if (!photos.length) { missed.push(r.mls_number); continue; }
      const up = await supa.from('properties').update({ photos }).eq('id', r.id);
      if (up.error) { missed.push(`${r.mls_number} (${up.error.message})`); continue; }
      healed.push({ id: r.id, mls: r.mls_number, photo_count: photos.length });
    }

    return res.status(200).json({
      success: true,
      candidates: needy.length,
      healed: healed.length,
      healed_detail: healed,
      no_photos_found: missed,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
