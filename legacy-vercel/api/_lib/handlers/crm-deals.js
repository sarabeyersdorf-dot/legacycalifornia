// api/_lib/handlers/crm-deals.js
// GET /api/crm/deals   (agent-only)
//
// PHASE 4 — the deal-data unifier. Today the CRM's deals are scattered across
// three surfaces that each re-query and re-shape the deals table their own way:
//   • Deals & Offers   (crm-listings.js) — offers / active / pending / preparing
//                        / closed / archived buckets
//   • Deals in motion  (crm-deals-motion.js) — the escrow ledger
//   • Listings roster  — sell-side listings
// This endpoint returns ONE canonical, effective-staged list of every deal plus
// a group index and counts, so a single "Deals" screen can render all of it as
// tabs without three round-trips. It's the data layer the unified UI sits on.
//
// It deliberately mirrors crm-listings.js's effective-stage + row shape (incl.
// base_stage and the People & escrow overlay) so the new screen agrees with the
// existing one during the transition. Photo enrichment is the light path
// (upload → deals.json photo → YouTube-tour thumbnail); the heavy MetroList
// fetch stays in crm-listings.js for now.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';
import { extractYouTubeId } from '../youtube.js';
import { resolveParties, partySummary } from '../deal-parties.js';

function youtubeThumb(videoUrl) {
  const id = extractYouTubeId(videoUrl);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}
function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Pacific wall-clock parts (matches crm-deals-motion.js) so a booked event reads
// the way the agent scheduled it regardless of the server's clock.
const TZ = 'America/Los_Angeles';
function laParts(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = {}; for (const part of f.formatToParts(date)) p[part.type] = part.value;
  if (p.hour === '24') p.hour = '00';
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute };
}
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
function timeLabel(hour, minute) { const h12 = ((hour + 11) % 12) + 1; return `${h12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`; }
// deal_timeline_items.status → contingency chip state (matches deals-motion).
function contStateFrom(status) {
  if (status === 'done' || status === 'waived' || status === 'na') return 'cleared';
  if (status === 'action') return 'atrisk';
  return 'ontrack';
}

// A per-deal health rollup combining the two escrow risk signals: at-risk /
// overdue contingencies and open compliance-file gaps. One of on_track (green),
// watch (amber), at_risk (red), with the human reasons behind it.
function dealHealth(docsMissing, contingencies, todayStr) {
  const conts = Array.isArray(contingencies) ? contingencies : [];
  const atrisk  = conts.filter((c) => c && c.state === 'atrisk').length;
  const overdue = conts.filter((c) => c && c.state !== 'cleared' && c.iso && String(c.iso) < todayStr).length;
  const reasons = [];
  if (atrisk)  reasons.push(`${atrisk} at-risk contingenc${atrisk === 1 ? 'y' : 'ies'}`);
  if (overdue) reasons.push(`${overdue} overdue contingenc${overdue === 1 ? 'y' : 'ies'}`);
  if (docsMissing) reasons.push(`${docsMissing} doc${docsMissing === 1 ? '' : 's'} missing`);
  let level = 'on_track';
  if (atrisk || overdue) level = 'at_risk';
  else if (docsMissing)  level = 'watch';
  const label = level === 'at_risk' ? 'At risk' : (level === 'watch' ? 'Watch' : 'On track');
  return { level, label, reasons };
}

