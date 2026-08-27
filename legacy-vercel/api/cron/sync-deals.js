// api/cron/sync-deals.js
// GET /api/cron/sync-deals?key=<SYNC_SECRET>
//
// Loads the single source of truth (data/deals.json, committed in the repo)
// into Supabase: upserts `deals` and rebuilds `deal_documents` for every
// active (pending / listing) deal. Idempotent — safe to run any number of
// times. Trigger it by visiting the URL, or wire it to a Vercel Cron.
//
// Protect with the SYNC_SECRET env var so only you can trigger it.

import { createRequire } from 'module';
import { adminClient } from '../_lib/supabase.js';

// Load deals.json as a module dependency (not a runtime fs read) so Vercel's
// bundler traces it and ships it inside the serverless function. A bare
// readFileSync(process.cwd()+...) is NOT traced and 500s with ENOENT on Vercel.
const require = createRequire(import.meta.url);
import { handleOptions, ok, fail } from '../_lib/cors.js';
import { checkSyncKey } from '../_lib/sync-key.js';

// Read a JSON file FRESH from the repo (GitHub Contents API) so a just-published
// deals.json / portal-docs manifest is picked up IMMEDIATELY, without waiting for
// Vercel to rebuild the bundled copy. Every read falls back to the bundled copy on
// any failure (no token, network error, bad JSON), so the sync never gets worse
// than today's behavior.
const GH_OWNER = 'sarabeyersdorf-dot', GH_REPO = 'legacycalifornia', GH_BRANCH = 'main';
async function ghFetchJson(repoPath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${repoPath}?ref=${GH_BRANCH}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!r.ok || !r.headers) return null;
  const g = await r.json();
  if (!g || !g.content) return null;                       // >1MB files return no inline content
  return JSON.parse(Buffer.from(g.content, 'base64').toString('utf-8'));
}
async function loadDeals() {
  try {
    const fresh = await ghFetchJson('legacy-vercel/data/deals.json');
    if (fresh && Array.isArray(fresh.deals)) return { data: fresh, source: 'github' };
  } catch (_) { /* fall through to the bundled copy */ }
  return { data: require('../../data/deals.json'), source: 'bundle' };
}
async function loadManifest(id) {
  try {
    const fresh = await ghFetchJson(`legacy-vercel/data/portal-docs/${id}.json`);
    if (Array.isArray(fresh)) return fresh;
  } catch (_) { /* fall through */ }
  try { return require(`../../data/portal-docs/${id}.json`); } catch (_) { return []; }
}

// Repo-owned deal→Dropbox-folder map (see publish-docs-from-dropbox). Mirrors the
// publisher so the sync loads a deal's published doc manifest even when deals.json
// has no `docFolder` field (Cowork rarely sets it and it's wiped on republish).
let DOC_FOLDER_OVERRIDES = {};
try { DOC_FOLDER_OVERRIDES = require('../../data/doc-folders.json') || {}; } catch (_) {}

// --- document label + status maps (mirror the compliance checklist) --------
const DOC_LABELS = {
  RPA: ['Purchase Agreement', 'Core contract'],
  VLPA: ['Vacant Land Purchase Agreement', 'Core contract'],
  sellerCounter1: ['Seller Counter Offer', 'Revised terms'],
  buyerCounter1: ['Buyer Counter Offer', 'Final price'],
  AAA: ['Agent Acknowledgment', 'Licensed agents'],
  realtorAcknowledgement: ['Agent Acknowledgment', 'Roles confirmed'],
  TDS: ['Seller Disclosures (TDS)', 'Home condition'],
  SPQ: ['Property Questionnaire (SPQ)', 'Seller answers'],
  NHD: ['Natural Hazard Disclosure', 'Hazard zones'],
  wildfireDisclosure: ['Wildfire Disclosure', 'Fire zone'],
  TOPA: ['Tenant Addendum', 'Tenant terms'],
  SWPI: ['Septic / Well / Monument', 'Well & boundary'],
  SIPA: ['Rent-back Agreement', 'Seller-in-possession'],
  EMD: ['Earnest Money Deposit', 'Good-faith deposit'],
  prelim: ['Preliminary Title Report', 'Title review'],
  HOA: ['HOA Documents', 'Community rules'],
  AVID: ['Agent Visual Inspection', 'Walk-through notes'],
  FVAC_HID: ['Inspection Advisory', 'Right to inspect'],
  disclosures: ['Disclosures', 'Seller disclosures'],
  sellerDisclosures: ['Seller Disclosures', 'Full packet'],
  sellerDisclosurePackage: ['Seller Disclosure Package', 'All disclosures'],
  buyerSignedDisclosures: ['Buyer-signed Disclosures', 'Buyer signatures'],
  homeInspection: ['Home Inspection', 'Buyer inspection'],
  roofInspection: ['Roof Inspection Report', 'Roof condition'],
  wellSepticInspection: ['Well & Septic', 'Reports reviewed'],
  vehicleTrailerAddendum: ['Vehicle / Trailer Addendum', 'Removal terms'],
  emdAddendum2: ['Deposit Addendum', 'EMD timing'],
  addendum: ['Addendum', 'Contract change'],
  addendum1: ['Addendum', 'Contract change'],
  buyerContingencyAddendum: ['Contingency Addendum', 'Buyer conditions'],
  buyerContingencyRemoval1: ['Contingency Removal', 'Conditions met'],
  contingencyRemoval: ['Contingency Removal', 'Conditions met'],
  requestForRepair1: ['Request for Repair', 'Repairs asked'],
  lease: ['Lease', 'Tenant lease']
};
// Never surface these on a client portal (internal / marketing / legal).
const DOC_SKIP = new Set([
  'offeringMemo', 'priceReductionMemo', 'inspectionReport', 'listingAgreement',
  'commissionDemand', 'closingDocs', 'brokerCompAddendum', 'pricingStrategy',
  'certOfTrust', 'leaseDocs', 'flyer', 'mfgHomeAddendum', 'modificationOfTerms',
  'sellerDocs', 'mediationFiled', 'commissionCase', 'escrowDocs', 'evidence',
  'transactionDocs', 'BRBC', 'correspondence'
]);
// data/deals.json stores each doc's status as free-text PROSE ("received 7/2
// (in seller disclosure package)", "WAIVED by buyers…", "OUTSTANDING as of…").
// deal_documents.status is constrained to the enum below, and the seller portal
// branches on with_seller/to_sign/pending to decide what a client is asked to
// sign — so prose in that column would render as garbage AND violate the check.
// Map the prose to the enum on the LOWERCASED, TRIMMED PREFIX, in this order,
// and keep the original string in status_raw. Unknown prose defaults to
// 'on_file' on purpose: a wrong guess there is inert, whereas defaulting to
// 'pending' would make a portal ask someone to re-sign an executed document.
//
// (Mirrors the deal_documents_normalize_status DB trigger exactly, so the two
// compose: the trigger sees a value already in the enum and passes it through.)
const STATUS_RULES = [
  ['signed',      ['signed']],
  ['to_sign',     ['to sign', 'to_sign']],
  ['with_seller', ['with seller', 'with_seller']],
  ['sent',        ['sent']],
  // "not required" / "not applicable" / "n/a" is the OPPOSITE of an obligation,
  // so it must be caught BEFORE the generic 'not ' → pending prefix below —
  // otherwise a doc explicitly marked not-needed renders as a pending signature
  // request. (324 Augusta's "NOT REQUIRED — separate agents…" AAA did exactly
  // that, nagging Sara to sign an acknowledgment on a dead escrow. Cowork 8/26.)
  ['on_file',     ['not required', 'not applicable', 'not needed', 'not necessary', 'n/a', 'none required']],
  ['pending',     ['drafted', 'pending', 'outstanding', 'missing', 'waiting', 'needs', 'not ']],
  ['on_file',     ['executed', 'fully executed', 'received', 'accepted', 'on file', 'filed', 'waived', 'partial', 'final', 'complete', 'offer ']]
];
// Free text → the deal_documents.status enum. Returns null for an empty value
// (the caller treats that as a not-on-file "missing" doc).
function docStatus(val) {
  if (val == null) return null;
  const l = String(val).toLowerCase().trim();
  if (!l) return null;
  for (const [status, prefixes] of STATUS_RULES) {
    if (prefixes.some((p) => l.startsWith(p))) return status;
  }
  return 'on_file';                                  // unknown prose → inert default
}

// "NOT REQUIRED / N/A / not needed" marks a doc that is explicitly not part of
// this transaction. With no executed file attached it isn't a document at all,
// so mapDocs skips it rather than emitting a phantom row (belt to docStatus's
// suspenders above). Anchored to the start so it doesn't fire on prose that
// merely contains the words (e.g. "signed — n/a fields left blank").
const NOT_REQUIRED_RE = /^\s*(not\s+(required|applicable|needed|necessary)|n\/?a\b|none\s+required)/i;
const isNotRequired = (v) => v != null && NOT_REQUIRED_RE.test(String(v));

// Stages with a LIVE escrow clock. Only these carry a running contingency/COE
// timeline; a deal that has left escrow (closed / listing after a cancellation /
// preparing / etc.) must not keep a timeline generating phantom deadlines on a
// client's portal (drift-check's orphan_calendar / orphan_timeline).
const ESCROW_STAGES = new Set(['pending', 'offer']);

// Fallback timeline for a deal in escrow that has NO `timeline` block in
// deals.json (Bug 4 — 695 Feather seeded every date null and never recovered).
// Reconstruct Day 0 and the COE from the signals the deal DOES carry so the
// client-facing timeline isn't blank: acceptance from the "offer accepted /
// RPA executed" milestone, close from closingDate, and waived contingencies
// (cash deals) dropped so we don't invent deadlines that don't apply.
const _isoDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
function synthTimeline(d) {
  const ms = Array.isArray(d.milestones) ? d.milestones : [];
  const findMs = (re) => {
    const hit = ms.find((m) => m && re.test(String(m.label || '')) && _isoDate(m.date));
    return hit ? _isoDate(hit.date) : null;
  };
  const acceptance = findMs(/accept|executed|ratified|under contract/i);
  const escrowOpen = d.openEscrowDate ? _isoDate(d.openEscrowDate) : findMs(/escrow open/i);
  const coe = _isoDate(d.closingDate);
  const a = d.attributes || {};
  const removed = [];
  if (a.appraisal_waived)  removed.push('appraisal');
  if (a.loan_waived)       removed.push('loan');
  if (a.inspection_waived) removed.push('inspection');
  const tl = {};
  if (acceptance) tl.acceptance = acceptance;
  if (escrowOpen) tl.escrowOpen = escrowOpen;
  if (coe)        tl.coe = coe;
  if (removed.length) tl.removed = removed;
  // Only worth storing if it anchors at least a Day 0 or a close date.
  return (tl.acceptance || tl.escrowOpen || tl.coe) ? tl : null;
}

