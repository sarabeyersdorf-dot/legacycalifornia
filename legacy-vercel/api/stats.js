// api/stats.js
// GET /api/stats — PUBLIC endpoint. No auth, no PII.
//
// Returns the brokerage "brag" numbers the public site displays (currently the
// homepage agent bio). Only aggregate counts and a couple of config values are
// returned — never any lead rows.
//
// closingsTotal uses a HYBRID model so the number stays live as Sara sells,
// without backfilling her entire sales history into the CRM:
//     closingsTotal = CAREER_BASE  +  (deals closed in the CRM since BASE_DATE)
// CAREER_BASE is set to match the Zillow profile on BASE_DATE; every new deal
// marked closed in the CRM after that date adds on top automatically. To reset
// the baseline later (e.g. Zillow jumps), just update CAREER_BASE / BASE_DATE.
//
// The homepage renders CAREER_BASE statically (so crawlers/AI read it), then
// this endpoint updates the visible number for humans.

import { adminClient } from './_lib/supabase.js';
import { handleOptions, ok } from './_lib/cors.js';

const CAREER_BASE   = 107;            // total closings as of BASE_DATE (Zillow profile)
const BASE_DATE     = '2026-07-29';   // CRM closings after this date add on top
const TRAILING_12   = 23;             // last-12-months floor (grows if the CRM exceeds it)
const ZILLOW_RATING = 5.0;
const CLOSED_STAGES = ['closed', 'close'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Safe defaults so the homepage never blanks if the DB is unreachable.
  let closingsTotal = CAREER_BASE;
  let closingsTrailing12 = TRAILING_12;

  try {
    const supa = adminClient();
    const twelveMoAgo = new Date(Date.now() - 365 * 86400 * 1000).toISOString();

    const [sinceBase, trailing] = await Promise.all([
      supa.from('leads').select('id', { count: 'exact', head: true })
          .in('pipeline_stage', CLOSED_STAGES).gte('updated_at', BASE_DATE + 'T00:00:00Z'),
      supa.from('leads').select('id', { count: 'exact', head: true })
          .in('pipeline_stage', CLOSED_STAGES).gte('updated_at', twelveMoAgo),
    ]);

    if (!sinceBase.error && typeof sinceBase.count === 'number') {
      closingsTotal = CAREER_BASE + sinceBase.count;
    }
    if (!trailing.error && typeof trailing.count === 'number') {
      closingsTrailing12 = Math.max(TRAILING_12, trailing.count);
    }
  } catch (_) {
    // fall through to defaults
  }

  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
  return ok(res, {
    closingsTotal,
    closingsTrailing12,
    zillowRating: ZILLOW_RATING,
    updatedAt: new Date().toISOString().slice(0, 10),
  });
}
