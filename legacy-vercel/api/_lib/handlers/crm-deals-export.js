// api/_lib/handlers/crm-deals-export.js
// GET /api/crm/deals-export?key=<SYNC_SECRET>[&deal=<source_key>][&pretty=1]
//
// PHASE 3, STEP 1 (SPEC §5.4 / PHASE3_PLAN step 1) — the DB→deals.json export
// GENERATOR. Read-only and NON-AUTHORITATIVE: it renders the current merged DB
// state (Cowork's deals.json base, with agent CRM overlays winning) back into a
// deals.json-SHAPED payload, so the DB can eventually be restored from itself
// instead of from Cowork's Dropbox file. It writes NOTHING and changes no
// behavior — it is the on-ramp that lets us prove the DB has full fidelity
// (step 2's diff) before deals.json is ever downgraded to an input feed.
//
// Two honesty guarantees, because a lossy backup is worse than none:
//   1. `_gaps` lists the deals.json fields the DB does NOT store yet (found by
//      Cowork's 8/29 enumeration). These CANNOT round-trip until a migration adds
//      columns for them — the export names them instead of silently dropping them.
//   2. Agent-only agenda data (expected dates) is deliberately EXCLUDED from each
//      deal body — it must never live in deals.json (SPEC §3) — and summarised
//      under `_agent_only` instead.
//
// Overlay precedence mirrors the portal: agent_* column wins over the deals.json
// base column; stage_override wins over stage.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { checkSyncKey } from '../sync-key.js';

// deals.json fields Cowork authors that have NO deals column yet (Cowork 8/29).
// Until a migration stores them, a DB→deals.json round-trip would lose them.
const KNOWN_GAPS = [
  { field: 'correspondence', deals_affected: 32, note: 'biggest gap by volume; no column' },
  { field: 'homesCom',       deals_affected: 4,  note: 'Homes.com weekly traffic; marketing_stats holds ListTrac only' },
  { field: 'docs',           deals_affected: 34, note: 'lives in deal_documents, but the deals.json docs{} block carries filed paths + executed values Step 1d reads as evidence — export must reconstruct it' },
  { field: 'clientDocuments',deals_affected: 9,  note: 'no column found' },
  { field: 'color',          deals_affected: 2,  note: 'per-deal UI colour binding CRM/calendar/tasks/checklist' },
  { field: 'escrows',        deals_affected: 1,  note: 'no column (deal_escrows is derived, not the authored block)' },
  { field: 'docFolder',      deals_affected: 1,  note: 'no column found' },
  { field: 'archivedDate',   deals_affected: 2,  note: 'no column found' },
  { field: 'listingExpiration', deals_affected: 1, note: 'top-level; distinct from listing.expiration which IS stored' },
  { field: 'buyer',          deals_affected: 1,  note: 'possibly party_details, which is null on sampled deals' },
  { field: 'version/lastUpdated/updatedBy', deals_affected: 'file', note: 'file-level; no DB home — export synthesises them below' },
  { field: 'task doneDate/doneNote', deals_affected: 'tasks', note: 'agent_tasks has done but no done_at/done_note' }
];

const arr = (v) => (Array.isArray(v) ? v : null);
// Overlay wins when it's a non-empty array; else fall back to the base column.
const pick = (overlay, base) => (arr(overlay) && overlay.length ? overlay : (arr(base) ?? undefined));