// Merge a deal's listing-sheet metadata with a top-level `client` name (from
// the executed docs) so buyer-side deals carry a client without a full listing.
function mergeMeta(d) {
  const base = d.listing || d.listingMeta || null;
  const client = d.client || d.clientName || (base && base.client) || null;
  // A top-level `commission` folds in so BUYER-side deals (no listing block)
  // carry one too — it's the buyer-broker comp from the accepted offer. Accepts
  // a percent ("2.5%") or a flat dollar amount from the commission demand.
  const commission = d.commission ?? (base && base.commission) ?? null;
  // ListTrac / MetroList weekly seller report (deals.json v8.1) — Cowork authors
  // it at the deal level (or inside the listing block). Carry it through
  // listing_meta so the seller portal can surface it without a new column.
  const listTrac = (d.listTrac && typeof d.listTrac === 'object' && !Array.isArray(d.listTrac))
    ? d.listTrac : ((base && base.listTrac) || null);
  if (!base && !client && commission == null && !listTrac) return null;
  return { ...(base || {}), ...(client ? { client } : {}), ...(commission != null ? { commission } : {}), ...(listTrac ? { listTrac } : {}) };
}

// Slice 2 (SPEC_portal_document_model.md): a property may carry an escrows[]
// history. At most one is active. When escrows[] is present, the ACTIVE escrow
// drives the property row's live fields; with none active the property reverts to
// its authored listing state ("back on market") — no phantom COE/price. Returns
// null when there's no escrows[] so the flat deal fields are used exactly as
// authored (fully backward-compatible).
function activeEscrow(d) {
  if (!Array.isArray(d.escrows) || !d.escrows.length) return null;
  return d.escrows.find((e) => e && e.status === 'active') || null;
}
function deriveFromEscrows(d) {
  if (!Array.isArray(d.escrows) || !d.escrows.length) return null;
  const a = activeEscrow(d);
  if (a) {
    return {
      stage: 'pending',
      sale_price: a.salePrice ?? a.sale_price ?? d.salePrice ?? null,
      coe_date: a.coe || a.coeDate || a.closingDate || null,
      escrow_open_date: a.openEscrowDate || a.escrowOpenDate || a.acceptance || null,
      timeline: a.timeline || d.timeline || null
    };
  }
  // No active escrow → the escrow closed or fell through.
  // If the deal was explicitly authored to a post-escrow stage (closed / listing
  // / preparing / dead), honour that — the human/Cowork has already re-staged it.
  if (d.stage && !ESCROW_STAGES.has(d.stage)) {
    return { stage: d.stage, sale_price: null, coe_date: null, escrow_open_date: null, timeline: null };
  }
  // A stale pending/offer stage with no live escrow: the deal LEFT escrow (a
  // cancellation) and deals.json hasn't been re-staged yet. Make the escrow
  // status authoritative so this doesn't wait on a manual stage edit — but
  // preserve the LIST side when it's ours: a deal where we hold the listing goes
  // back on market, while a buyer-only deal we represented has no listing to keep
  // and retires as dead rather than resurrecting a listing we don't hold.
  const ourListing = ['listing', 'seller', 'both', 'dual'].includes(String(d.side || '').toLowerCase());
  return { stage: ourListing ? 'listing' : 'dead', sale_price: null, coe_date: null, escrow_open_date: null, timeline: null };
}

function mapDeal(d) {
  const agent = /james/i.test(d.agent || '') ? 'james' : 'sara';
  const c = d.contacts || {};
  const mapped = {
    source_key: d.id,
    address: d.address,
    city: d.city || null,
    type: d.type || null,
    // Normalize side to the deals.side check constraint (buyer/seller/both):
    // deals.json authors a sell-side listing as 'listing' and a both-sides
    // in-house deal (Legacy on both sides — one agent lists, the other buys) as
    // 'dual'. Both would fail the constraint and silently drop the whole deal
    // from the sync — 324 Augusta went 'dual' and got stuck on its stale row.
    side: (d.side === 'listing') ? 'seller'
        : (d.side === 'dual') ? 'both'
        : (['buyer', 'seller', 'both'].includes(d.side) ? d.side : null),
    stage: d.stage || null,
    agent,
    list_price: d.listPrice ?? null,
    sale_price: d.salePrice ?? null,
    escrow_open_date: d.openEscrowDate || null,
    coe_date: d.closingDate || null,
    escrow_officer: c.escrow || null,
    title_company: c.title || null,
    co_agent: c.coAgent || null,
    // Full team-contact object (escrow/co-agent email + phone, escrow file #),
    // written verbatim so the portal Your-team block can show reachable info.
    // Cowork populates this from email comms.
    contacts: (d.contacts && typeof d.contacts === 'object') ? d.contacts : null,
    mls_number: d.mls || d.mlsNumber || d.mls_number || null,
    loan_contingency_days: d.id === '433-hwy4' ? 25 : 17,
    notes_internal: d.notes || null,
    // Media, driven from deals.json → seller portal hero photo + tour links.
    photo_url:      d.photo      || d.photoUrl      || null,
    video_url:      d.video      || d.youtube       || d.videoUrl      || null,
    matterport_url: d.matterport || d.matterportUrl || null,
    // Weekly ListTrac "Online Activity" digest (db/067). Cowork parses the
    // ListTrac email into deals.json → shows on the seller portal's marketing
    // panel. Authoritative here, so each week's numbers replace the prior week.
    // (video_views is deliberately NOT mapped — the youtube-views cron owns it,
    // so it must survive this sync.)
    marketing_stats: (d.marketing && typeof d.marketing === 'object' && !Array.isArray(d.marketing)) ? d.marketing : null,
    // Listing-sheet metadata (client, apn, beds/baths, sqft, lot, year, dates,
    // commission, disclosure package, branded video) for the Listings roster.
    // A top-level "client" (buyer/seller name from the executed docs) folds in
    // so buyer-side deals get a client name without a full listing block.
    listing_meta:   mergeMeta(d),
    // CA RPA timeline (acceptance Day 0, overrides, removals, paused clock) for
    // the briefing calendar's contingency/COE deadline math. Only a deal with a
    // LIVE escrow keeps it — a deal that has left escrow (listing after a
    // cancellation, closed, preparing…) drops it so it can't generate phantom
    // deadlines/COE. deals.json retains the history either way.
    timeline:       ESCROW_STAGES.has(d.stage) ? (d.timeline || synthTimeline(d)) : null,
    // ONE SHARED TIMELINE: At-a-Glance milestones + the author-attributed client
    // note, written verbatim from deals.json and read by the Today board, seller
    // portal, and buyer dashboard so all three show the same thing. Milestones
    // carry their own `badge`/`desc`/`col` inside the jsonb.
    milestones:     Array.isArray(d.milestones) ? d.milestones : null,
    // Buyer-perspective milestones (db/070) — Cowork authors these for a
    // buyer-side / both-sided deal so the buyer's portal reads from the buyer's
    // seat ("Your offer", "Your offer was accepted") instead of the seller text.
    buyer_milestones: Array.isArray(d.buyerMilestones) ? d.buyerMilestones
                    : (Array.isArray(d.milestones_buyer) ? d.milestones_buyer : null),
    agent_note:     d.agentNote || null,
    // v1.5 client-portal content: "What I need from you" + "Good to know".
    client_tasks:   Array.isArray(d.clientTasks) ? d.clientTasks : null,
    // Buyer-perspective tasks (db/071) — Cowork authors these for a buyer-side /
    // both-sided deal so the buyer's "What I need from you" reads from the buyer's
    // seat instead of the seller's to-do list.
    buyer_tasks:    Array.isArray(d.buyerTasks) ? d.buyerTasks
                  : (Array.isArray(d.tasks_buyer) ? d.tasks_buyer : null),
    good_to_know:   Array.isArray(d.goodToKnow) ? d.goodToKnow : null,
    // Buyer-perspective "Good to know" (db/072) — Cowork authors these so a buyer
    // never sees the seller-seat bullets ("Sara represents you as the seller").
    buyer_good_to_know: Array.isArray(d.buyerGoodToKnow) ? d.buyerGoodToKnow : null,
    // Compliance intake facts Cowork reads from the contract + disclosures
    // (data/ATTRIBUTES-INTAKE.md). Drives the checklist's conditional tasks and
    // the deal-card "Intake" chip. Fail-soft below until db/043 adds the column.
    attributes:     (d.attributes && typeof d.attributes === 'object' && !Array.isArray(d.attributes)) ? d.attributes : null,
    updated_at: new Date().toISOString()
  };
  // Escrow-history override (Slice 2). No-op when there's no escrows[].
  const ov = deriveFromEscrows(d);
  if (ov) Object.assign(mapped, ov);
  return mapped;
}

// Upsert a property's escrow history (deals.json escrows[]) into deal_escrows,
// keyed by (deal_id, escrow_key), pruning escrows no longer authored. Fail-soft
// and self-contained: an error is recorded in stats, never thrown, and degrades
// to a no-op before db/055. No escrows[] on the deal → nothing happens.
// Returns a Map of escrow_key → escrow row id so mapDocs can link a document to
// its escrow (Slice 3).
async function writeDealEscrows(supa, dealId, d, stats) {
  const byKey = new Map();
  if (!Array.isArray(d.escrows) || !d.escrows.length) return byKey;
  try {
    const rows = d.escrows.map((e, i) => ({
      deal_id: dealId,
      escrow_key: String((e && (e.key || e.escrow_key)) || `esc${i + 1}`),
      status: ['active', 'cancelled', 'closed'].includes(e && e.status) ? e.status : 'active',
      label: (e && e.label) || `Escrow #${i + 1}`,
      buyer_name: (e && (e.buyer || e.buyerName || e.buyer_name)) || null,
      sale_price: (e && (e.salePrice ?? e.sale_price)) ?? null,
      acceptance_date: (e && (e.acceptance || e.acceptanceDate)) || null,
      escrow_open_date: (e && (e.openEscrowDate || e.escrowOpenDate)) || null,
      coe_date: (e && (e.coe || e.coeDate || e.closingDate)) || null,
      escrow_number: (e && ((e.contacts && e.contacts.escrowNumber) || e.escrowNumber)) || null,
      cancelled_at: (e && (e.cancelledAt || e.cancelled_at)) || null,
      closed_at: (e && (e.closedAt || e.closed_at)) || null,
      sort: (e && (e.sort ?? i)) || i,
      updated_at: new Date().toISOString()
    }));
    const { error } = await supa.from('deal_escrows').upsert(rows, { onConflict: 'deal_id,escrow_key' });
    if (error) { stats.errors.push({ deal_id: dealId, error: error.message }); return; }
    stats.upserted += rows.length;
    // Prune escrows the property no longer lists.
    const want = new Set(rows.map((r) => r.escrow_key));
    const { data: existing } = await supa.from('deal_escrows').select('id, escrow_key').eq('deal_id', dealId);
    for (const r of (existing || [])) if (want.has(r.escrow_key)) byKey.set(r.escrow_key, r.id);
    const stale = (existing || []).filter((r) => !want.has(r.escrow_key)).map((r) => r.id);
    if (stale.length) { await supa.from('deal_escrows').delete().in('id', stale); stats.pruned = (stats.pruned || 0) + stale.length; }
  } catch (e) {
    stats.errors.push({ deal_id: dealId, error: e.message || String(e) });
  }
  return byKey;
}

