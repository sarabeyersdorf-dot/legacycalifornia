// api/_lib/deal-timeline.js
// California RPA (Residential Purchase Agreement) timeline math for the briefing
// calendar. Pure + deterministic so it can be unit-tested without a database.
//
// Rules (see /api/crm/briefing-calendar):
//   * ACCEPTANCE is Day 0. Every contingency/performance period runs from
//     acceptance (final signature on the last counter) — NOT escrow open.
//   * Default period = 17 days for buyer investigation/inspection, appraisal,
//     loan, insurance, and title/seller-document review. COE is per contract.
//   * Per-deal overrides come from the deal record (never hard-coded): a
//     per-contingency day override (e.g. loan = 25), an explicit COE date, or
//     coeDays from acceptance.
//   * COE never lands on a Saturday/Sunday/federal holiday — it rolls forward
//     to the next business day. Contingency deadlines KEEP their actual date
//     even on a weekend/holiday, but are flagged weekend:true so the briefing
//     can warn to act beforehand.
//   * Removed contingencies drop off (partial removals supported).
//   * A clock_start that is present-but-null means the clock hasn't started
//     (e.g. a bankruptcy-court sale awaiting written approval notice): emit no
//     deadlines, only an informational "paused" marker.

export const STANDARD_CONTINGENCIES = ['inspection', 'appraisal', 'loan', 'insurance', 'title'];
export const CONTINGENCY_LABEL = {
  inspection: 'Investigation / inspection contingency',
  appraisal:  'Appraisal contingency',
  loan:       'Loan contingency',
  insurance:  'Insurance contingency',
  title:      'Title / seller-document review contingency'
};
export const DEFAULT_CONTINGENCY_DAYS = 17;

