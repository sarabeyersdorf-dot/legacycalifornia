// api/_lib/handlers/crm-deals-motion.js
// GET /api/crm/deals-motion   (agent-only)
//
// The data feed for the "Deals in motion" ledger on the CRM today view.
// One row per live transaction, enriched so an agent has at-a-glance command:
//   • client (from deal_parties → leads), price, side, agent, stage, COE
//   • contingencies[]  — contractual deadlines (inspection/appraisal/loan/…)
//        pulled from deal_timeline_items (kind='contingency'), falling back to
//        the deal's milestones jsonb when no timeline rows exist yet.
//   • events[]         — EVERY calendar event tied to this deal. Calendar rows
//        (tours + appointments) carry only a lead_id; we resolve
//        lead_id → deal_parties → deal exactly the way /api/crm/calendar does,
//        so an inspection, appraisal, walk-through or showing booked on the
//        calendar surfaces on its own deal automatically. This is the
//        "populate from the calendar to its respective deal" wiring.
//
// Everything is fail-soft: an optional table/column that hasn't been migrated
// yet degrades to an empty array rather than 500-ing the whole ledger.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const TZ = 'America/Los_Angeles';

// Pacific wall-clock parts for a timestamp (date + hour/minute), so times read
// the way the agent booked them regardless of the server's clock.
function laParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  if (p.hour === '24') p.hour = '00';
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute };
}
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
function timeLabel(hour, minute) {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}
// Accept only a clean YYYY-MM-DD (milestone dates can be free text).
function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function fmtPrice(n) {
  const v = Number(n);
  if (!v || isNaN(v)) return '';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 2).replace(/\.0+$/, '') + 'M';
  if (v >= 1_000)     return '$' + Math.round(v / 1_000) + 'K';
  return '$' + Math.round(v);
}