// Buyer-side purchases we represent are live transactions too — include them,
// tagged by `side`. We exclude only non-transaction rows (prospects/leads).
const SIDES = ['listing', 'seller', 'both', 'buyer'];
const GROUPS = ['offers', 'active', 'pending', 'preparing', 'closed', 'archived'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  try {
    const supa = adminClient();
    const BASE = 'id, source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, photo_url, video_url, matterport_url, escrow_officer, title_company, co_agent, milestones';
    // stage_entered_at (db/065) rides on the richer tiers so a pre-migration DB
    // falls back to COLS_MIN cleanly (days-in-stage just reads null until run).
    const COLS_FULL = BASE + ', mls_number, listing_meta, stage_override, photo_override, party_details, stage_entered_at, agent_overrides';
    const COLS_MLS  = BASE + ', mls_number, stage_override, photo_override, stage_entered_at';
    const COLS_MIN  = BASE;
    const q = (cols) => supa.from('deals').select(cols).in('side', SIDES).order('coe_date', { ascending: true, nullsFirst: false });

    let r = await q(COLS_FULL); let tier = 'full';
    if (r.error) { r = await q(COLS_MLS); tier = 'mls'; }
    if (r.error) { r = await q(COLS_MIN); tier = 'min'; }
    if (r.error) return fail(res, 500, r.error.message);

    // Optional agent scoping: ?agent=james|sara (defaults to all).
    const wantAgent = ['james', 'sara'].includes(req.query?.agent) ? req.query.agent : null;

    const todayMid = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z');
    const buckets = { offers: [], active: [], pending: [], preparing: [], closed: [], archived: [] };
    const rowByDealId = new Map();   // deal uuid → escrow row, for calendar enrichment

    for (const d of (r.data || [])) {
      if (wantAgent && d.agent !== wantAgent && d.agent !== 'both') continue;

      // Effective stage — same rule as crm-listings.js: the agent's override
      // applies while deals.json still has the deal at 'offer' or 'preparing'
      // (accept → escrow, offer fell through, listing won't-list), else `stage`.
      const canOverride = d.stage === 'offer' || d.stage === 'preparing';
      const stage = (canOverride && d.stage_override) ? d.stage_override : d.stage;
      const photo = d.photo_override || d.photo_url || youtubeThumb(d.video_url);
      const parties = resolveParties(d);

      // Agent field overrides (db/066): a CRM-typed value wins over the synced
      // (Cowork) column; an absent key falls back to the synced value. Lets James
      // & Sara fix a blank/wrong price, close date, address, etc. that then sticks
      // across the hourly deals.json sync (which never writes agent_overrides).
      const ov = (d.agent_overrides && typeof d.agent_overrides === 'object' && !Array.isArray(d.agent_overrides)) ? d.agent_overrides : {};
      const pick = (k, synced) => (ov[k] != null && ov[k] !== '') ? ov[k] : synced;
      const listPrice = pick('list_price', d.list_price);
      const salePrice = pick('sale_price', d.sale_price);
      const address   = pick('address', d.address);
      const city      = pick('city', d.city);
      const coeDate   = pick('coe_date', d.coe_date);
      const mls       = pick('mls_number', d.mls_number);
      const sideEff   = pick('side', d.side);
      const agentEff  = pick('agent', d.agent);
      const videoUrl  = pick('video_url', d.video_url);
      const tourUrl   = pick('matterport_url', d.matterport_url);
      const showcaseUrl = pick('showcase_url', null);   // agent-set marketing page (no DB column)
      const reelUrl     = pick('reel_url', null);       // agent-set vertical reel (no DB column)
      const editedKeys = Object.keys(ov);

      const coeDays = coeDate ? Math.round((new Date(coeDate + 'T12:00:00Z') - todayMid) / 86400000) : null;

      // Light contingencies from the milestones jsonb (the deals-motion ledger's
      // fallback source) so the escrow tab has deadlines without a timeline join.
      let contingencies = null;
      if (stage === 'pending' && Array.isArray(d.milestones)) {
        contingencies = d.milestones
          .filter((m) => m && m.col === 'contingencies')
          .map((m) => ({ label: m.label || 'Contingency', iso: isoDate(m.date), state: m.status === 'done' ? 'cleared' : (m.status === 'key' ? 'atrisk' : 'ontrack') }));
        if (!contingencies.length) contingencies = null;
      }

      const row = {
        source_key: d.source_key,
        address:    address,
        city:       city,
        side:       sideEff,
        agent:      agentEff,
        price:      salePrice || listPrice || null,
        list_price: listPrice,
        sale_price: salePrice,
        coe_date:   coeDate,
        coe_days:   coeDays,
        mls:        mls || null,
        edited:     editedKeys.length ? editedKeys : null,
        meta:       d.listing_meta || null,
        photo_url:  photo,
        video_url:  videoUrl || null,
        tour_url:   tourUrl || null,
        showcase_url: showcaseUrl || null,
        reel_url:   reelUrl || null,
        has_video:  !!videoUrl,
        has_tour:   !!tourUrl,
        stage:      stage,
        base_stage: d.stage,
        stage_days: d.stage_entered_at ? Math.max(0, Math.floor((Date.now() - new Date(d.stage_entered_at).getTime()) / 86400000)) : null,
        contingencies,
        events:       null,   // filled below for escrow rows
        next_event:   null,
        docs_missing: 0,      // open compliance-file gaps (escrow rows)
        health:       null,   // {level,label,reasons} for escrow rows
        parties,
        party_summary: partySummary(parties)
      };

      if (stage === 'dead')           buckets.archived.push(row);
      else if (stage === 'offer')     buckets.offers.push(row);
      else if (stage === 'listing')   buckets.active.push(row);
      else if (stage === 'pending')   { buckets.pending.push(row); rowByDealId.set(d.id, row); }
      else if (stage === 'closed')    buckets.closed.push(row);
      else if (stage === 'preparing') buckets.preparing.push(row);
    }

    // Calendar events → escrow rows. Tours/appointments carry only a lead_id;
    // resolve lead_id → deal_parties → deal (the same wiring as the deals-motion
    // ledger) so an inspection/appraisal/walk-through booked on the calendar
    // shows on its deal. Scoped to the in-escrow (pending) rows to keep it light.
    // Fully fail-soft: a missing calendar table degrades to no events.
    try {
      const pendingIds = [...rowByDealId.keys()];
      if (pendingIds.length) {
        const nowMs = Date.now();
        const startISO = new Date(nowMs - 14 * 86400000).toISOString();   // small look-back
        const endISO   = new Date(nowMs + 120 * 86400000).toISOString();  // ~4 months forward
        const [partiesRes, toursRes, apptRes0, itemsRes, docsRes] = await Promise.all([
          supa.from('deal_parties').select('deal_id, lead_id').in('deal_id', pendingIds).then((x) => x, () => ({ data: [] })),
          supa.from('tours').select('lead_id, scheduled_at, tour_type, status, leads(first_name,last_name), properties(address)')
            .gte('scheduled_at', startISO).lt('scheduled_at', endISO).neq('status', 'cancelled').then((x) => x, () => ({ data: [] })),
          supa.from('appointments').select('lead_id, title, kind, sub_kind, starts_at, leads(first_name,last_name)')
            .gte('starts_at', startISO).lt('starts_at', endISO).then((x) => x, () => ({ data: [] })),
          // Richer contingencies (preferred over the milestones fallback) + the
          // deal's open compliance-file gaps, same sources as the deals-motion ledger.
          supa.from('deal_timeline_items').select('deal_id, title, due_date, status, kind').in('deal_id', pendingIds).eq('kind', 'contingency').then((x) => x, () => ({ data: [] })),
          // A not-on-file doc is stored as status='pending' (valid enum) with the
          // 'missing' marker in status_raw — the enum has no 'missing' value.
          supa.from('deal_documents').select('deal_id').eq('status_raw', 'missing').in('deal_id', pendingIds).then((x) => x, () => ({ data: [] }))
        ]);
        // sub_kind may be pre-migration — retry appointments without it.
        let appts = apptRes0?.data;
        if (apptRes0?.error && /sub_kind/i.test(apptRes0.error.message || '')) {
          const { data } = await supa.from('appointments').select('lead_id, title, kind, starts_at, leads(first_name,last_name)').gte('starts_at', startISO).lt('starts_at', endISO);
          appts = data || [];
        }
        appts = appts || [];
        const leadToDeal = new Map();
        for (const p of (partiesRes?.data || [])) if (p.lead_id && !leadToDeal.has(p.lead_id)) leadToDeal.set(p.lead_id, p.deal_id);

        const evByDeal = new Map();
        const pushEv = (id, ev) => { if (!evByDeal.has(id)) evByDeal.set(id, []); evByDeal.get(id).push(ev); };
        for (const t of (toursRes?.data || [])) {
          const id = t.lead_id ? leadToDeal.get(t.lead_id) : null; if (!id) continue;
          const start = new Date(t.scheduled_at), p = laParts(start), prop = t.properties || {}, lead = t.leads || {};
          pushEv(id, { label: t.tour_type === 'video' ? 'Video tour' : 'Tour',
            vendor: prop.address ? String(prop.address).split(',')[0] : ([lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client'),
            iso: ymd(p), time: timeLabel(p.hour, p.minute), state: t.status === 'completed' ? 'complete' : (t.status === 'requested' ? 'scheduled' : 'confirmed'), kind: 'tour', ts: start.getTime() });
        }
        for (const a of appts) {
          const id = a.lead_id ? leadToDeal.get(a.lead_id) : null; if (!id) continue;
          const start = new Date(a.starts_at), p = laParts(start);
          const label = a.kind === 'inspection' ? (a.sub_kind ? `${a.sub_kind} inspection` : 'Inspection')
            : (a.title || (a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1).replace(/_/g, ' ') : 'Event'));
          pushEv(id, { label, vendor: null, iso: ymd(p), time: timeLabel(p.hour, p.minute), state: 'confirmed', kind: a.kind || 'event', ts: start.getTime() });
        }
        for (const [id, evs] of evByDeal) {
          const row = rowByDealId.get(id); if (!row) continue;
          evs.sort((a, b) => a.ts - b.ts);
          row.events = evs.map((e) => ({ label: e.label, vendor: e.vendor, iso: e.iso, time: e.time, state: e.state, kind: e.kind }));
          const next = evs.find((e) => e.ts >= Date.now() - 2 * 3600000);
          row.next_event = next ? { label: next.label, iso: next.iso, time: next.time } : null;
        }

        // Contingencies from the curated timeline (preferred over the milestones
        // fallback already on the row) + open compliance-file gaps per deal.
        const contByDeal = new Map();
        for (const it of (itemsRes?.data || [])) {
          if (!contByDeal.has(it.deal_id)) contByDeal.set(it.deal_id, []);
          contByDeal.get(it.deal_id).push({ label: it.title || 'Contingency', iso: isoDate(it.due_date), state: contStateFrom(it.status) });
        }
        for (const [id, conts] of contByDeal) { const row = rowByDealId.get(id); if (row && conts.length) row.contingencies = conts; }

        const docsMissing = new Map();
        for (const doc of (docsRes?.data || [])) docsMissing.set(doc.deal_id, (docsMissing.get(doc.deal_id) || 0) + 1);
        for (const [id, row] of rowByDealId) row.docs_missing = docsMissing.get(id) || 0;
      }
    } catch (_) { /* calendar enrichment is a bonus — never break the deals list */ }

    // Per-deal health for the escrow rows — computed unconditionally (outside the
    // enrichment try) so it still rolls up from whatever signals landed, even if
    // a calendar/docs query failed. Uses the row's final contingencies + docs.
    {
      const todayStr = new Date().toISOString().slice(0, 10);
      for (const row of buckets.pending) row.health = dealHealth(row.docs_missing || 0, row.contingencies, todayStr);
    }

    // Flat list + a group index of source_keys, so the UI can tab without
    // re-filtering and still hold one array of deals.
    const deals = [];
    const groups = {};
    const counts = {};
    for (const g of GROUPS) {
      groups[g] = buckets[g].map((x) => x.source_key);
      counts[g] = buckets[g].length;
      for (const row of buckets[g]) deals.push(row);
    }

    return ok(res, { deals, groups, counts, agent: wantAgent, tier, generated_at: new Date().toISOString() });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
