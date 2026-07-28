// api/_lib/handlers/crm-deadlines.js
// GET /api/crm/deadlines   (agent-only)
//
// The "Deadline Watch" — a single ranked, day-counted list of the next
// contingency and close-of-escrow deadlines across ALL active deals, so the
// agent sees what's due next everywhere in one glance (the morning briefing's
// Deadline Watch table, live in the CRM). Uses the same CA-RPA timeline math
// (deal-timeline.js) the calendar and the Cowork feed use, so nothing drifts.
//
// Window: today-14 (to catch just-slipped/overdue items) through today+45.
// Same-day contingencies on one deal collapse into a single row.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';
import { timelineEvents } from '../deal-timeline.js';

const TZ = 'America/Los_Angeles';
const pad2 = (n) => String(n).padStart(2, '0');
function laParts(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}
function ymdShift(y, m, d, delta) {
  const b = new Date(Date.UTC(y, m - 1, d, 12));
  b.setUTCDate(b.getUTCDate() + delta);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
}
const ymd = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
const dayDiff = (aStr, bStr) => {
  const a = Date.UTC(+aStr.slice(0, 4), +aStr.slice(5, 7) - 1, +aStr.slice(8, 10));
  const b = Date.UTC(+bStr.slice(0, 4), +bStr.slice(5, 7) - 1, +bStr.slice(8, 10));
  return Math.round((a - b) / 86400000);
};
const normAgent = (a) => { const s = String(a || '').toLowerCase(); return /james/.test(s) ? 'james' : (/both/.test(s) ? 'both' : 'sara'); };

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const supa = adminClient();
    const t = laParts(new Date());
    const todayStr = ymd(t);
    const startStr = ymd(ymdShift(t.y, t.m, t.d, -14));   // catch recent slippage
    const endStr   = ymd(ymdShift(t.y, t.m, t.d, 45));

    const COLS = 'source_key, agent, address, stage, coe_date, escrow_open_date, loan_contingency_days, timeline, listing_meta';
    let dq = await supa.from('deals').select(COLS).in('stage', ['pending', 'offer']);
    if (dq.error) dq = await supa.from('deals').select('source_key, agent, address, stage, coe_date, escrow_open_date, loan_contingency_days').in('stage', ['pending', 'offer']);
    if (dq.error) return fail(res, 500, `deals: ${dq.error.message}`);

    const rows = [];
    for (const d of (dq.data || [])) {
      let evs = [];
      try { evs = timelineEvents(d, { todayStr: startStr, endStr }); } catch (_) { evs = []; }
      const addrShort = d.address ? String(d.address).split(',')[0] : (d.source_key || '');
      const agent = normAgent(d.agent);
      const contByDate = {};
      for (const ev of evs) {
        if (ev.type === 'coe') {
          rows.push({
            type: 'coe', date: ev.start, days: dayDiff(ev.start, todayStr),
            label: 'Close of escrow', deal: d.source_key || null, address: addrShort,
            client: ev.client || null, agent, weekend: !!ev.weekend, overdue: dayDiff(ev.start, todayStr) < 0
          });
        } else if (ev.type === 'deadline') {
          (contByDate[ev.start] = contByDate[ev.start] || { client: ev.client, weekend: ev.weekend, labels: [] })
            .labels.push(String(ev.title).split(' — ')[0].replace(/ contingency$/i, ''));
        }
      }
      for (const [date, g] of Object.entries(contByDate)) {
        const many = g.labels.length > 1;
        rows.push({
          type: 'contingency', date, days: dayDiff(date, todayStr),
          label: many ? `Contingency deadline (${g.labels.length})` : `${g.labels[0]} contingency`,
          detail: g.labels.join(', '),
          deal: d.source_key || null, address: addrShort, client: g.client || null,
          agent, weekend: !!g.weekend, overdue: dayDiff(date, todayStr) < 0
        });
      }
    }

    // Soonest first; within a day, contingencies before COE.
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.type === 'coe' ? 1 : 0) - (b.type === 'coe' ? 1 : 0));

    return ok(res, {
      deadlines: rows,
      count: rows.length,
      overdue: rows.filter((r) => r.overdue).length,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
