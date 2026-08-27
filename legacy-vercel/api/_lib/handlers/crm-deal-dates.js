// api/_lib/handlers/crm-deal-dates.js
// SPEC · Agent-editable CRM, §3 — confirmed vs EXPECTED client-facing dates.
//
//   GET  /api/crm/deal-dates?source_key=<key>   (agent-only)
//        → { confirmed: { coe_date, acceptance_date }, expected: { coe_date:{value,by,at,note}, … } }
//   POST /api/crm/deal-dates  (agent-only)
//        body { source_key | deal_id, field: 'coe_date'|'acceptance_date',
//               expected: 'YYYY-MM-DD' | '' (clear), note?: string }
//
// An EXPECTED date is what an agent believes before the executed document exists.
// It is written ONLY here (agent session) into the additive deals.<field>_expected*
// columns (db/089), which sync-deals NEVER writes — so a belief survives the hourly
// rebuild, exactly like agent_overrides.
//
// ABSOLUTE RULE (enforced by NOT wiring these columns into any portal query): an
// expected date NEVER reaches a seller or buyer page. It surfaces only on the
// internal agenda (via /api/crm/reconcile → expected_dates) with who/when/why.
// The confirmed value — agent_overrides.<field> (a CRM confirm) or the synced
// deals.<field> — is the only thing a client ever sees. When the confirmed value
// catches up to the expected value, sync-deals clears the expected overlay
// (promotion) and logs it to deal_audit.
//
// Every write is recorded in deal_audit (db/089): who changed what, from what, when.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail, readJson } from '../cors.js';

const BASE_FIELDS = new Set(['coe_date', 'acceptance_date']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');
const MISSING_COL = (msg) => /_expected|deal_audit|schema cache|column|relation/i.test(msg || '');

const SELECT_COLS = 'id, source_key, agent_overrides, coe_date, acceptance_date, ' +
  'coe_date_expected, coe_date_expected_by, coe_date_expected_at, coe_date_expected_note, ' +
  'acceptance_date_expected, acceptance_date_expected_by, acceptance_date_expected_at, acceptance_date_expected_note';

// The confirmed value a client would see: a CRM confirm (agent_overrides) wins over
// the synced column, matching crm-deals.js read precedence.
function confirmedOf(row, field) {
  const ov = (row.agent_overrides && typeof row.agent_overrides === 'object') ? row.agent_overrides : {};
  return ov[field] ?? row[field] ?? null;
}

function shape(row) {
  return {
    source_key: row.source_key,
    confirmed: { coe_date: confirmedOf(row, 'coe_date'), acceptance_date: confirmedOf(row, 'acceptance_date') },
    expected: {
      coe_date: row.coe_date_expected
        ? { value: row.coe_date_expected, by: row.coe_date_expected_by, at: row.coe_date_expected_at, note: row.coe_date_expected_note }
        : null,
      acceptance_date: row.acceptance_date_expected
        ? { value: row.acceptance_date_expected, by: row.acceptance_date_expected_by, at: row.acceptance_date_expected_at, note: row.acceptance_date_expected_note }
        : null
    }
  };
}

async function findDeal(supa, body, query) {
  const sourceKey = String((body && body.source_key) || query?.source_key || '').trim();
  const dealId    = String((body && body.deal_id) || query?.deal_id || '').trim();
  let q = supa.from('deals').select(SELECT_COLS);
  if (sourceKey)      q = q.eq('source_key', sourceKey);
  else if (dealId && UUID_RE.test(dealId)) q = q.eq('id', dealId);
  else return { err: 'source_key or deal_id required' };
  const { data, error } = await q.maybeSingle();
  if (error) return { dbErr: error };
  if (!data) return { notFound: true };
  return { row: data };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');
    const supa = adminClient();

    if (req.method === 'GET') {
      const r = await findDeal(supa, null, req.query);
      if (r.err) return fail(res, 400, r.err);
      if (r.dbErr) return fail(res, MISSING_COL(r.dbErr.message) ? 409 : 500, r.dbErr.message);
      if (r.notFound) return fail(res, 404, 'deal not found');
      return ok(res, shape(r.row));
    }

    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

    const body = await readJson(req);
    const field = String(body?.field || '').trim();
    if (!BASE_FIELDS.has(field)) return fail(res, 400, `field must be one of: ${[...BASE_FIELDS].join(', ')}`);

    const r = await findDeal(supa, body, null);
    if (r.err) return fail(res, 400, r.err);
    if (r.dbErr) return fail(res, MISSING_COL(r.dbErr.message) ? 409 : 500, `${r.dbErr.message} — run db/089_deal_expected_dates.sql`);
    if (r.notFound) return fail(res, 404, 'deal not found');
    const row = r.row;

    const rawVal = body?.expected;
    const clearing = rawVal == null || String(rawVal).trim() === '';
    let value = null;
    if (!clearing) {
      value = String(rawVal).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail(res, 400, 'expected must be a YYYY-MM-DD date');
    }
    const who  = agentKey(profile?.role);
    const note = (body?.note != null) ? String(body.note).trim().slice(0, 500) || null : null;
    const oldVal = row[`${field}_expected`] || null;

    const patch = clearing
      ? { [`${field}_expected`]: null, [`${field}_expected_by`]: null, [`${field}_expected_at`]: null, [`${field}_expected_note`]: null }
      : { [`${field}_expected`]: value, [`${field}_expected_by`]: who, [`${field}_expected_at`]: new Date().toISOString(), [`${field}_expected_note`]: note };

    const { error: updErr } = await supa.from('deals').update(patch).eq('id', row.id);
    if (updErr) return fail(res, MISSING_COL(updErr.message) ? 409 : 500, `${updErr.message} — run db/089_deal_expected_dates.sql`);

    // Audit — never silent (SPEC §5.2). Fail-soft: an audit hiccup must not fail the edit.
    await supa.from('deal_audit').insert({
      deal_id: row.id, field: `${field}_expected`,
      old_value: oldVal, new_value: clearing ? null : value,
      changed_by: who, source: 'crm',
      note: clearing ? 'cleared' : note
    }).then(() => {}, () => {});

    // Guardrail surfaced to the caller: if a confirmed value already exists and the
    // new expected disagrees, that is a discrepancy the agenda will show — not an
    // error, but worth echoing so the CRM can say so.
    const confirmed = confirmedOf(row, field);
    const disagrees = !clearing && confirmed && confirmed !== value;

    const fresh = await supa.from('deals').select(SELECT_COLS).eq('id', row.id).maybeSingle();
    return ok(res, { ...(fresh.data ? shape(fresh.data) : { source_key: row.source_key }), disagrees_with_confirmed: !!disagrees, confirmed_value: confirmed });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