// Normalize a name into a fingerprint for the key-reuse guard (must match the
// read path's normName: lower-cased, trimmed).
function docFingerprint(name) { return String(name || '').trim().toLowerCase(); }
// A URL-safe slug for deriving a doc_key from a document name.
function docSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
// A visibility authored in deals.json is only honored if it's one of the four
// enum values; anything else (or absent) leaves the doc ungoverned → agent_only.
const VIS_ENUM = new Set(['agent_only', 'seller', 'buyer', 'both']);
const SCOPE_ENUM = new Set(['property', 'transaction']);

// Returns { rows, seeds }: rows for deal_documents (the hourly rebuild), and
// seeds for deal_document_governance (insert-only — a deliberate initial grant
// authored in deals.json as { "visibility": "both" } on a document). Seeds never
// overwrite an agent's CRM grant; that's enforced at the insert step.
function mapDocs(dealId, d, escrowIdByKey, manifest) {
  const out = [];
  const seeds = [];
  const prefix = String(d.id || dealId);
  const seenKeys = new Set();
  // Curated client docs (clientDocuments) are, by their name, the files the
  // CLIENT is meant to see. Default them visible to the client side of THIS deal
  // so they actually reach the portal — they used to default to agent_only, so a
  // seller saw 0 documents even with the listing agreement + advisories on file
  // (324 Augusta). An explicit per-doc visibility still wins, and the governance
  // seed is insert-only, so an agent who later hides one keeps it hidden.
  //
  // A DUAL (side:'both') deal is the exception: clientDocuments are authored from
  // the SELLER's seat (they're the listing's disclosures/agreements — potentially
  // incl. the listing agreement itself), so they default to SELLER-ONLY, never
  // 'both'. If they defaulted to 'both', a dual deal's buyer would auto-receive
  // the seller's whole flat list — including seller-only paperwork — by
  // construction (same failure class as clientTasks/milestones). A buyer instead
  // gets EXECUTED docs via an explicit grant (or a buyerDocuments manifest). This
  // never bites 324 Augusta (it publishes from a folder manifest, which takes its
  // own per-doc visibility), but it closes the hole for any dual deal that leans
  // on the flat clientDocuments path.
  const defaultClientVis = (d.side === 'buyer') ? 'buyer' : 'seller';
  // A document authored agent_only must NOT be client-visible, independent of the
  // (insert-only) governance seed — which never tightens an existing grant, so a
  // doc flipped to agent_only in deals.json otherwise kept leaking to the client.
  // Driving client_safe straight off the visibility closes that: the portal's
  // seller default hides any client_safe:false doc, and an explicit seller/both
  // CRM grant still wins (it's checked first in the portal's maySee).
  const clientSafeFor = (vis, base) => (String(vis || '').toLowerCase() === 'agent_only') ? false : base;
  // Guarantee a unique doc_key per row even if two docs slug to the same thing.
  const uniqueKey = (base) => {
    let k = base, n = 2;
    while (seenKeys.has(k)) { k = `${base}-${n++}`; }
    seenKeys.add(k);
    return k;
  };
  const pushSeed = (doc_key, name, visRaw) => {
    const vis = String(visRaw || '').toLowerCase();
    if (VIS_ENUM.has(vis)) seeds.push({ deal_id: dealId, doc_key, visibility: vis, doc_fingerprint: docFingerprint(name) });
  };
  // A transaction document may name the escrow it belongs to (deals.json
  // "escrow": "esc1", matching an escrows[].key). Resolve it to the escrow row's
  // id so the read paths can hide a dead escrow's docs from a future buyer
  // (Slice 3). Property docs and unlinked docs stay escrow_id = null.
  const resolveEscrow = (key) => (key && escrowIdByKey && escrowIdByKey.get(String(key))) || null;

  // A curated flat list (clientDocuments) is the authoritative set of files the
  // CLIENT should see. When one exists, the compliance `docs` object is treated
  // as INTERNAL only (client_safe:false) so the portal shows just the curated
  // uploads — not the old pre-curation compliance rows stacked alongside them.
  // BUT once a deal publishes real files from its Dropbox folder (a manifest),
  // the folder is authoritative — the deals.json clientDocuments were only a
  // stopgap and would now DUPLICATE the folder's files (324 Augusta showed its
  // advisories twice). So a manifest suppresses the flat clientDocuments.
  const hasManifest = Array.isArray(manifest) && manifest.length > 0;
  const flat = hasManifest
    ? []
    : ([d.clientDocuments, d.portalDocs, d.documents, d.portalDocuments].find(Array.isArray) || []);
  const hasFlat = flat.length > 0;

  const docs = d.docs || {};
  for (const [token, val] of Object.entries(docs)) {
    if (DOC_SKIP.has(token)) continue;
    // A doc value may be a bare status string ("received") OR an object that
    // also carries the link to the executed file: { status, url, scope,
    // visibility, key }.
    const isObj    = val && typeof val === 'object';
    const rawState = isObj ? (val.status ?? val.state ?? val.value) : val;
    const url      = isObj ? (val.url || val.link || val.href || val.file || null) : null;
    // A doc explicitly marked "NOT REQUIRED / N/A / not needed" is not an
    // obligation. With no executed file attached it isn't a document at all —
    // skip it so it never surfaces as a phantom pending signature request (the
    // way a missing doc on a closed deal is skipped below). If a file IS on hand,
    // let it flow through as on_file. (324 Augusta AAA — Cowork 8/26.)
    if (!url && isNotRequired(rawState)) continue;
    const status = docStatus(rawState);
    const base = token.split('_')[0];
    const label = DOC_LABELS[token] || DOC_LABELS[base];
    if (!label) continue;                       // no human name → skip (never raw keys)
    // A null/empty value in the compliance map means Cowork expects this doc but
    // it is NOT on file yet → surface it as 'missing' (was silently dropped),
    // internal-only, so the CRM shows the same file-gap the briefing does.
    const missing = !status;
    // A CLOSED transaction's paperwork is complete by definition. If Cowork's
    // compliance map still lists a doc as not-on-file (missing) after the deal
    // closed, that's a stale gap — the deal closed, the file is moot — not a
    // real outstanding task. Skipping it here stops closed deals from carrying
    // perpetual "pending" document rows (23 such rows across 5 closed deals).
    // Docs that ARE on file still emit, so the closed deal keeps its real
    // paperwork; only the never-filed compliance stubs are retired.
    if (missing && String(d.stage || '').toLowerCase() === 'closed') continue;
    const name = label[0];
    // Stable key: explicit `key` wins, else derived from the (stable) token.
    const doc_key = uniqueKey(String((isObj && (val.key || val.doc_key)) || `${prefix}-${token.toLowerCase()}`));
    // Scope: compliance disclosures are property-scoped by default (they follow
    // the property to the next buyer); an explicit scope overrides.
    const scope = SCOPE_ENUM.has(String(isObj && val.scope || '').toLowerCase())
      ? String(val.scope).toLowerCase() : 'property';
    out.push({
      deal_id: dealId,
      doc_type: base.slice(0, 12),
      name,
      sub: label[1] || null,
      // A not-on-file doc is 'pending' (a valid enum value; 'missing' is NOT in
      // the constraint) and carries the 'missing' marker in status_raw so the
      // CRM health rollup (crm-deals.js) can still find it. A real doc keeps its
      // original prose in status_raw.
      status: missing ? 'pending' : status,
      status_raw: missing ? 'missing' : String(rawState),
      doc_url: url ? String(url) : null,         // link to the executed document, if provided
      doc_key,
      scope,
      escrow_id: resolveEscrow(isObj && val.escrow),
      client_safe: missing ? false : !hasFlat,   // legacy flag; governance is the real gate
      updated_at: new Date().toISOString()
    });
    if (!missing && isObj) pushSeed(doc_key, name, val.visibility);
  }

  // SIMPLE PATH — a flat list of files to drop straight into the client portal.
  // No compliance token, no status required: Cowork lists the deal's Dropbox
  // files + share links and writes them here. Any of these keys works.
  for (const doc of flat) {
    if (!doc) continue;
    const name = String(doc.name || doc.title || doc.label || '').trim();
    const url  = doc.url || doc.link || doc.href || doc.file || null;
    if (!name && !url) continue;
    const dispName = name || 'Document';
    const doc_key = uniqueKey(String(doc.key || doc.doc_key || `${prefix}-${docSlug(dispName) || 'doc'}`));
    // Flat client docs are transaction-scoped by default (they belong to a
    // particular deal); an explicit scope overrides.
    const scope = SCOPE_ENUM.has(String(doc.scope || '').toLowerCase())
      ? String(doc.scope).toLowerCase() : 'transaction';
    out.push({
      deal_id: dealId,
      doc_type: extType(name || url),
      name: dispName,
      sub: doc.sub || doc.note || null,
      status: doc.status ? docStatus(doc.status) : null,   // status is OPTIONAL here
      status_raw: doc.status != null ? String(doc.status) : null,
      doc_url: url ? String(url) : null,
      doc_key,
      scope,
      escrow_id: resolveEscrow(doc.escrow),
      client_safe: clientSafeFor(doc.visibility || defaultClientVis, doc.client_safe !== false), // agent_only ⇒ hidden from client
      updated_at: new Date().toISOString()
    });
    pushSeed(doc_key, dispName, doc.visibility || defaultClientVis);
  }

  // BUYER DOCUMENT LIST (buyerDocuments) — the executed files the BUYER sees on a
  // dual/buyer-side deal, authored by Cowork parallel to clientDocuments (same
  // shape: { name, url, sub?, status?, key?, scope?, visibility? }). This is the
  // buyer counterpart to clientDocuments, exactly like buyerTasks/buyerMilestones
  // are to clientTasks/milestones — so a buyer never inherits the seller's list
  // and Cowork can curate the buyer's set from Dropbox without an agent granting
  // by hand. Always processed (a folder manifest does NOT suppress it), keyed
  // under a `-buyer-` prefix so it never collides with the seller docs, and
  // seeded buyer-visible by default (set visibility:"both" on a row to show it to
  // the seller too).
  const buyerFlat = Array.isArray(d.buyerDocuments) ? d.buyerDocuments : [];
  for (const doc of buyerFlat) {
    if (!doc) continue;
    const name = String(doc.name || doc.title || doc.label || '').trim();
    const url  = doc.url || doc.link || doc.href || doc.file || null;
    if (!name && !url) continue;
    const dispName = name || 'Document';
    const doc_key = uniqueKey(String(doc.key || doc.doc_key || `${prefix}-buyer-${docSlug(dispName) || 'doc'}`));
    const scope = SCOPE_ENUM.has(String(doc.scope || '').toLowerCase())
      ? String(doc.scope).toLowerCase() : 'transaction';
    out.push({
      deal_id: dealId,
      doc_type: extType(name || url),
      name: dispName,
      sub: doc.sub || doc.note || null,
      status: doc.status ? docStatus(doc.status) : null,
      status_raw: doc.status != null ? String(doc.status) : null,
      doc_url: url ? String(url) : null,
      doc_key,
      scope,
      escrow_id: resolveEscrow(doc.escrow),
      client_safe: true,
      updated_at: new Date().toISOString()
    });
    pushSeed(doc_key, dispName, doc.visibility || 'buyer');
  }

  // FOLDER-PUBLISHED PATH — documents published from Dropbox share folders by
  // publish-docs-from-dropbox, listed in data/portal-docs/<id>.json. Each entry
  // already carries the scope + visibility derived from the folder it sat in, so
  // this is just a transcription. Passed in (fetched fresh by the caller); a deal
  // with no published docs gets an empty array.
  if (Array.isArray(manifest)) {
    for (const doc of manifest) {
      if (!doc || !doc.name) continue;
      const doc_key = uniqueKey(String(doc.key || `${prefix}-${docSlug(doc.name) || 'doc'}`));
      const scope = SCOPE_ENUM.has(String(doc.scope || '').toLowerCase()) ? String(doc.scope).toLowerCase() : 'property';
      out.push({
        deal_id: dealId,
        doc_type: extType(doc.name || doc.url),
        name: String(doc.name),
        sub: null,
        status: null,
        status_raw: null,
        doc_url: doc.url ? String(doc.url) : null,
        doc_key,
        scope,
        escrow_id: resolveEscrow(doc.escrow),
        client_safe: clientSafeFor(doc.visibility, true), // agent_only folder ⇒ hidden from client
        updated_at: new Date().toISOString()
      });
      // A folder-published doc with NO recognised audience defaults to agent_only
      // (db/053's intent: "default to agent_only on any miss"), so a prior sale's
      // paperwork dropped into an unlabelled folder never fails open to the
      // client. An explicit seller/buyer/both grant still shows it.
      pushSeed(doc_key, String(doc.name), doc.visibility || 'agent_only');
    }
  }
  return { rows: out, seeds };
}

