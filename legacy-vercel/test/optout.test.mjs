// legacy-vercel/test/optout.test.mjs — run with:  node test/optout.test.mjs
//
// Exercises the REAL applyEmailOptOut (the function api/cron/email-sync.js calls)
// against a client that records what it would write, instead of a paraphrase of
// the logic in the test. Asserts the four things that matter:
//
//   1. a one-word "Stop", with Gmail's quoted original inlined, is recognised
//   2. it emits exactly one leads UPDATE and one lead_events INSERT
//   3. a contact already opted out produces NO writes (no duplicate events)
//   4. "Stop by the house around three" produces NO writes
//
// No credentials needed. The emitted operations were also replayed against the
// live database on 2026-09-05 to confirm lead_events accepts them — that insert
// would have been rejected before db/103 added the event_type and source.
import { applyEmailOptOut, detectEmailOptOut } from '../api/_lib/optout-keywords.js';

const TEST_ID = '00000000-0000-0000-0000-000000000000';

function recordingClient(currentRow) {
  const ops = [];
  return { ops, from(table) {
    const ctx = { table, filters: [] };
    const api = {
      select(cols) { ctx.op = 'select'; ctx.cols = cols; return api; },
      update(patch) { ctx.op = 'update'; ctx.patch = patch; return api; },
      insert(row)   { ctx.op = 'insert'; ctx.row = row;
                      ops.push({ ...ctx }); return Promise.resolve({ error: null }); },
      eq(col, val)  { ctx.filters.push([col, val]);
                      if (ctx.op === 'update') { ops.push({ ...ctx }); return Promise.resolve({ error: null }); }
                      return api; },
      maybeSingle() { ops.push({ ...ctx }); return Promise.resolve({ data: currentRow }); }
    };
    return api;
  }};
}

// The exact shape email-sync hands over for Ron's real message: Gmail inlines
// the quoted original with no line break.
const INBOUND = {
  contactId: TEST_ID,
  senderEmail: 'zztest.optout@legacycalifornia.invalid',
  subject: 'Re: The Ledger — Two dates you should put in your fall calendar',
  content: 'Stop On Fri, Sep 4, 2026, 10:05 AM Sara Cooper · Legacy Properties '
         + '<sara@send.legacycalifornia.com> wrote: Two dates you should put in your fall calendar '
         + 'Hi there, The debut Legacy Ledger is out'
};

const alerts = [];
const client = recordingClient({
  first_name: 'ZZTEST', last_name: 'Optout Harness',
  email: 'zztest.optout@legacycalifornia.invalid', email_opt_out: false
});

const result = await applyEmailOptOut(client, INBOUND, { alert: async (t) => alerts.push(t) });

console.log('=== 1. did the real matcher fire? ===');
console.log(JSON.stringify(detectEmailOptOut({ subject: INBOUND.subject, body: INBOUND.content })));
console.log('\n=== 2. what applyEmailOptOut returned ===');
console.log('applied      :', result.applied);
console.log('who          :', result.who);
console.log('event_error  :', result.event_error);
console.log('\n=== 3. the text Sara would get ===');
console.log(alerts[0] || '(none)');
console.log('\n=== 4. operations it emitted, to replay against the live DB ===');
for (const op of client.ops) {
  console.log(`  ${op.op.toUpperCase()} ${op.table}` + (op.filters.length ? ` where ${JSON.stringify(op.filters)}` : ''));
  if (op.patch) console.log('    patch:', JSON.stringify(op.patch));
  if (op.row)   console.log('    row  :', JSON.stringify(op.row));
}

console.log('\n=== 5. already-opted-out contact is left alone (no duplicate event) ===');
const second = recordingClient({ first_name: 'ZZTEST', last_name: 'Optout Harness', email: 'x', email_opt_out: true });
const r2 = await applyEmailOptOut(second, INBOUND, { alert: async () => {} });
console.log('applied:', r2.applied, '| reason:', r2.reason, '| writes emitted:',
  second.ops.filter((o) => o.op !== 'select').length);

console.log('\n=== 6. an ordinary reply from the same contact does nothing ===');
const third = recordingClient({ first_name: 'ZZTEST', last_name: 'Optout Harness', email: 'x', email_opt_out: false });
const r3 = await applyEmailOptOut(third, { ...INBOUND,
  content: 'Stop by the house around three and we can talk about the price. On Fri, Sep 4, 2026 Sara wrote:' },
  { alert: async () => {} });
console.log('applied:', r3.applied, '| reason:', r3.reason, '| writes emitted:',
  third.ops.filter((o) => o.op !== 'select').length);

const failures = [];
if (!result.applied)                                              failures.push('1. a real "Stop" reply was not recognised');
if (result.event_error)                                           failures.push('2. the audit event was rejected: ' + result.event_error);
if (client.ops.filter((o) => o.op !== 'select').length !== 2)     failures.push('2. expected exactly one UPDATE and one INSERT');
if (r2.applied || second.ops.filter((o) => o.op !== 'select').length) failures.push('3. an already-opted-out contact was written to again');
if (r3.applied || third.ops.filter((o) => o.op !== 'select').length)  failures.push('4. "Stop by the house" was treated as an opt-out');

console.log('\n=== result ===');
if (failures.length) { failures.forEach((f) => console.log('FAIL ' + f)); process.exit(1); }
console.log('PASS — all four checks');
