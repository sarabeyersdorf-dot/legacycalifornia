// test/deal-timeline.test.mjs
// Unit tests for the CA RPA timeline math. Run: node test/deal-timeline.test.mjs
import assert from 'node:assert/strict';
import {
  computeTimeline, addDays, rollForwardBusinessDay, isWeekend, isFederalHoliday, timelineEvents
} from '../api/_lib/deal-timeline.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const dateOf = (list, key) => (list.find((c) => c.key === key) || {}).date;

console.log('deal-timeline');

// 1. Acceptance-based math — 7230 Latigo + 433 both accepted 6/19 → 17d = 7/6.
test('acceptance is Day 0; 17-day items land 17 days later (6/19 → 7/6)', () => {
  const t = computeTimeline({ acceptance: '2026-06-19', coe: '2026-07-20' });
  assert.equal(t.basis, 'acceptance');
  assert.equal(t.day0, '2026-06-19');
  assert.equal(dateOf(t.contingencies, 'inspection'), '2026-07-06');
  assert.equal(dateOf(t.contingencies, 'appraisal'), '2026-07-06');
  assert.equal(dateOf(t.contingencies, 'title'), '2026-07-06');
});

// 2. Per-deal 25-day loan override — 433 E Hwy 4: loan due 7/14, others 7/6.
test('25-day loan override (433): loan 7/14, other 17-day items 7/6', () => {
  const t = computeTimeline({ acceptance: '2026-06-19', overrides: { loan: 25 }, coe: '2026-08-10' });
  assert.equal(dateOf(t.contingencies, 'loan'), '2026-07-14');       // 6/19 + 25
  assert.equal(dateOf(t.contingencies, 'inspection'), '2026-07-06'); // 6/19 + 17
  assert.equal(dateOf(t.contingencies, 'appraisal'), '2026-07-06');
  assert.equal(dateOf(t.contingencies, 'insurance'), '2026-07-06');
  assert.equal(dateOf(t.contingencies, 'title'), '2026-07-06');
  assert.equal(t.coe.date, '2026-08-10');
  assert.equal(t.coe.rolled, false);
});

// 3. COE weekend roll — 8235 Baldwin: contract COE 8/1 is a Saturday → 8/3.
test('COE rolls off a Saturday to the next business day (8/1 → 8/3)', () => {
  const t = computeTimeline({ acceptance: '2026-06-17', coe: '2026-08-01' });
  assert.equal(isWeekend('2026-08-01'), true);        // sanity: 8/1/2026 is Sat
  assert.equal(t.coe.original, '2026-08-01');
  assert.equal(t.coe.date, '2026-08-03');
  assert.equal(t.coe.rolled, true);
});

// 3b. Contingencies do NOT roll — they keep the actual date, flagged.
test('contingencies keep their date on a weekend/holiday but flag it (8235 → 7/4)', () => {
  const t = computeTimeline({ acceptance: '2026-06-17', coe: '2026-08-01' });
  const insp = t.contingencies.find((c) => c.key === 'inspection');
  assert.equal(insp.date, '2026-07-04');              // 6/17 + 17, NOT rolled
  assert.equal(insp.weekend, true);                   // Saturday
  assert.equal(isFederalHoliday('2026-07-04') || isWeekend('2026-07-04'), true);
  assert.equal(insp.flagged, true);
});

// 4. Partial CR suppression — 7230 Latigo CR1 removed all except appraisal+loan.
test('partial contingency removal: only appraisal + loan remain (7230 Latigo)', () => {
  const t = computeTimeline({ acceptance: '2026-06-19', remaining: ['appraisal', 'loan'], coe: '2026-07-20' });
  const keys = t.contingencies.map((c) => c.key).sort();
  assert.deepEqual(keys, ['appraisal', 'loan']);
  assert.equal(dateOf(t.contingencies, 'appraisal'), '2026-07-06');
  assert.equal(dateOf(t.contingencies, 'loan'), '2026-07-06');
  assert.equal(t.coe.date, '2026-07-20');
});
test('blacklist removal also works (removed everything but appraisal+loan)', () => {
  const t = computeTimeline({ acceptance: '2026-06-19', removed: ['inspection', 'insurance', 'title'] });
  const keys = t.contingencies.map((c) => c.key).sort();
  assert.deepEqual(keys, ['appraisal', 'loan']);
});

// 5. Paused clock — 9985 Wendell (bankruptcy sale): clockStart present & null.
test('paused clock emits no deadlines (9985 Wendell)', () => {
  const t = computeTimeline({ acceptance: '2026-06-15', clockStart: null, coe: '2026-08-01' });
  assert.equal(t.paused, true);
  assert.equal(t.contingencies.length, 0);
  assert.equal(t.coe, null);
});
test('clockStart date overrides acceptance as Day 0', () => {
  const t = computeTimeline({ acceptance: '2026-06-15', clockStart: '2026-07-01' });
  assert.equal(t.basis, 'court-approval notice');
  assert.equal(t.day0, '2026-07-01');
  assert.equal(dateOf(t.contingencies, 'inspection'), '2026-07-18'); // 7/1 + 17
});

