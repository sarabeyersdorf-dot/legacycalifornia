// api/cron/flag-matches.js
// GET /api/cron/flag-matches   (Vercel cron — runs shortly after the IDX sync)
//
// For each saved_search, re-runs its exact filters and flags NEW listings —
// ones that weren't present on the previous run. Updates new_match_count /
// last_seen_listing_ids / last_run_at so the Curated screen shows "N new" per
// search. First run for a search is a silent baseline (no flood of "all N new").
// Writes a sync_runs heartbeat so a stalled job is visible, not silent.

import { adminClient } from '../_lib/supabase.js';
import { runSearch } from '../_lib/handlers/curate-search.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Auth: Vercel cron sends `x-vercel-cron`; if CRON_SECRET is set, also accept
  // `Authorization: Bearer <CRON_SECRET>` (Vercel injects it automatically).
  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okCron = !!req.headers['x-vercel-cron'] || (cronSecret ? bearer === cronSecret : true);
  if (!okCron) return fail(res, 401, 'cron secret invalid');
  res.setHeader('Cache-Control', 'no-store');

  const supa = adminClient();
  try {
    const { data: searches } = await supa
      .from('saved_searches')
      .select('id, filters, last_seen_listing_ids');

    let scanned = 0, newMatches = 0;
    for (const s of (searches || [])) {
      try {
        const { listings } = await runSearch(supa, s.filters || {}, { limit: 200 });
        const ids = listings.map((l) => l.id);
        const prev = s.last_seen_listing_ids || [];
        const isBaseline = prev.length === 0;              // first run → don't flood
        const seen = new Set(prev);
        const fresh = isBaseline ? [] : ids.filter((id) => !seen.has(id));
        await supa.from('saved_searches').update({
          new_match_count: fresh.length,
          last_seen_listing_ids: ids,
          last_run_at: new Date().toISOString()
        }).eq('id', s.id);
        scanned++; newMatches += fresh.length;
      } catch (_) { /* skip a broken filter set, keep going */ }
    }

    supa.from('sync_runs').insert({ job: 'saved_search_match', status: 'ok', detail: { searches: scanned, new_matches: newMatches } }).then(() => {}, () => {});
    return ok(res, { scanned, new_matches: newMatches, ran_at: new Date().toISOString() });
  } catch (e) {
    supa.from('sync_runs').insert({ job: 'saved_search_match', status: 'error', detail: { error: e.message } }).then(() => {}, () => {});
    return fail(res, 500, e.message);
  }
}
