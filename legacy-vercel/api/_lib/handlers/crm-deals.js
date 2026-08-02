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
    const BASE = 'source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, photo_url, video_url, matterport_url, escrow_officer, title_company, co_agent, milestones';
    const COLS_FULL = BASE + ', mls_number, listing_meta, stage_override, photo_override, party_details';
    const COLS_MLS  = BASE + ', mls_number, stage_override, photo_override';
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

    for (const d of (r.data || [])) {
      if (wantAgent && d.agent !== wantAgent && d.agent !== 'both') continue;

      // Effective stage — same rule as crm-listings.js: the agent's override
      // applies while deals.json still has the deal at 'offer' or 'preparing'
      // (accept → escrow, offer fell through, listing won't-list), else `stage`.
      const canOverride = d.stage === 'offer' || d.stage === 'preparing';
      const stage = (canOverride && d.stage_override) ? d.stage_override : d.stage;
      const photo = d.photo_override || d.photo_url || youtubeThumb(d.video_url);
      const parties = resolveParties(d);
      const coeDays = d.coe_date ? Math.round((new Date(d.coe_date + 'T12:00:00Z') - todayMid) / 86400000) : null;

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
        address:    d.address,
        city:       d.city,
        side:       d.side,
        agent:      d.agent,
        price:      d.sale_price || d.list_price || null,
        list_price: d.list_price,
        sale_price: d.sale_price,
        coe_date:   d.coe_date,
        coe_days:   coeDays,
        mls:        d.mls_number || null,
        meta:       d.listing_meta || null,
        photo_url:  photo,
        video_url:  d.video_url || null,
        tour_url:   d.matterport_url || null,
        has_video:  !!d.video_url,
        has_tour:   !!d.matterport_url,
        stage:      stage,
        base_stage: d.stage,
        contingencies,
        parties,
        party_summary: partySummary(parties)
      };

      if (stage === 'dead')           buckets.archived.push(row);
      else if (stage === 'offer')     buckets.offers.push(row);
      else if (stage === 'listing')   buckets.active.push(row);
      else if (stage === 'pending')   buckets.pending.push(row);
      else if (stage === 'closed')    buckets.closed.push(row);
      else if (stage === 'preparing') buckets.preparing.push(row);
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