// 6. Legacy fallback — only escrow open → flagged basis.
test('legacy record with only escrow-open is flagged "escrow open — verify"', () => {
  const t = computeTimeline({ escrowOpen: '2026-06-19' });
  assert.equal(t.basis, 'escrow open — verify');
  assert.equal(dateOf(t.contingencies, 'inspection'), '2026-07-06');
});

// helpers sanity
test('rollForwardBusinessDay skips weekend + observed holiday', () => {
  assert.equal(rollForwardBusinessDay('2026-08-01'), '2026-08-03'); // Sat -> Mon
  assert.equal(rollForwardBusinessDay('2026-07-04'), '2026-07-06'); // Sat(+Jul4 obs Fri 7/3) -> Mon 7/6
});

// ---------------------------------------------------------------------------
// timelineEvents — the actual event objects the endpoint emits (full window).
// ---------------------------------------------------------------------------
const WINDOW = { todayStr: '2026-06-01', endStr: '2026-08-31' };
const evOn = (evs, type, date) => evs.find((e) => e.type === type && e.start === date);

test('7230 Latigo → appraisal+loan 7/6 deadlines + COE 7/20, nothing else', () => {
  const evs = timelineEvents({
    source_key: '7230-latigo', agent: 'sara', address: '7230 Latigo, Somewhere, CA',
    listing_meta: { client: 'Latigo Buyer' },
    timeline: { acceptance: '2026-06-19', coe: '2026-07-20', remaining: ['appraisal', 'loan'] }
  }, WINDOW);
  const deadlines = evs.filter((e) => e.type === 'deadline');
  assert.equal(deadlines.length, 2);
  assert.ok(evs.some((e) => e.type === 'deadline' && e.start === '2026-07-06' && /Appraisal/.test(e.title)));
  assert.ok(evs.some((e) => e.type === 'deadline' && e.start === '2026-07-06' && /Loan/.test(e.title)));
  assert.ok(evOn(evs, 'coe', '2026-07-20'));
  assert.equal(evs.every((e) => e.deal === '7230-latigo' && e.all_day === true), true);
});

test('433 E Hwy 4 → 4 items 7/6, loan 7/14, COE 8/10; notes state the basis', () => {
  const evs = timelineEvents({
    source_key: '433-hwy4', agent: 'sara', address: '433 E Highway 4, Murphys, CA',
    listing_meta: { client: 'Jim & Yvonne' },
    timeline: { acceptance: '2026-06-19', overrides: { loan: 25 }, coe: '2026-08-10' }
  }, WINDOW);
  assert.equal(evs.filter((e) => e.type === 'deadline' && e.start === '2026-07-06').length, 4);
  const loan = evs.find((e) => /Loan/.test(e.title));
  assert.equal(loan.start, '2026-07-14');
  assert.equal(loan.notes, '25 days from acceptance 2026-06-19.');
  assert.ok(evOn(evs, 'coe', '2026-08-10'));
});

test('8235 Baldwin → contingencies 7/4 flagged weekend, COE rolled 8/1→8/3', () => {
  const evs = timelineEvents({
    source_key: '8235-baldwin', agent: 'james', address: '8235 Baldwin St, Ceres, CA',
    listing_meta: { client: 'Baldwin Buyer' },
    timeline: { acceptance: '2026-06-17', coe: '2026-08-01' }
  }, WINDOW);
  const insp = evs.find((e) => /inspection/i.test(e.title));
  assert.equal(insp.start, '2026-07-04');
  assert.equal(insp.weekend, true);
  assert.match(insp.notes, /act by the prior business day/);
  const coe = evs.find((e) => e.type === 'coe');
  assert.equal(coe.start, '2026-08-03');
  assert.match(coe.notes, /rolled to 2026-08-03/);
});

test('9985 Wendell (paused) → only the informational marker, no deadlines/COE', () => {
  const evs = timelineEvents({
    source_key: '9985-wendell', agent: 'james', address: '9985 Wendell Rd, Mountain Ranch, CA',
    listing_meta: { client: 'Wendell Estate' },
    timeline: { acceptance: '2026-06-15', clockStart: null, coe: '2026-08-01' }
  }, WINDOW);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'other');
  assert.match(evs[0].title, /clocks paused/);
  assert.equal(evs.some((e) => e.type === 'deadline' || e.type === 'coe'), false);
});

test('legacy deal (escrow-open only) flags every title "(basis: escrow open — verify)"', () => {
  const evs = timelineEvents({
    source_key: 'legacy', agent: 'sara', address: '1 Old Rd',
    escrow_open_date: '2026-06-19', coe_date: '2026-07-20', loan_contingency_days: 17
  }, WINDOW);
  assert.ok(evs.length > 0);
  assert.equal(evs.every((e) => /basis: escrow open — verify/.test(e.title)), true);
});

test('range filter drops events outside [today, end]', () => {
  const evs = timelineEvents({
    source_key: 'x', agent: 'sara', address: 'A',
    timeline: { acceptance: '2026-06-19', coe: '2026-08-10' }
  }, { todayStr: '2026-07-10', endStr: '2026-07-31' });
  // 17-day items (7/6) are before the window; COE 8/10 is after → both dropped.
  assert.equal(evs.length, 0);
});

console.log(`\n${passed} passed`);