// deals.side → the ledger's buy | sell | dual bucket.
const SIDE_MAP = { buyer: 'buy', seller: 'sell', both: 'dual', listing: 'sell' };
// deals.stage → the ledger's status pill.
function statusOf(stage, coeDays) {
  if (stage === 'pending') return (coeDays != null && coeDays <= 7) ? 'closing' : 'escrow';
  if (stage === 'offer')     return 'offerin';
  if (stage === 'preparing') return 'onmarket';
  if (stage === 'listing')   return 'onmarket';
  return 'onmarket';
}
// deal_timeline_items.status → contingency chip state.
function contStateFrom(status) {
  if (status === 'done' || status === 'waived' || status === 'na') return 'cleared';
  if (status === 'action') return 'atrisk';
  return 'ontrack';
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();

  try {
    // 1. The live transactions (everything but closed) ----------------------
    const { data: dealRows, error: dErr } = await supa.from('deals')
      .select('id, source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, milestones, updated_at')
      .in('stage', ['offer', 'pending', 'listing', 'preparing'])
      .order('coe_date', { ascending: true, nullsFirst: false });
    if (dErr) return fail(res, 500, `deals: ${dErr.message}`);

    const deals = (dealRows || []).filter((d) => d.source_key);
    if (!deals.length) return ok(res, { deals: [] });

    const dealIds = deals.map((d) => d.id);
    const byId = new Map(deals.map((d) => [d.id, d]));
    const keyById = new Map(deals.map((d) => [d.id, d.source_key]));

    const nowMs = Date.now();
    const startISO = new Date(nowMs - 14 * 86400000).toISOString();  // small look-back for "last touch"
    const endISO   = new Date(nowMs + 120 * 86400000).toISOString(); // ~4 months forward

    // 2. Parallel enrichment queries (each fail-soft) -----------------------
    const [partiesRes, itemsRes, toursRes, apptRes] = await Promise.all([
      supa.from('deal_parties').select('deal_id, lead_id, role').in('deal_id', dealIds),
      supa.from('deal_timeline_items')
        .select('deal_id, title, due_date, status, kind')
        .in('deal_id', dealIds).eq('kind', 'contingency')
        .then((r) => r, () => ({ data: [] })),
      supa.from('tours')
        .select('id, lead_id, scheduled_at, duration_minutes, tour_type, status, notes, leads(first_name,last_name), properties(address)')
        .gte('scheduled_at', startISO).lt('scheduled_at', endISO).neq('status', 'cancelled')
        .then((r) => r, () => ({ data: [] })),
      supa.from('appointments')
        .select('id, lead_id, title, kind, sub_kind, starts_at, duration_minutes, notes, leads(first_name,last_name)')
        .gte('starts_at', startISO).lt('starts_at', endISO)
        .then((r) => r, () => ({ data: [] }))
    ]);

    const parties = partiesRes?.data || [];
    // Guard: sub_kind column may not be migrated — retry appointments without it.
    let appts = apptRes?.data;
    if (apptRes?.error && /sub_kind/i.test(apptRes.error.message || '')) {
      const { data } = await supa.from('appointments')
        .select('id, lead_id, title, kind, starts_at, duration_minutes, notes, leads(first_name,last_name)')
        .gte('starts_at', startISO).lt('starts_at', endISO);
      appts = data || [];
    }
    appts = appts || [];
    const tours = toursRes?.data || [];

    // lead_id → deal_id (first party wins), and per-deal client name ---------
    const leadToDeal = new Map();
    const partiesByDeal = new Map();
    for (const p of parties) {
      if (p.lead_id && !leadToDeal.has(p.lead_id)) leadToDeal.set(p.lead_id, p.deal_id);
      if (!partiesByDeal.has(p.deal_id)) partiesByDeal.set(p.deal_id, []);
      partiesByDeal.get(p.deal_id).push(p);
    }
    const clientByDeal = new Map();
    const partyLeadIds = [...new Set(parties.map((p) => p.lead_id).filter(Boolean))];
    if (partyLeadIds.length) {
      const { data: leadRows } = await supa.from('leads').select('id, first_name, last_name').in('id', partyLeadIds);
      const nameById = new Map((leadRows || []).map((l) => [l.id, [l.first_name, l.last_name].filter(Boolean).join(' ')]));
      for (const [dealId, ps] of partiesByDeal) {
        const d = byId.get(dealId);
        const want = d ? SIDE_MAP[d.side] : null;
        // Prefer the party on the deal's own side; otherwise the first named one.
        const pref = ps.find((p) => (want === 'buy' && /buyer/.test(p.role || '')) || (want === 'sell' && /seller/.test(p.role || '')));
        const chosen = pref || ps[0];
        const nm = chosen && nameById.get(chosen.lead_id);
        if (nm) clientByDeal.set(dealId, nm);
      }
    }

    // Contingencies from timeline items, grouped by deal --------------------
    const contByDeal = new Map();
    for (const it of (itemsRes?.data || [])) {
      const iso = isoDate(it.due_date);
      if (!contByDeal.has(it.deal_id)) contByDeal.set(it.deal_id, []);
      contByDeal.get(it.deal_id).push({ label: it.title || 'Contingency', iso, state: contStateFrom(it.status) });
    }

    // Calendar events → deal (the requested wiring) -------------------------
    const evByDeal = new Map();
    const pushEv = (dealId, ev) => { if (!evByDeal.has(dealId)) evByDeal.set(dealId, []); evByDeal.get(dealId).push(ev); };

    for (const t of tours) {
      const dealId = t.lead_id ? leadToDeal.get(t.lead_id) : null;
      if (!dealId) continue;
      const start = new Date(t.scheduled_at); const p = laParts(start);
      const lead = t.leads || {}, prop = t.properties || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
      const st = t.status === 'completed' ? 'complete' : (t.status === 'requested' ? 'scheduled' : 'confirmed');
      pushEv(dealId, {
        label: t.tour_type === 'video' ? 'Video tour' : 'Tour',
        vendor: prop.address ? String(prop.address).split(',')[0] : who,
        iso: ymd(p), time: timeLabel(p.hour, p.minute), state: st,
        kind: 'tour', ts: start.getTime()
      });
    }
    for (const a of appts) {
      const dealId = a.lead_id ? leadToDeal.get(a.lead_id) : null;
      if (!dealId) continue;
      const start = new Date(a.starts_at); const p = laParts(start);
      const lead = a.leads || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
      let label;
      if (a.kind === 'inspection') label = a.sub_kind ? `${a.sub_kind} inspection` : 'Inspection';
      else label = a.title || (a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1).replace(/_/g, ' ') : 'Event');
      pushEv(dealId, {
        label,
        vendor: a.notes || who || '',
        iso: ymd(p), time: timeLabel(p.hour, p.minute),
        state: a.kind === 'inspection' ? 'confirmed' : 'confirmed',
        kind: a.kind || 'event', ts: start.getTime()
      });
    }

    // 3. Shape one ledger row per deal --------------------------------------
    const todayMid = new Date(); todayMid.setHours(12, 0, 0, 0);
    const out = deals.map((d) => {
      const coeDays = d.coe_date ? Math.round((new Date(d.coe_date + 'T12:00:00') - todayMid) / 86400000) : null;

      // contingencies: timeline items first, else milestones jsonb fallback.
      let contingencies = contByDeal.get(d.id) || [];
      if (!contingencies.length && Array.isArray(d.milestones)) {
        contingencies = d.milestones
          .filter((m) => m && m.col === 'contingencies')
          .map((m) => ({
            label: m.label || 'Contingency',
            iso: isoDate(m.date),
            state: m.status === 'done' ? 'cleared' : (m.status === 'key' ? 'atrisk' : 'ontrack')
          }));
      }

      const events = (evByDeal.get(d.id) || []).sort((a, b) => a.ts - b.ts);
      const future = events.filter((e) => e.ts >= nowMs - 2 * 3600000);
      const past = events.filter((e) => e.ts < nowMs);
      const nextEvent = future[0] || null;
      const lastTouch = past.length ? ymd(laParts(new Date(past[past.length - 1].ts)))
        : isoDate(d.updated_at) || null;

      // waiting-on heuristic
      let wait = 'you';
      if (nextEvent && nextEvent.kind === 'inspection') wait = 'inspector';
      else if (d.stage === 'pending') {
        const openCont = contingencies.find((c) => c.state !== 'cleared' && /loan|apprais|financ/i.test(c.label));
        wait = openCont ? 'lender' : 'escrowco';
      } else if (d.stage === 'offer') wait = 'coagent';

      return {
        id: d.source_key,
        source_key: d.source_key,
        address: d.address || d.source_key,
        city: d.city || '',
        price: fmtPrice(d.sale_price || d.list_price),
        side: SIDE_MAP[d.side] || 'sell',
        agent: d.agent === 'james' ? 'james' : (d.agent === 'both' ? 'both' : 'sara'),
        client: clientByDeal.get(d.id) || '—',
        status: statusOf(d.stage, coeDays),
        wait,
        lastTouch,
        coe: d.coe_date || null,
        contingencies: contingencies.length ? contingencies : null,
        events: events.length ? events.map((e) => ({ label: e.label, vendor: e.vendor, iso: e.iso, time: e.time, state: e.state, kind: e.kind })) : null,
        next_event: nextEvent ? { label: nextEvent.label, iso: nextEvent.iso } : null
      };
    });

    return ok(res, { deals: out, generated_at: new Date().toISOString() });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