// Inverse of mapDeal: one DB row → a deals.json-shaped deal object.
function toDealsJson(d) {
  const out = {
    id: d.source_key,
    address: d.address ?? undefined,
    city: d.city ?? undefined,
    type: d.type ?? undefined,
    side: d.side ?? undefined,                       // DB-normalised (buyer/seller/both)
    stage: d.stage_override || d.stage || undefined, // effective stage (override wins)
    agent: d.agent ?? undefined,
    listPrice: d.list_price ?? undefined,
    salePrice: d.sale_price ?? undefined,
    openEscrowDate: d.escrow_open_date ?? undefined,
    closingDate: d.coe_date ?? undefined,
    mls: d.mls_number ?? undefined,
    contacts: d.contacts ?? undefined,
    notes: d.notes_internal ?? undefined,
    photo: d.photo_url ?? undefined,
    video: d.video_url ?? undefined,
    matterport: d.matterport_url ?? undefined,
    marketing: d.marketing_stats ?? undefined,
    listing: d.listing_meta ?? undefined,            // approx; mergeMeta is lossy in reverse
    timeline: d.timeline ?? undefined,
    attributes: d.attributes ?? undefined,
    // Overlay-aware content (agent CRM edit wins over Cowork's deals.json base):
    milestones:       pick(d.agent_milestones,        d.milestones),
    buyerMilestones:  pick(d.agent_buyer_milestones,  d.buyer_milestones),
    clientTasks:      pick(d.agent_client_tasks,      d.client_tasks),
    buyerTasks:       pick(d.agent_buyer_tasks,       d.buyer_tasks),
    goodToKnow:       pick(d.agent_good_to_know,      d.good_to_know),
    buyerGoodToKnow:  pick(d.agent_buyer_good_to_know, d.buyer_good_to_know),
    agentNote: d.agent_note ?? undefined,
  };
  if (d.created_in_crm) out._created_in_crm = true;  // no deals.json origin
  // Drop undefined keys so the shape matches an authored deal, not a sparse row.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  if (!checkSyncKey(req.query?.key).ok) return fail(res, 401, 'bad key');

  const supa = adminClient();
  const one = String(req.query?.deal || '').trim();
  const isPretty = ['1', 'true', 'yes'].includes(String(req.query?.pretty || '').toLowerCase());

  const COLS = [
    'source_key','address','city','type','side','stage','stage_override','agent',
    'list_price','sale_price','escrow_open_date','coe_date','mls_number','contacts',
    'notes_internal','photo_url','video_url','matterport_url','marketing_stats',
    'listing_meta','timeline','attributes','created_in_crm',
    'milestones','buyer_milestones','client_tasks','buyer_tasks','good_to_know','buyer_good_to_know',
    'agent_milestones','agent_buyer_milestones','agent_client_tasks','agent_buyer_tasks',
    'agent_good_to_know','agent_buyer_good_to_know','agent_note',
    'coe_date_expected','coe_date_expected_by','acceptance_date_expected','acceptance_date_expected_by'
  ].join(', ');

  try {
    let q = supa.from('deals').select(COLS);
    if (one) q = q.eq('source_key', one);
    const { data, error } = await q;
    if (error) return fail(res, 500, error.message);
    const rows = data || [];

    const deals = rows.map(toDealsJson);
    // Agent-only agenda data kept OUT of the deal bodies (never deals.json, §3).
    const agentOnly = rows
      .filter((r) => r.coe_date_expected || r.acceptance_date_expected)
      .map((r) => ({
        deal: r.source_key,
        coe_date_expected: r.coe_date_expected || null, coe_date_expected_by: r.coe_date_expected_by || null,
        acceptance_date_expected: r.acceptance_date_expected || null, acceptance_date_expected_by: r.acceptance_date_expected_by || null
      }));

    return sendPayload(res, isPretty, {
      _meta: {
        generated_at: new Date().toISOString(),
        deal_count: deals.length,
        authoritative: false,
        phase: 'phase-3 step 1 (export generator)',
        note: 'Non-authoritative DB→deals.json export (agent overlays win over the deals.json base). A backup/diff artifact, NOT a master. Fields in _gaps do not round-trip until the DB stores them.'
      },
      // Synthesised file-level fields (no DB home — see _gaps).
      version: null,
      lastUpdated: new Date().toISOString(),
      updatedBy: 'db-export',
      _gaps: KNOWN_GAPS,
      _agent_only: agentOnly,   // expected dates — agenda only, never a deals.json field
      deals
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

function sendPayload(res, isPretty, payload) {
  if (isPretty) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ success: true, ...payload }, null, 2));
  }
  return ok(res, payload);
}