// Rebuild one deal's documents, resiliently. Deletes then inserts (idempotent).
// Tries the whole batch first (one round-trip when every row is clean); if a bad
// row aborts the batch, falls back to per-row so the rest of the deal's docs
// still land, collecting each failure into `stats` instead of throwing. A single
// malformed doc must never wipe a deal's entire document set.
async function writeDealDocs(supa, dealId, rows, stats) {
  await supa.from('deal_documents').delete().eq('deal_id', dealId);
  if (!rows.length) return;
  // If the scope/doc_key columns (db/052) aren't there yet, strip them and retry
  // rather than dropping the deal's docs — they're restored on the next sync
  // once migrated. (Same guard the deal upsert uses for not-yet-migrated cols.)
  const stripNew = (r) => { const { doc_key, scope, escrow_id, ...rest } = r; return rest; };
  const insert = async (payload) => {
    let { error } = await supa.from('deal_documents').insert(payload);
    if (error && /(doc_key|scope|escrow_id)/i.test(error.message || '')) {
      const stripped = Array.isArray(payload) ? payload.map(stripNew) : stripNew(payload);
      ({ error } = await supa.from('deal_documents').insert(stripped));
    }
    return error;
  };
  const error = await insert(rows);
  if (!error) { stats.inserted += rows.length; return; }
  for (const r of rows) {
    const e1 = await insert(r);
    if (e1) {
      stats.skipped++;
      stats.errors.push({ deal_id: dealId, name: r.name || null, status: r.status || null, error: e1.message });
    } else {
      stats.inserted++;
    }
  }
}

// A short type tag from a filename / URL extension (PDF / DOC / IMG / …).
function extType(s) {
  const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(String(s || ''));
  const e = (m ? m[1] : '').toLowerCase();
  if (e === 'pdf') return 'PDF';
  if (e === 'doc' || e === 'docx') return 'DOC';
  if (['jpg','jpeg','png','heic','gif','webp'].includes(e)) return 'IMG';
  if (['xls','xlsx','csv'].includes(e)) return 'XLS';
  return e ? e.toUpperCase().slice(0, 4) : 'DOC';
}

// A contact linked to a deal that's in escrow or closed is, by definition, a
// client — not a lead. Roll every such lead's classification forward to match
// the deal, so the roster stops showing them under "Leads" and the agent never
// has to swap them by hand. Never touches anyone already a client/past_client/
// sphere/do-not-contact. Returns the number of leads actually updated.
async function promoteAttachedLeads(supa) {
  // 1. Deals under contract (pending) or closed, keyed by id.
  const { data: deals, error: dErr } = await supa.from('deals').select('id, stage').in('stage', ['pending', 'closed']);
  if (dErr || !deals || !deals.length) return 0;
  const stageByDeal = new Map(deals.map((d) => [d.id, d.stage]));

  // 2. Their parties (lead ↔ deal ↔ role).
  const { data: parties, error: pErr } = await supa.from('deal_parties')
    .select('deal_id, lead_id, role').in('deal_id', [...stageByDeal.keys()]);
  if (pErr || !parties || !parties.length) return 0;

  // 3. Fold to one desired classification per lead. Closed beats pending; a
  //    buyer role sets buyer_stage, a seller role sets seller_stage (a lead on
  //    both sides gets both).
  const want = new Map(); // lead_id -> { pipeline, closed, buyer, seller }
  for (const p of parties) {
    if (!p.lead_id) continue;
    const stage = stageByDeal.get(p.deal_id);
    const closed = stage === 'closed';
    const isBuyer = /buyer/.test(p.role || '');
    const isSeller = /seller/.test(p.role || '') || !isBuyer; // default to seller side
    const cur = want.get(p.lead_id) || { closed: false, buyer: false, seller: false };
    cur.closed = cur.closed || closed;
    cur.buyer = cur.buyer || isBuyer;
    cur.seller = cur.seller || isSeller;
    want.set(p.lead_id, cur);
  }
  const leadIds = [...want.keys()];
  if (!leadIds.length) return 0;

  // 4. Current lead state — skip anyone already tracked, and only write a diff.
  const { data: leads, error: lErr } = await supa.from('leads')
    .select('id, contact_type, pipeline_stage, buyer_stage, seller_stage').in('id', leadIds);
  if (lErr || !leads) return 0;

  const TRACKED = new Set(['client', 'past_client', 'sphere', 'do_not_call', 'do_not_contact']);
  let promoted = 0;
  for (const l of leads) {
    if (TRACKED.has(l.contact_type)) continue;         // never touch an existing client/etc.
    const w = want.get(l.id);
    const sideStage = w.closed ? 'closed' : 'in_escrow';
    const pipeline  = w.closed ? 'closed' : 'under_contract';
    const patch = {};
    if (l.contact_type !== 'client') patch.contact_type = 'client';
    if (l.pipeline_stage !== pipeline) patch.pipeline_stage = pipeline;
    if (w.buyer  && l.buyer_stage  !== sideStage) patch.buyer_stage  = sideStage;
    if (w.seller && l.seller_stage !== sideStage) patch.seller_stage = sideStage;
    if (!Object.keys(patch).length) continue;
    const { error } = await supa.from('leads').update(patch).eq('id', l.id);
    if (!error) promoted++;
  }
  return promoted;
}

// Split a deal's `client` string into individual people. Handles couples
// ("Roger & Kristin Quillen" → Roger Quillen + Kristin Quillen, sharing the
// surname) and "A and B", "A / B", "A, B". A person needs a first AND last name
// to be usable — a bare first name ("Jim & Yvonne" with no surname) is too thin
// to make a real contact or match reliably, so it's dropped.
function splitClientNames(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const parts = s.split(/\s*(?:&|\band\b|\/|,|\+)\s*/i).map((p) => p.trim()).filter(Boolean);
  // Shared surname = the last token of the LAST part, when that part has 2+ tokens.
  const lastToks = (parts[parts.length - 1] || '').split(/\s+/);
  const sharedLast = lastToks.length > 1 ? lastToks[lastToks.length - 1] : null;
  const out = [];
  for (const p of parts) {
    const t = p.split(/\s+/).filter(Boolean);
    let first, last;
    if (t.length >= 2) { first = t.slice(0, -1).join(' '); last = t[t.length - 1]; }
    else { first = t[0] || ''; last = sharedLast || ''; }     // bare first name inherits shared surname
    if (first && last) out.push({ first, last });
  }
  return out;
}

