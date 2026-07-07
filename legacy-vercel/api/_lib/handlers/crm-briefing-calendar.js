// api/_lib/handlers/crm-briefing-calendar.js
// GET /api/crm/briefing-calendar?key=<SYNC_SECRET>&days=7
//
// A READ-ONLY calendar feed for the morning-briefing assistant (Cowork). Returns
// every CRM calendar entry from today through today+days, merged across all the
// event sources we hold:
//   * tours / showings          → public.tours
//   * listing appointments,
//     inspections, manual entries → public.appointments
//   * escrow deadlines + COE     → synthesized from public.deals
//                                  (coe_date, and loan-contingency = escrow open
//                                   + loan_contingency_days)
//
// Key-protected exactly like /api/crm/briefing-feedback (reuses SYNC_SECRET) so
// Cowork can pull it headlessly. No writes, no agent session required.
//
// All day/time math is Pacific (America/Los_Angeles), matching the CRM calendar.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { timelineEvents } from '../deal-timeline.js';

const TZ = 'America/Los_Angeles';
const pad2 = (n) => String(n).padStart(2, '0');

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
// A Pacific wall-clock (Y-M-D H:M) → the matching UTC Date.
function laToUTC(y, m, d, hh, mm) {
  const asUTC = Date.UTC(y, m - 1, d, hh, mm);
  const p = laParts(new Date(asUTC));
  const wallAsUTC = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return new Date(asUTC - (wallAsUTC - asUTC));
}
function ymdShift(y, m, d, delta) {
  const b = new Date(Date.UTC(y, m - 1, d, 12));
  b.setUTCDate(b.getUTCDate() + delta);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
}
const ymd = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
const clean = (s) => (s == null ? null : String(s).replace(/[<>]/g, '').trim() || null);
const fullName = (lead) => {
  const n = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').trim();
  return n || null;
};
const normAgent = (a) => {
  const s = String(a || '').toLowerCase();
  if (/james/.test(s)) return 'james';
  if (/both/.test(s)) return 'both';
  return 'sara';
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');

  try {
    const supa = adminClient();

    let days = parseInt(req.query?.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 30) days = 30;

    // Pacific window: [today 00:00, (today+days) 23:59:59].
    const t = laParts(new Date());
    const startUTC = laToUTC(t.y, t.m, t.d, 0, 0);
    const endDay = ymdShift(t.y, t.m, t.d, days);                 // last day INCLUDED
    const endExclusiveUTC = laToUTC(endDay.y, endDay.m, endDay.d, 0, 0);
    endExclusiveUTC.setUTCDate(endExclusiveUTC.getUTCDate() + 1); // through end of that day
    const startISO = startUTC.toISOString();
    const endISO = endExclusiveUTC.toISOString();
    const todayStr = ymd(t);
    const endStr = ymd(endDay);
    const inDateRange = (s) => s >= todayStr && s <= endStr;

    const events = [];
    const push = (ev, sortTs) => { ev._ts = sortTs; events.push(ev); };

    // 1. Tours → showings ----------------------------------------------------
    const toursRes = await supa.from('tours')
      .select('id, scheduled_at, duration_minutes, tour_type, status, notes, agent, leads(first_name,last_name,email), properties(address,city)')
      .gte('scheduled_at', startISO).lt('scheduled_at', endISO)
      .neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true });
    if (toursRes.error) return fail(res, 500, `tours: ${toursRes.error.message}`);
    for (const row of toursRes.data || []) {
      const start = new Date(row.scheduled_at);
      if (isNaN(start)) continue;
      const dur = Number(row.duration_minutes) || 30;
      const end = new Date(start.getTime() + dur * 60000);
      const prop = row.properties || {};
      const who = fullName(row.leads);
      push({
        title: prop.address ? String(prop.address).split(',')[0] : (row.tour_type === 'video' ? 'Video tour' : 'Tour') + (who ? ` — ${who}` : ''),
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: false,
        weekend: false,
        agent: normAgent(row.agent),
        client: who,
        deal: null,                                              // tours link to a property/lead, not a deal
        type: 'showing',
        location: clean(prop.address ? [prop.address, prop.city].filter(Boolean).join(', ') : null),
        notes: clean(row.notes)
      }, start.getTime());
    }

    // 2. Appointments → listing appointments / inspections / manual entries ---
    const apptRes = await supa.from('appointments')
      .select('id, title, kind, starts_at, duration_minutes, notes, agent, leads(first_name,last_name,email)')
      .gte('starts_at', startISO).lt('starts_at', endISO)
      .order('starts_at', { ascending: true });
    const apptMissing = apptRes.error && /relation .*appointments.* does not exist/i.test(apptRes.error.message || '');
    if (apptRes.error && !apptMissing) return fail(res, 500, `appointments: ${apptRes.error.message}`);
    for (const row of (apptRes.data || [])) {
      const start = new Date(row.starts_at);
      if (isNaN(start)) continue;
      const dur = Number(row.duration_minutes) || 30;
      const end = new Date(start.getTime() + dur * 60000);
      const title = clean(row.title) || 'Appointment';
      const kind = String(row.kind || '').toLowerCase();
      let type = 'appointment';
      if (/inspect/i.test(title)) type = 'inspection';
      else if (kind === 'block') type = 'other';
      push({
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: false,
        weekend: false,
        agent: normAgent(row.agent),
        client: fullName(row.leads),
        deal: null,
        type,
        location: null,
        notes: clean(row.notes)
      }, start.getTime());
    }

    // 3. Deals → RPA contingency deadlines + close of escrow -----------------
    // Timelines follow CA RPA convention: acceptance = Day 0, 17-day default
    // periods (per-deal overridable), COE rolls off weekends/holidays, removed
    // contingencies drop off, and a present-but-null clock_start pauses a deal.
    // All of that math lives in computeTimeline() (unit-tested). `source_key`
    // matches deals.json ids so the briefing can tie an event back to its deal.
    const DEAL_COLS = 'source_key, agent, address, stage, coe_date, escrow_open_date, loan_contingency_days, timeline, listing_meta';
    let dealsRes = await supa.from('deals').select(DEAL_COLS);
    if (dealsRes.error) dealsRes = await supa.from('deals').select('source_key, agent, address, stage, coe_date, escrow_open_date, loan_contingency_days, listing_meta');
    if (dealsRes.error) dealsRes = await supa.from('deals').select('source_key, agent, address, stage, coe_date, escrow_open_date, loan_contingency_days');
    if (dealsRes.error) dealsRes = await supa.from('deals').select('source_key, agent, address, stage, coe_date, escrow_open_date');
    if (dealsRes.error) return fail(res, 500, `deals: ${dealsRes.error.message}`);
    const tsOf = (ds) => laToUTC(+ds.slice(0, 4), +ds.slice(5, 7), +ds.slice(8, 10), 0, 0).getTime();

    for (const d of (dealsRes.data || [])) {
      for (const ev of timelineEvents(d, { todayStr, endStr })) push(ev, tsOf(ev.start));
    }

    // Sort by start ascending, then strip the internal sort key.
    events.sort((a, b) => a._ts - b._ts);
    for (const e of events) delete e._ts;

    return ok(res, {
      success: true,
      generated_at: new Date().toISOString(),
      range: { from: todayStr, to: endStr, days },
      count: events.length,
      events
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