// --- date-only helpers (operate on 'YYYY-MM-DD' in the calendar sense) -------
const pad2 = (n) => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateStr(s) { return typeof s === 'string' && DATE_RE.test(s); }
function parts(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
function fmt(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
export function addDays(s, n) {
  const { y, m, d } = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
export function dow(s) { const { y, m, d } = parts(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=Sun..6=Sat

// --- U.S. federal holidays (observed), computed per year and cached ----------
const _holidayCache = new Map();
function nthWeekday(y, month, weekday, n) { // month 1-12, weekday 0-6, n=1..5
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return fmt(y, month, day);
}
function lastWeekday(y, month, weekday) {
  const last = new Date(Date.UTC(y, month, 0)).getUTCDate(); // last day of month
  const lastDow = new Date(Date.UTC(y, month - 1, last)).getUTCDay();
  return fmt(y, month, last - ((lastDow - weekday + 7) % 7));
}
function observed(s) { // fixed-date holidays: Sat -> Fri, Sun -> Mon
  const d = dow(s);
  if (d === 6) return addDays(s, -1);
  if (d === 0) return addDays(s, 1);
  return s;
}
export function federalHolidays(y) {
  if (_holidayCache.has(y)) return _holidayCache.get(y);
  const set = new Set([
    observed(fmt(y, 1, 1)),      // New Year's Day
    nthWeekday(y, 1, 1, 3),      // MLK — 3rd Mon Jan
    nthWeekday(y, 2, 1, 3),      // Presidents' Day — 3rd Mon Feb
    lastWeekday(y, 5, 1),        // Memorial Day — last Mon May
    observed(fmt(y, 6, 19)),     // Juneteenth
    observed(fmt(y, 7, 4)),      // Independence Day
    nthWeekday(y, 9, 1, 1),      // Labor Day — 1st Mon Sep
    nthWeekday(y, 10, 1, 2),     // Columbus Day — 2nd Mon Oct
    observed(fmt(y, 11, 11)),    // Veterans Day
    nthWeekday(y, 11, 4, 4),     // Thanksgiving — 4th Thu Nov
    observed(fmt(y, 12, 25))     // Christmas
  ]);
  _holidayCache.set(y, set);
  return set;
}
export function isFederalHoliday(s) { return federalHolidays(parts(s).y).has(s); }
export function isWeekend(s) { const d = dow(s); return d === 0 || d === 6; }
export function isNonBusinessDay(s) { return isWeekend(s) || isFederalHoliday(s); }
export function rollForwardBusinessDay(s) {
  let cur = s, guard = 0;
  while (isNonBusinessDay(cur) && guard++ < 14) cur = addDays(cur, 1);
  return cur;
}

// --- the timeline computation ------------------------------------------------
// input (all optional; sourced from the deal record):
//   acceptance      'YYYY-MM-DD'  — Day 0 (final signature)
//   escrowOpen      'YYYY-MM-DD'  — fallback Day-0 basis for legacy records
//   clockStart      undefined | null | 'YYYY-MM-DD'
//                     - key absent  → use acceptance
//                     - present null → CLOCK PAUSED (no deadlines)
//                     - a date      → that date is Day 0 (e.g. court-approval notice)
//   contingencyDays number (default 17)
//   overrides       { loan: 25, appraisal: 21, ... } per-contingency day counts
//   coe             'YYYY-MM-DD'   — explicit contract COE
//   coeDays         number         — alt: days from Day 0
//   remaining       [keys]         — only these contingencies still active (whitelist)
//   removed         [keys]         — these contingencies removed (blacklist)
export function computeTimeline(input = {}) {
  const clockPaused = Object.prototype.hasOwnProperty.call(input, 'clockStart') && input.clockStart === null;

  // Day 0 + basis.
  let day0 = null, basis = null;
  if (isDateStr(input.clockStart)) { day0 = input.clockStart; basis = 'court-approval notice'; }
  else if (isDateStr(input.acceptance)) { day0 = input.acceptance; basis = 'acceptance'; }
  else if (isDateStr(input.escrowOpen)) { day0 = input.escrowOpen; basis = 'escrow open — verify'; }

  if (clockPaused) {
    return { paused: true, day0: null, basis: 'clock not started', contingencies: [], coe: null };
  }
  if (!day0) return { paused: false, day0: null, basis: null, contingencies: [], coe: null };

  const baseDays = Number.isFinite(+input.contingencyDays) ? +input.contingencyDays : DEFAULT_CONTINGENCY_DAYS;
  const overrides = input.overrides || {};

  // Which contingencies still emit?
  let active;
  if (Array.isArray(input.remaining)) active = STANDARD_CONTINGENCIES.filter((k) => input.remaining.includes(k));
  else if (Array.isArray(input.removed)) active = STANDARD_CONTINGENCIES.filter((k) => !input.removed.includes(k));
  else active = STANDARD_CONTINGENCIES.slice();

  const contingencies = active.map((key) => {
    const days = Number.isFinite(+overrides[key]) ? +overrides[key] : baseDays;
    const date = addDays(day0, days);
    return {
      key, label: CONTINGENCY_LABEL[key] || key,
      date, days,
      weekend: isWeekend(date), holiday: isFederalHoliday(date),
      flagged: isNonBusinessDay(date)
    };
  });

  // COE — explicit date, else coeDays from Day 0. Rolls forward off a
  // weekend/holiday (COE must land on a business day).
  let coe = null;
  const coeRaw = isDateStr(input.coe) ? input.coe
              : (Number.isFinite(+input.coeDays) ? addDays(day0, +input.coeDays) : null);
  if (coeRaw) {
    const rolled = rollForwardBusinessDay(coeRaw);
    coe = {
      date: rolled, original: coeRaw, rolled: rolled !== coeRaw,
      basis: isDateStr(input.coe) ? 'contract' : `${input.coeDays} days from ${basis}`
    };
  }

  return { paused: false, day0, basis, contingencies, coe };
}

// --- deal record → briefing-calendar events ---------------------------------
function normAgentKey(a) { const s = String(a || '').toLowerCase(); if (/james/.test(s)) return 'james'; if (/both/.test(s)) return 'both'; return 'sara'; }
function cleanStr(v) { return v == null ? null : String(v).replace(/[<>]/g, '').trim() || null; }

// Map a DB deal row's timeline fields onto the computeTimeline input. A per-deal
// `timeline` jsonb wins; legacy columns (escrow_open_date / coe_date /
// loan_contingency_days) are the fallback (basis flagged "verify").
export function dealTimelineInput(row) {
  const tl = row.timeline || {};
  const input = {
    acceptance:      tl.acceptance || null,
    escrowOpen:      tl.escrowOpen || row.escrow_open_date || null,
    contingencyDays: tl.contingencyDays,
    overrides:       tl.overrides
                      || (Number.isFinite(+row.loan_contingency_days) && +row.loan_contingency_days !== DEFAULT_CONTINGENCY_DAYS
                          ? { loan: +row.loan_contingency_days } : undefined),
    coe:             tl.coe || row.coe_date || null,
    coeDays:         tl.coeDays,
    remaining:       Array.isArray(tl.remaining) ? tl.remaining : null,
    removed:         Array.isArray(tl.removed) ? tl.removed : null
  };
  if (Object.prototype.hasOwnProperty.call(tl, 'clockStart')) input.clockStart = tl.clockStart;
  return input;
}

// Turn a deal row into calendar events (contingency deadlines, COE, or a paused
// marker), filtered to [todayStr, endStr] when provided. Response-shape fields
// only, plus the additive `weekend` flag.
export function timelineEvents(row, { todayStr = null, endStr = null } = {}) {
  const inRange = (s) => (!todayStr || s >= todayStr) && (!endStr || s <= endStr);
  const addrShort = row.address ? String(row.address).split(',')[0] : null;
  const location = cleanStr(row.address);
  const client = cleanStr(row.listing_meta?.client) || cleanStr(row.client) || null;
  const agent = normAgentKey(row.agent);
  const deal = row.source_key || null;

  const T = computeTimeline(dealTimelineInput(row));
  const verify = T.basis === 'escrow open — verify' ? ' (basis: escrow open — verify)' : '';
  const out = [];

  if (T.paused) {
    out.push({
      title: `Awaiting court-approval notice — all clocks paused${addrShort ? ' — ' + addrShort : ''}`,
      start: todayStr, end: null, all_day: true, weekend: false,
      agent, client, deal, type: 'other', location,
      notes: 'All contingency and COE periods start only upon the seller’s written notice of court approval. No deadlines are running yet.'
    });
    return out;
  }

  for (const c of T.contingencies) {
    if (!inRange(c.date)) continue;
    const warn = c.flagged ? ` Falls on a ${c.holiday ? 'federal holiday' : 'weekend'} — act by the prior business day.` : '';
    out.push({
      title: `${c.label}${addrShort ? ' — ' + addrShort : ''}${verify}`,
      start: c.date, end: null, all_day: true, weekend: !!c.flagged,
      agent, client, deal, type: 'deadline', location,
      notes: `${c.days} days from ${T.basis} ${T.day0}.${warn}`
    });
  }

  if (T.coe && inRange(T.coe.date)) {
    const rollNote = T.coe.rolled
      ? ` Per contract ${T.coe.original}; rolled to ${T.coe.date} (next business day).`
      : (T.coe.basis === 'contract' ? ' Per contract.' : ` ${T.coe.basis}.`);
    out.push({
      title: `Close of escrow${addrShort ? ' — ' + addrShort : ''}${verify}`,
      start: T.coe.date, end: null, all_day: true, weekend: false,
      agent, client, deal, type: 'coe', location,
      notes: `Deed records and proceeds release.${rollNote}`
    });
  }

  return out;
}