// Auto-attach a deal's client to it, so an agent doesn't wire every contact by
// hand. Conservative on purpose: matches an EXISTING contact by exact
// normalized full name (single match only — ambiguous names are skipped, never
// guessed), and when no contact exists it CREATES one from the deal's client
// name (client-classified, assigned to the deal's agent). Existing links are
// never duplicated; only the deal's own client name is used, not co-agents or
// escrow. Everything it does is visible on the contact card, where a wrong link
// can be corrected. Returns { linked, created }.
async function autoLinkPartiesByName(supa, dealsJson) {
  const { data: dealRows } = await supa.from('deals').select('id, source_key, side, stage');
  if (!dealRows || !dealRows.length) return { linked: 0, created: 0 };
  const bySrc = new Map(dealRows.map((d) => [d.source_key, d]));

  const { data: leads } = await supa.from('leads').select('id, first_name, last_name');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const nameIx = new Map();
  for (const l of (leads || [])) {
    const n = norm(`${l.first_name || ''} ${l.last_name || ''}`);
    if (!n) continue;
    if (!nameIx.has(n)) nameIx.set(n, []);
    nameIx.get(n).push(l.id);
  }

  // Which deals are already wired (have ≥1 party)? We won't AUTO-CREATE contacts
  // for those — a deal the humans already linked shouldn't spawn new contacts
  // from a possibly-messy client string (e.g. "Jim  Yvonne" with no surname).
  const { data: allParties } = await supa.from('deal_parties').select('deal_id');
  const wiredDeals = new Set((allParties || []).map((p) => p.deal_id));

  let linked = 0, created = 0, spousesRelated = 0;
  for (const d of (dealsJson || [])) {
    const dr = bySrc.get(d.id);
    if (!dr) continue;
    const role = dr.side === 'buyer' ? 'buyer' : 'seller';
    const agent = /james/i.test(d.agent || '') ? 'james' : 'sara';
    // De-dupe the person list drawn from all client-name sources on this deal.
    const persons = [];
    const seen = new Set();
    for (const src of [d.client, d.clientName, d.listing && d.listing.client]) {
      for (const p of splitClientNames(src)) {
        const key = norm(`${p.first} ${p.last}`);
        if (key && !seen.has(key)) { seen.add(key); persons.push(p); }
      }
    }
    const resolvedIds = [];                             // leadIds resolved for this deal, in order
    for (const p of persons) {
      const key = norm(`${p.first} ${p.last}`);
      const matches = nameIx.get(key);
      if (matches && matches.length > 1) continue;      // ambiguous → skip, never guess
      let leadId = matches && matches.length === 1 ? matches[0] : null;
      if (!leadId) {
        if (wiredDeals.has(dr.id)) continue;            // already-wired deal → don't spawn contacts
        // No such contact — create one from the deal's client name.
        const { data: ins, error: insErr } = await supa.from('leads').insert({
          first_name:     p.first,
          last_name:      p.last,
          source:         'deal_auto',
          lead_type:      role,
          assigned_agent: agent,
          contact_type:   'client',
          notes:          `Auto-created from deal ${d.id} (${role}).`
        }).select('id').single();
        if (insErr || !ins) continue;
        leadId = ins.id;
        created++;
        nameIx.set(key, [leadId]);                      // so a later deal reuses this contact
      }
      resolvedIds.push(leadId);
      const { data: ex } = await supa.from('deal_parties').select('deal_id').eq('deal_id', dr.id).eq('lead_id', leadId).limit(1);
      if (ex && ex.length) continue;                    // already linked
      const { error } = await supa.from('deal_parties').insert({ deal_id: dr.id, lead_id: leadId, role });
      if (!error) linked++;
    }
    // A deal whose client was TWO people (a couple) → relate them as spouses,
    // symmetrically, so the tie shows on both cards. Only for a clean pair, and
    // only when the relationship isn't already recorded. Fail-soft until db/044.
    if (persons.length === 2 && resolvedIds.length === 2 && resolvedIds[0] !== resolvedIds[1]) {
      const [a, b2] = resolvedIds;
      const { data: exRel } = await supa.from('lead_relationships').select('lead_id').eq('lead_id', a).eq('related_lead_id', b2).limit(1).then((r) => r, () => ({ data: null }));
      if (!exRel || !exRel.length) {
        const { error: rErr } = await supa.from('lead_relationships').upsert([
          { lead_id: a,  related_lead_id: b2, relationship: 'spouse' },
          { lead_id: b2, related_lead_id: a,  relationship: 'spouse' }
        ], { onConflict: 'lead_id,related_lead_id', ignoreDuplicates: true }).then((r) => r, (e) => ({ error: e }));
        if (!rErr) spousesRelated++;
      }
    }
  }
  return { linked, created, spouses_related: spousesRelated };
}

// ---------------------------------------------------------------------------
// Rule-derived agent workflow checklist (SPEC_agent_workflow_checklist.md).
// Ports BeClause's TaskDefinition sets (data/checklist_task_definitions.json)
// into per-deal tasks that flow through the SAME agent_tasks → Tasks-tab pipe
// as the daily briefing, distinguished by source='checklist'.
//
// v1 scope (deliberately narrow — see the review before build):
//   • In-escrow deals only (stage='pending'), where a missed disclosure carries
//     real liability. Widen STAGES to include 'preparing'/'listing' later.
//   • REQUIRED tasks only. Conditional (trigger) tasks are skipped — the
//     property-attribute intake facts (HOA, solar, pre-1978…) aren't on deals
//     yet, so triggers can't be evaluated. Exemptions likewise can't be
//     verified, so we don't drop tasks on unverifiable exemptions in v1.
//   • Real due dates where Cowork has read the contract. The deal's `timeline`
//     (acceptance = Day 0, per-contingency `overrides`, paused clock) is the
//     SAME source the briefing calendar uses (deal-timeline.js), so a task's
//     date equals the calendar's. When acceptance is absent (offer just in) or
//     the clock is paused (e.g. bankruptcy-court sale), the task carries only a
//     phase label — no invented date.
//   • pre_listing tasks are skipped for an already-in-escrow deal (retrospective
//     noise — that prep is done by the time an offer is accepted).
// Identity = stable source_key `checklist:<dealId>:<code>`, so check-offs
// survive every re-sync (insert-only; existing rows are never rewritten).
// ---------------------------------------------------------------------------
const CHECKLIST_STAGES = new Set(['pending']);
const PHASE_LABEL = { pre_listing: 'Pre-listing', offer: 'Offer', escrow: 'Escrow', contingency: 'Contingency', pre_close: 'Pre-close', closing: 'Closing' };
const CAT_LABEL   = { document: 'Document', disclosure: 'Disclosure', inspection: 'Inspection', contingency: 'Contingency', closing: 'Closing', communication: 'Communication' };
const CL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CL_DEFAULT_CONTINGENCY_DAYS = 17;  // CA RPA default (mirrors deal-timeline.js)

function checklistShortAddr(a) { return String(a || '').split(',')[0].trim(); }
// Add whole days to a 'YYYY-MM-DD' date, calendar-sense (mirrors
// deal-timeline.js addDays so checklist dates == briefing-calendar dates).
function clAddDays(s, n) {
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function clFmt(s) { const [y, m, d] = String(s).split('-').map(Number); return `${CL_MONTHS[m - 1]} ${d}`; }

// --- Trigger / exemption evaluation against the deal's `attributes` block ----
// Cowork writes `attributes` per deal (see data/ATTRIBUTES-INTAKE.md) from the
// contract + disclosure package. Absent → the conditional layer stays dark for
// that deal (we never GUESS a legal disclosure trigger) and it earns a
// self-clearing "confirm compliance facts" reminder instead.
export function hasAttributes(d) {
  const a = d && d.attributes;
  return !!(a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length);
}
function triggerTrue(key, a) {
  switch (key) {
    case 'is_hoa':              return a.hoa === true;
    case 'pre_1978':            return Number.isFinite(+a.year_built) && +a.year_built > 0 && +a.year_built < 1978;
    case 'has_solar':           return a.solar === true;
    case 'solar_leased':        return a.solar === true && a.solar_leased === true;
    case 'mello_roos':
    case 'special_tax_district': return a.mello_roos === true;
    case 'is_tenant_occupied':  return a.tenant_occupied === true;
    default:                    return false;
  }
}
// Exemptions are only honored when we can VERIFY them from explicit facts —
// never inferred — so an unverifiable exemption can't silently drop a required
// disclosure. All key off the attributes block (present-only).
function exemptionMatch(key, a) {
  switch (key) {
    case 'reo':               return a.seller_type === 'reo';
    case 'foreclosure':       return a.seller_type === 'foreclosure';
    case 'probate_court':     return a.seller_type === 'probate' || a.seller_type === 'probate_court';
    case 'cash_purchase':     return a.financing === 'cash' || a.financing_type === 'cash';
    case 'appraisal_waived':  return a.appraisal_waived === true;
    case 'loan_waived':       return a.loan_waived === true;
    case 'inspection_waived': return a.inspection_waived === true;
    default:                  return false;
  }
}

// The deal's contract clock: Day 0 (acceptance) + per-contingency day counts.
// null day0 → no dates (acceptance not read yet, or clock paused).
function checklistClock(d) {
  const tl = (d && d.timeline) || {};
  if (Object.prototype.hasOwnProperty.call(tl, 'clockStart') && tl.clockStart === null) return null; // paused
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const day0 = isDate(tl.clockStart) ? tl.clockStart
            : isDate(tl.acceptance)  ? tl.acceptance
            : isDate(d && d.openEscrowDate) ? d.openEscrowDate : null;
  if (!day0) return null;
  const base = Number.isFinite(+tl.contingencyDays) ? +tl.contingencyDays : CL_DEFAULT_CONTINGENCY_DAYS;
  return { day0, overrides: tl.overrides || {}, base };
}
// A task's due date from the clock: N days from acceptance, or the named
// contingency's period (override, else the 17-day default).
function checklistDueDate(t, clock) {
  if (!clock) return null;
  if (Number.isFinite(+t.days_from_acceptance)) return clAddDays(clock.day0, +t.days_from_acceptance);
  if (t.days_from_contingency) {
    const kind = String(t.days_from_contingency).replace(/_days$/, '');   // inspection_days → inspection
    const days = Number.isFinite(+clock.overrides[kind]) ? +clock.overrides[kind] : clock.base;
    return clAddDays(clock.day0, days);
  }
  return null;
}

export function buildChecklistRows(deals, defs) {
  const normAgent = (a) => { a = String(a || '').toLowerCase(); return /james/.test(a) ? 'james' : (/both/.test(a) ? 'both' : 'sara'); };
  const rows = [];
  for (const d of (deals || [])) {
    if (!CHECKLIST_STAGES.has(d.stage)) continue;
    const sets = [];
    if (d.side === 'listing' || d.side === 'both') sets.push(defs.sell_side_tasks || []);
    if (d.side === 'buyer'   || d.side === 'both') sets.push(defs.buy_side_tasks || []);
    if (!sets.length) sets.push(defs.sell_side_tasks || []);   // unknown side → sell-side default
    const client = ((d.client && String(d.client).trim()) || checklistShortAddr(d.address) || 'Deal').slice(0, 120);
    const agent = normAgent(d.agent);
    const clock = checklistClock(d);
    const attrs = hasAttributes(d) ? d.attributes : null;
    for (const list of sets) {
      for (const t of list) {
        if (t.phase === 'pre_listing') continue;            // retrospective for an in-escrow deal
        const level = t.requirement_level;
        if (level !== 'required' && level !== 'conditional') continue;   // v1: no 'optional'
        // Exemptions — honored only when we can verify them from the attributes.
        if (attrs && Array.isArray(t.exemptions) && t.exemptions.some((k) => exemptionMatch(k, attrs))) continue;
        // Conditional (trigger) tasks fire ONLY when the intake facts are present
        // AND a trigger is satisfied — never guessed from absent data.
        if (level === 'conditional') {
          if (!attrs) continue;
          if (!Array.isArray(t.triggers) || !t.triggers.some((k) => triggerTrue(k, attrs))) continue;
        }
        const due = checklistDueDate(t, clock);
        rows.push({
          agent,
          client,
          title: String(t.description || '').slice(0, 200),
          sub: [PHASE_LABEL[t.phase] || t.phase, CAT_LABEL[t.category] || t.category].filter(Boolean).join(' · ').slice(0, 120),
          note: null,
          // Real date when the contract's been read; else the phase label.
          due_label: (due ? `Due ${clFmt(due)}` : (PHASE_LABEL[t.phase] || t.phase || 'Workflow')).slice(0, 40),
          source: 'checklist',
          source_key: `checklist:${d.id}:${t.code}`.slice(0, 120),
          done: false
        });
      }
    }
    // Self-clearing signal: an in-escrow deal with no intake block yet gets ONE
    // reminder so Sara sees at a glance which deals Cowork still owes facts on.
    // It's pruned automatically the moment `attributes` lands (then the real
    // conditional tasks appear in its place).
    if (!attrs) {
      rows.push({
        agent,
        client,
        title: '⚠ Confirm compliance facts (HOA · solar · pre-1978 · tenant · seller type) to finish this deal’s checklist',
        sub: 'Compliance intake',
        note: null,
        due_label: 'Needed',
        source: 'checklist',
        source_key: `checklist:${d.id}:_intake`.slice(0, 120),
        done: false
      });
    }
  }
  return rows;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // This endpoint reports the outcome of the last sync (ran_at, source_version,
  // per-pool counts). Cowork's briefing reads it to verify the hourly cron
  // actually ran — so the response must ALWAYS be live. Without these, Vercel's
  // CDN froze a ~28h-old body (ran_at 8/25, source_version 10.1) and the briefing
  // could never tell whether the sync worked (Cowork 8/26). Mirror the
  // morning-brief / briefing-calendar no-store trio exactly.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  // Auth: allow two callers.
  //  1. Manual trigger — the bookmark URL with ?key=<SYNC_SECRET>.
  //  2. Vercel Cron — scheduled runs carry an "x-vercel-cron" header, and
  //     (if set) an "Authorization: Bearer <CRON_SECRET>". Either is accepted.
  const cronSecret = process.env.CRON_SECRET;
  const bearer     = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okManual   = checkSyncKey(req.query?.key).ok;
  const okCron     = !!req.headers['x-vercel-cron'] || (cronSecret && bearer === cronSecret);
  if (!okManual && !okCron) return fail(res, 401, 'bad key');

  try {
    const { data, source: dealsSource } = await loadDeals();
    const supa = adminClient();

    const active = (data.deals || []).filter((d) => ['offer', 'pending', 'listing', 'closed', 'preparing'].includes(d.stage));
    let dealsUpserted = 0;
    const errors = [];
    // Per-row outcomes for the two write loops that used to abort the whole run.
    const docStats  = { inserted: 0, skipped: 0, errors: [] };
    const taskStats = { created: 0, skipped_duplicates: 0 };
    const escrowStats = { upserted: 0, pruned: 0, errors: [] };
    // Deals that have LEFT escrow — their lingering timeline items get retired
    // after the loop so a dead escrow can't keep phantom deadlines on a portal.
    const nonEscrowDealIds = [];
    // Subset that left escrow to a NON-closed stage (listing/preparing — the
    // escrow fell through). These also lose their completed escrow milestones
    // from the client portal; a genuinely CLOSED deal keeps that history.
    const nonEscrowFellThroughIds = [];
    // Insert-only visibility grants authored in deals.json (a doc with an explicit
    // "visibility"). Applied after the loop; never overwrite an agent's CRM grant.
    const govSeeds = [];

    for (const d of active) {
      try {
        const mapped = mapDeal(d);
        // Manual upsert (select → update|insert) so we DON'T depend on a unique
        // constraint on source_key existing in the (ad-hoc) deals table. A
        // missing constraint would make .upsert(onConflict) throw and abort the
        // whole sync, zeroing every listing.
        let ex = null;
        {
          const sel = await supa.from('deals').select('id, agent_note').eq('source_key', mapped.source_key).maybeSingle();
          if (sel.error && /agent_note/i.test(sel.error.message || '')) {
            const sel2 = await supa.from('deals').select('id').eq('source_key', mapped.source_key).maybeSingle();
            if (sel2.error) throw new Error(`lookup: ${sel2.error.message}`);
            ex = sel2.data;
          } else if (sel.error) {
            throw new Error(`lookup: ${sel.error.message}`);
          } else {
            ex = sel.data;
          }
        }

        // Preserve a note the agent PUBLISHED in the CRM. deals.json always ships
        // the note as a draft, so without this a routine re-sync would silently
        // un-publish a live client note. Keep 'published' as long as the body is
        // unchanged; if Cowork edited the note text, it reverts to draft and needs
        // re-publishing (so the client never sees an edit the agent didn't OK).
        const exNote = ex && ex.agent_note && typeof ex.agent_note === 'object' && !Array.isArray(ex.agent_note) ? ex.agent_note : null;
        if (exNote && exNote.status === 'published' && mapped.agent_note &&
            String(exNote.body || '').trim() === String(mapped.agent_note.body || '').trim()) {
          mapped.agent_note = {
            ...mapped.agent_note,
            status: 'published',
            published_at: exNote.published_at || null,
            published_by: exNote.published_by || null
          };
        }

        // If a newly-added column (e.g. listing_meta before migration 019 runs)
        // isn't in the table yet, retry once without it rather than dropping the
        // whole deal — a missing optional column must never blank the roster.
        const writeDeal = async (payload) => {
          if (ex) {
            const { error } = await supa.from('deals').update(payload).eq('id', ex.id);
            return { error, id: ex.id };
          }
          const { data: ins, error } = await supa.from('deals').insert(payload).select('id').single();
          return { error, id: ins?.id };
        };
        let { error: wErr, id: dealId } = await writeDeal(mapped);
        // If a not-yet-migrated optional column (listing_meta / timeline) is
        // referenced before its migration runs, retry without them rather than
        // dropping the whole deal — a missing column must never blank the list.
        // They're restored automatically on the next sync once migrated.
        if (wErr && /(listing_meta|timeline|milestones|agent_note|client_tasks|buyer_tasks|buyer_milestones|good_to_know|buyer_good_to_know|contacts|attributes)/i.test(wErr.message || '')) {
          const { listing_meta, timeline, milestones, buyer_milestones, agent_note, client_tasks, buyer_tasks, good_to_know, buyer_good_to_know, contacts, attributes, ...safe } = mapped;
          ({ error: wErr, id: dealId } = await writeDeal(safe));
        }
        if (wErr) throw new Error(`${ex ? 'update' : 'insert'}: ${wErr.message}`);
        dealsUpserted++;
        // "In escrow" = has an ACTIVE escrow when escrows[] is authored; else the
        // raw stage. A property left at stage 'listing' while carrying an active
        // escrow must NOT have its live timeline retired.
        const inEscrow = (Array.isArray(d.escrows) && d.escrows.length) ? !!activeEscrow(d) : ESCROW_STAGES.has(d.stage);
        if (!inEscrow) {
          nonEscrowDealIds.push(dealId);
          if (String(d.stage) !== 'closed') nonEscrowFellThroughIds.push(dealId);
        }

        // Upsert this property's escrow history FIRST (Slice 2/3) so documents
        // can be linked to their escrow. No-op without escrows[]; returns
        // escrow_key → id for mapDocs.
        const escrowIdByKey = await writeDealEscrows(supa, dealId, d, escrowStats);

        // Rebuild this deal's documents (delete then insert = idempotent).
        // Resilient: a bad doc row is collected in docStats, never thrown, so it
        // can't drop the deal's other docs or abort the run.
        const manifest = (d.docFolder || DOC_FOLDER_OVERRIDES[d.id]) ? await loadManifest(d.id) : [];
        const { rows: docRows, seeds: docSeeds } = mapDocs(dealId, d, escrowIdByKey, manifest);
        await writeDealDocs(supa, dealId, docRows, docStats);
        for (const s of docSeeds) govSeeds.push({ ...s, deal_id: dealId });
      } catch (e) {
        // Keep going — one malformed deal must never zero out every listing.
        errors.push({ deal: d.id, address: d.address || null, error: e.message || String(e) });
      }
    }

    // Retire orphaned escrow artifacts. A deal that has LEFT escrow (now
    // listing / closed / preparing…) keeps its deal_timeline_items, which still
    // read 'upcoming' and generate deadlines/COE — e.g. 433 E Highway 4 showed a
    // live close-of-escrow to its sellers after the 8/5 cancellation. Mark those
    // open items 'na' (kept for history, no longer live). The timeline JSONB is
    // already dropped for these in mapDeal.
    let timelineItemsRetired = 0;
    try {
      if (nonEscrowDealIds.length) {
        // Retire to 'na' AND pull them off the client portal, and clear the dead
        // due_date — a cancelled escrow was still rendering "Close of Escrow —
        // 8/10" to sellers with no buyer (Bug 5). client_visible=false + null
        // date means the row survives for agent history but shows nothing client-
        // facing.
        const { data: retired } = await supa.from('deal_timeline_items')
          .update({ status: 'na', client_visible: false, due_date: null, updated_at: new Date().toISOString() })
          .in('deal_id', nonEscrowDealIds).in('status', ['upcoming', 'action']).select('id');
        timelineItemsRetired = (retired || []).length;
        // Also fix already-'na' rows from earlier runs that kept their dates/visibility.
        await supa.from('deal_timeline_items')
          .update({ client_visible: false, due_date: null, updated_at: new Date().toISOString() })
          .in('deal_id', nonEscrowDealIds).eq('status', 'na').eq('client_visible', true)
          .then(() => {}, () => {});
      }
      // Deals that fell OUT of escrow (not closed) also stop showing their
      // COMPLETED escrow milestones to the client — the 'done' rows like
      // "Escrow opened" / "Contract accepted". 324 Augusta was still showing
      // sellers an escrow that died 8/14. Status stays 'done' for agent history;
      // only client_visible flips. (A CLOSED deal is excluded, so it keeps its
      // real sale history.)
      if (nonEscrowFellThroughIds.length) {
        const { data: hiddenDone } = await supa.from('deal_timeline_items')
          .update({ client_visible: false, updated_at: new Date().toISOString() })
          .in('deal_id', nonEscrowFellThroughIds).eq('status', 'done').eq('client_visible', true).select('id');
        timelineItemsRetired += (hiddenDone || []).length;
      }
    } catch (e) { errors.push({ deal: 'retire-timeline-items', error: e.message || String(e) }); }

    // Seed visibility grants authored in deals.json (a document with an explicit
    // "visibility"). INSERT-ONLY: a seed creates a governance row only when none
    // exists for (deal_id, doc_key), so it can NEVER overwrite an agent's live CRM
    // grant or widen a doc that was deliberately narrowed. set_by='seed' marks its
    // origin. Fail-soft + degrades to a no-op before db/053. This is the ONLY way
    // the file touches visibility, and only in the safe (create-if-absent) direction.
    let govSeeded = 0;
    try {
      if (govSeeds.length) {
        // Dedup by (deal_id, doc_key); last write wins within a run.
        const byKey = new Map();
        for (const s of govSeeds) byKey.set(`${s.deal_id}|${s.doc_key}`, s);
        const wanted = [...byKey.values()];
        const dealIds = [...new Set(wanted.map((s) => s.deal_id))];
        const { data: existing, error: exErr } = await supa.from('deal_document_governance')
          .select('deal_id, doc_key').in('deal_id', dealIds);
        if (exErr) throw new Error(exErr.message);
        const have = new Set((existing || []).map((r) => `${r.deal_id}|${r.doc_key}`));
        const toInsert = wanted
          .filter((s) => !have.has(`${s.deal_id}|${s.doc_key}`))
          .map((s) => ({ deal_id: s.deal_id, doc_key: s.doc_key, visibility: s.visibility, doc_fingerprint: s.doc_fingerprint, set_by: 'seed' }));
        if (toInsert.length) {
          const { error: insErr } = await supa.from('deal_document_governance').insert(toInsert);
          if (insErr) throw new Error(insErr.message);
          govSeeded = toInsert.length;
        }
      }
    } catch (e) { errors.push({ deal: 'governance-seed', error: e.message || String(e) }); }

    // Reconcile: the deals table must MIRROR the active feed. A deal that
    // dropped out of deals.json — removed outright, or moved to a retired stage
    // like 'inactive'/'dispute' — was previously left frozen at its last stage,
    // so e.g. an offer Cowork retired lingered as a phantom in the Offers tab.
    // Prune any table row whose source_key is no longer an active deal. All
    // child rows (documents, parties, timeline, milestones) cascade on delete.
    // Guarded: never prune when the active set is empty, so a bad/empty deploy
    // of deals.json can't wipe the table.
    let dealsPruned = 0;
    try {
      const activeKeys = new Set(active.map((d) => d.id).filter(Boolean));
      if (activeKeys.size > 0) {
        const { data: existing, error: exErr } = await supa.from('deals').select('source_key');
        if (exErr) throw new Error(exErr.message);
        const orphans = [...new Set((existing || [])
          .map((r) => r.source_key)
          .filter((k) => k && !activeKeys.has(k)))];
        if (orphans.length) {
          const { error: pErr } = await supa.from('deals').delete().in('source_key', orphans);
          if (pErr) throw new Error(pErr.message);
          dealsPruned = orphans.length;
        }
      }
    } catch (e) {
      errors.push({ deal: 'prune-orphans', error: e.message || String(e) });
    }

    // Belt-and-suspenders: sweep orphaned deal_documents. The deals prune above
    // relies on an ON DELETE CASCADE to remove a pruned deal's child docs, but a
    // stranded doc (a stuck "pending" row that keeps surfacing after its deal is
    // gone) is exactly the symptom of that cascade not firing — e.g. a doc row
    // written under a deal_id that no longer exists in the table because the deal
    // changed source_key/stage. writeDealDocs only ever deletes+reinserts docs
    // for *current* deal_ids, so a doc under a vanished deal_id is never touched
    // and lingers forever. Directly delete any deal_documents whose deal_id is
    // not a live deal. Guarded the same way as the deals prune: never run when
    // the deals table is empty, so a bad/empty deploy can't wipe every doc.
    let docsOrphanPruned = 0;
    try {
      const { data: liveDeals, error: ldErr } = await supa.from('deals').select('id');
      if (ldErr) throw new Error(ldErr.message);
      const liveIds = new Set((liveDeals || []).map((r) => r.id).filter(Boolean));
      if (liveIds.size > 0) {
        const { data: docRows, error: ddErr } = await supa.from('deal_documents').select('deal_id');
        if (ddErr) throw new Error(ddErr.message);
        const orphanDocDeals = [...new Set((docRows || [])
          .map((r) => r.deal_id)
          .filter((id) => id && !liveIds.has(id)))];
        if (orphanDocDeals.length) {
          const { error: delErr } = await supa.from('deal_documents').delete().in('deal_id', orphanDocDeals);
          if (delErr) throw new Error(delErr.message);
          docsOrphanPruned = orphanDocDeals.length;
          // Same orphan deal_ids can leave stale governance rows behind; clear
          // them too so a re-created deal never inherits an old doc's visibility.
          await supa.from('deal_document_governance').delete().in('deal_id', orphanDocDeals)
            .then(() => {}, () => {});
        }
      }
    } catch (e) {
      errors.push({ deal: 'prune-orphan-docs', error: e.message || String(e) });
    }

    // Per-agent tasks from the briefing (deals.json "tasks") → agent_tasks.
    // The briefing is the source of truth for content, but check-offs made in
    // the CRM are preserved across syncs (matched by agent|client|title).
    let tasksWritten = 0;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const normAgent = (a) => { a = String(a || '').toLowerCase(); return /james/.test(a) ? 'james' : (/both/.test(a) ? 'both' : 'sara'); };
    const sig = (agent, client, title) => `${agent}|${client || ''}|${title}`;
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

    // Preserve, across the re-sync, the done checkmark AND the agents'
    // note-back-to-briefing + attention flag (matched by agent|client|title),
    // so a re-sync never wipes an agent's feedback.
    // Scope to the rows THIS sync owns: source='briefing' AND source_key IS NULL.
    // Keyed briefing rows (bulkSync 'brief:*') and auto rows ('auto:*') are
    // managed by their own insert-only pipelines — the wholesale wipe below must
    // not touch them, or a checked-off keyed task reopens every hour.
    let hasFbCols = true, hasBriefKey = true, prior = [];
    {
      // Preferred: pull the feedback columns AND the stable brief_key (Fix 1).
      let r = await supa.from('agent_tasks')
        .select('agent, client, title, done, agent_note, attention, agent_note_by, agent_note_at, brief_key')
        .eq('source', 'briefing').is('source_key', null);
      if (r.error) {
        // brief_key column not migrated yet — retry with just the feedback cols.
        hasBriefKey = false;
        r = await supa.from('agent_tasks')
          .select('agent, client, title, done, agent_note, attention, agent_note_by, agent_note_at')
          .eq('source', 'briefing').is('source_key', null);
      }
      if (r.error) {
        // feedback columns absent too (older schema) — minimal select.
        hasFbCols = false;
        const r2 = await supa.from('agent_tasks').select('agent, client, title, done').eq('source', 'briefing').is('source_key', null);
        prior = r2.data || [];
      } else prior = r.data || [];
    }
    // Match a rebuilt task to its prior row by the stable brief_key first (survives
    // title countdowns), then fall back to the agent|client|title signature so
    // un-keyed tasks behave exactly as before.
    const keepBySig = new Map(prior.map((t) => [sig(t.agent, t.client, t.title), t]));
    const keepByKey = new Map(prior.filter((t) => t && t.brief_key).map((t) => [t.brief_key, t]));
    // Safety-net for KEYLESS tasks whose title carries a live countdown/date:
    // strip a trailing "— N days" / "(N days)" and a leading status emoji so a
    // check-off survives "4 days → 3 days" wording changes even without a `key`.
    // Conservative (keeps the dated core of the title), so it can't bleed a tick
    // between two genuinely different tasks. The real fix is a stable `key`.
    // Remove only the "N days" countdown token and normalize punctuation/emoji,
    // keeping every other word (dates, names, the action) — so it collapses
    // "4 days → 3 days" but never merges two tasks that differ in any real word.
    const stripCd = (s) => String(s || '')
      .replace(/\b\d+\s*days?\b/gi, ' ')       // the volatile countdown token
      .replace(/[^\p{L}\p{N}]+/gu, ' ')        // emoji/symbols/punctuation → space
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const keepByCd = new Map(prior.map((t) => [sig(t.agent, t.client, stripCd(t.title)), t]));

    // Rebuild ONLY the still-OPEN briefing tasks. A task an agent CHECKED OFF must
    // survive the hourly rebuild: deleting done rows and re-matching them by
    // title/key is exactly why cleared tasks reappeared when Cowork reworded or
    // re-keyed them (James's "30+ back after the 10am run"). Done rows now persist,
    // and the rebuild below skips any task that matches a surviving done row — so
    // there's no open duplicate and, crucially, no re-open of a completed task.
    await supa.from('agent_tasks').delete().eq('source', 'briefing').is('source_key', null).eq('done', false);
    if (tasks.length) {
      const rows = tasks.map((t) => {
        const agent  = normAgent(t.agent);
        const title  = String(t.title || t.task || '').slice(0, 300);
        const client = t.client ? String(t.client).slice(0, 80) : null;
        const s = sig(agent, client, title);
        const taskKey = t.key ? String(t.key).slice(0, 120) : null;
        // brief_key match first (stable across title countdowns), then signature.
        const kept = (hasBriefKey && taskKey && keepByKey.get(taskKey)) || keepBySig.get(s)
          || keepByCd.get(sig(agent, client, stripCd(title)));
        // If this task matches one the agent already completed, that done row is
        // still in the table (we no longer delete done rows) — don't re-emit it,
        // or we'd create an open duplicate of a task that's already checked off.
        if (kept && kept.done) return null;
        const row = {
          agent,
          client,
          title,
          sub:        t.sub ? String(t.sub).slice(0, 300) : null,
          note:       t.note ? String(t.note).slice(0, 600) : null,
          due_label:  t.due || t.due_label || null,
          source_key: t.deal || t.source_key || null,
          source:     'briefing',
          done:       kept ? !!kept.done : (t.done === true)
        };
        // Stable per-task identity. Prefer Cowork's explicit `key`; otherwise
        // DERIVE one from agent + client + countdown-stripped title so every
        // briefing task carries a stable, dedup-able key even when Cowork didn't
        // set one. (Before this, brief_key was null unless Cowork provided `key`,
        // and source_key is null for deal-less briefing tasks — so the briefing
        // had NO stable key to dedup on and fell back to brittle title matching.)
        // Exposed to Cowork via /api/crm/briefing-feedback as `key`. brief_key has
        // no unique constraint, so a derived collision only means two genuinely
        // identical tasks share a check-off — the intended behaviour.
        if (hasBriefKey) {
          row.brief_key = taskKey
            || ('d:' + agent + ':' + slug(client) + ':' + slug(stripCd(title))).slice(0, 120);
        }
        if (hasFbCols && kept) {
          row.agent_note    = kept.agent_note ?? null;
          row.attention     = !!kept.attention;
          row.agent_note_by = kept.agent_note_by ?? null;
          row.agent_note_at = kept.agent_note_at ?? null;
        }
        return row;
      }).filter((r) => r && r.title);
      if (rows.length) {
        // A stable source_key that already exists is an INTENDED repeat
        // (idempotency — see TASKFLOWCONTRACT.md), not an error. The old code
        // re-inserted keyed rows with no ON CONFLICT clause, so the first
        // collision aborted the whole request → HTTP 500, killing everything
        // after this point (checklist derivation, lead promotion, the response).
        // Pre-filter out keys already present (and in-batch dupes) so a repeat is
        // a no-op. Pre-filtering rather than .upsert({onConflict:'source_key'})
        // because the unique index is PARTIAL (WHERE source_key IS NOT NULL),
        // which ON CONFLICT (source_key) can't use as an arbiter. Composes with
        // the agent_tasks_skip_duplicate trigger; also stands alone without it.
        let existingKeys = new Set();
        {
          const { data: ek } = await supa.from('agent_tasks').select('source_key').not('source_key', 'is', null);
          existingKeys = new Set((ek || []).map((r) => r.source_key));
        }
        const seenKeys = new Set();
        const toInsert = [];
        for (const r of rows) {
          if (r.source_key != null) {
            if (existingKeys.has(r.source_key) || seenKeys.has(r.source_key)) { taskStats.skipped_duplicates++; continue; }
            seenKeys.add(r.source_key);
          }
          toInsert.push(r);
        }
        if (toInsert.length) {
          const { error: te } = await supa.from('agent_tasks').insert(toInsert);
          if (te) {
            // A single duplicate — e.g. a brief_key already present, which the
            // source_key pre-filter above can't catch — makes the whole batch
            // insert abort under agent_tasks_source_briefkey_uniq, so NOTHING is
            // written and the run reports created:0 with the constraint in
            // deal_errors (the seven-day bug). Fall back to row-by-row so every
            // non-colliding task still lands; a per-row duplicate is a no-op, not
            // a batch-killer. deal_errors only records agent_tasks if NOTHING wrote.
            let inserted = 0;
            for (const r of toInsert) {
              const { error: re } = await supa.from('agent_tasks').insert(r);
              if (!re) inserted++;
              else taskStats.skipped_duplicates++;
            }
            tasksWritten = inserted; taskStats.created = inserted;
            if (!inserted) errors.push({ deal: 'agent_tasks', error: te.message });
          } else {
            tasksWritten = toInsert.length; taskStats.created = toInsert.length;
          }
        }
      }
    }

    // Rule-derived workflow checklist (source='checklist'), reconciled
    // independently of the briefing tasks. Insert-only by stable source_key so
    // check-offs survive; prune only rows whose deal/task no longer applies.
    let checklistWritten = 0, checklistPruned = 0, checklistKept = 0;
    try {
      const checklistDefs = require('../../data/checklist_task_definitions.json');
      const desired = buildChecklistRows(active, checklistDefs);
      const desiredKeys = new Set(desired.map((r) => r.source_key));
      // Pull agent input too: buildChecklistRows only emits rows for stage='pending',
      // so the moment a deal closes ALL its checklist keys leave the desired set. We
      // must never hard-delete a row an agent responded to — that would erase James's
      // notes on a deal the day it closes.
      const { data: existingCl } = await supa.from('agent_tasks')
        .select('id, source_key, agent_note, attention, done').eq('source', 'checklist');
      const haveKeys = new Set((existingCl || []).map((r) => r.source_key));
      const toInsert = desired.filter((r) => !haveKeys.has(r.source_key));
      if (toInsert.length) {
        const { error: ce } = await supa.from('agent_tasks').insert(toInsert);
        if (ce) throw new Error(`checklist insert: ${ce.message}`);
        checklistWritten = toInsert.length;
      }
      const stale = (existingCl || []).filter((r) => !desiredKeys.has(r.source_key));
      // Preserve any stale row an agent touched (note or attention). The deal left
      // 'pending', so the item is effectively resolved — mark it done to drop it from
      // open lists while keeping the row + its note readable in the briefing.
      const keepIds = stale.filter((r) => (r.agent_note || r.attention) && !r.done).map((r) => r.id);
      if (keepIds.length) {
        await supa.from('agent_tasks').update({ done: true }).in('id', keepIds);
        checklistKept = keepIds.length;
      }
      // Only rows with NO agent input are safe to hard-delete.
      const staleIds = stale.filter((r) => !r.agent_note && !r.attention).map((r) => r.id);
      if (staleIds.length) {
        await supa.from('agent_tasks').delete().in('id', staleIds);
        checklistPruned = staleIds.length;
      }
    } catch (e) {
      errors.push({ deal: 'checklist', error: e.message || String(e) });
    }

    // Promote any lead attached to an in-escrow / closed deal to a CLIENT with
    // the matching side stage, so a contact who's under contract never lingers
    // in the roster as a "lead". Self-healing: runs every sync, only touches
    // rows that need it, and never downgrades an existing client/past/sphere/DNC.
    // Auto-link deal clients to their deals by name (creating the contact when
    // none exists) BEFORE promoting, so a freshly-linked party gets
    // client-promoted in this same run.
    let partiesLinked = 0, contactsCreated = 0, spousesRelated = 0;
    try { const alr = await autoLinkPartiesByName(supa, active); partiesLinked = alr.linked; contactsCreated = alr.created; spousesRelated = alr.spouses_related; }
    catch (e) { errors.push({ deal: 'auto-link-parties', error: e.message || String(e) }); }

    let leadsPromoted = 0;
    try { leadsPromoted = await promoteAttachedLeads(supa); }
    catch (e) { errors.push({ deal: 'lead-promotion', error: e.message || String(e) }); }

    // Post-sync breakdown of the deals table (side/stage) so a single trigger
    // is self-diagnosing: you can see exactly what the CRM Listings view reads.
    let dealsInTable = null;
    try {
      const { data: after } = await supa.from('deals').select('side, stage');
      const bd = {};
      for (const r of (after || [])) { const k = `${r.side || '?'}/${r.stage || '?'}`; bd[k] = (bd[k] || 0) + 1; }
      dealsInTable = { total: (after || []).length, by_side_stage: bd };
    } catch (_) { /* diagnostic only */ }

    // Cowork loop auto-reconcile (db/030): once deals.json reflects an agent's
    // party overlay (Cowork folded it in), clear the pending flag so it drops
    // off the brief nudge — closing the loop with no extra Cowork call.
    // Conservative: mark reconciled only when EVERY value in the overlay appears
    // in that deal's deals.json text (loose, punctuation-insensitive match, so
    // "209-768-8277" matches "2097688277"). Values Cowork never carries (e.g. a
    // TC the SSOT doesn't track) keep it pending — the agent can mark it done
    // via {reconcile:true}. Fail-soft; pre-030 degrades to a no-op.
    let partyReconciled = 0;
    try {
      const { data: overlays } = await supa.from('deals')
        .select('id, source_key, party_details')
        .not('party_details', 'is', null)
        .is('party_reconciled_at', null);
      const jsonById = new Map((data.deals || []).map((d) => [d.id, d]));
      const strip = (s) => String(s).toLowerCase().replace(/[^a-z0-9@]/g, '');
      for (const row of (overlays || [])) {
        const ov = row.party_details;
        if (!ov || !Object.keys(ov).length) continue;
        const src = jsonById.get(row.source_key);
        if (!src) continue;                          // deal left the feed — leave as-is
        const hay = strip(JSON.stringify(src));
        const vals = [];
        for (const sec of Object.values(ov)) {
          if (sec && typeof sec === 'object') { for (const [k, v] of Object.entries(sec)) if (k !== 'lead_id' && v) vals.push(v); }
          else if (typeof sec === 'string' && sec) vals.push(sec);   // coe
        }
        if (vals.length && vals.every((v) => hay.includes(strip(v)))) {
          await supa.from('deals').update({ party_reconciled_at: new Date().toISOString() }).eq('id', row.id).then(() => {}, () => {});
          partyReconciled++;
        }
      }
    } catch (_) { /* pre-030 or transient — non-fatal */ }

    // Cowork reconcile: party/escrow overlays STILL pending (not yet folded into
    // deals.json). Surface them so Cowork can fold each into deals.json on its
    // own schedule. Empty until db/029 runs; diagnostic-only, never fatal.
    let partyEdits = [];
    try {
      let peq = supa.from('deals').select('source_key, address, party_details').not('party_details', 'is', null);
      // Prefer only-pending (db/030); if that column is absent, list all overlays.
      const pend = await peq.is('party_reconciled_at', null);
      const pe = pend.error ? (await supa.from('deals').select('source_key, address, party_details').not('party_details', 'is', null)).data : pend.data;
      partyEdits = (pe || [])
        .filter((r) => r.party_details && Object.keys(r.party_details).length)
        .map((r) => ({ source_key: r.source_key, address: r.address, party_details: r.party_details }));
    } catch (_) { /* column not migrated yet — nothing to reconcile */ }

    return ok(res, {
      synced: true,
      source_version: data.version || null,
      deals_source: dealsSource,   // 'github' = read fresh (no deploy wait) · 'bundle' = fell back to the deployed copy
      deals_upserted: dealsUpserted,
      deals_pruned: dealsPruned,
      docs_orphan_pruned: docsOrphanPruned,
      timeline_items_retired: timelineItemsRetired,
      documents_written: docStats.inserted,
      governance_seeded: govSeeded,
      deal_escrows: escrowStats,
      // Per-row outcomes for the two loops that used to 500 the whole endpoint.
      deal_documents: docStats,
      agent_tasks: taskStats,
      tasks_written: tasksWritten,
      checklist_written: checklistWritten,
      checklist_pruned: checklistPruned,
      checklist_kept: checklistKept,
      leads_promoted: leadsPromoted,
      parties_linked: partiesLinked,
      contacts_created: contactsCreated,
      spouses_related: spousesRelated,
      deal_errors: errors,
      deals_in_table: dealsInTable,
      // Agent party/escrow edits still awaiting reconciliation into deals.json,
      // and how many the sync auto-reconciled this run (deals.json now covers them).
      party_edits: partyEdits,
      party_reconciled: partyReconciled,
      ran_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
