// api/_lib/handlers/crm-deal-edit.js
// POST /api/crm/deal-edit   (agent-only)
//
// Lets James & Sara correct a deal's facts from inside the CRM — a blank/wrong
// price, close date, address, MLS #, side, or agent — and have the edit STICK.
//
// The edit is stored in deals.agent_overrides (db/066), a jsonb blob the hourly
// deals.json sync never writes, so it's never clobbered (same pattern as
// stage_override / photo_override). The read paths (crm-deals.js) prefer an
// override over the synced column, so a saved edit wins over Cowork's value.
// Clearing a field (empty value) DELETES that key → the deal reverts to the
// synced (Cowork) value.
//
// Body: { source_key: string, fields: { list_price?, sale_price?, address?,
//         city?, coe_date?, mls_number?, side?, agent? } }

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail, readJson } from '../cors.js';

const NUMERIC = new Set(['list_price', 'sale_price']);
const TEXT    = new Set(['address', 'city', 'mls_number']);
const DATE    = new Set(['coe_date']);
const URLF    = new Set(['video_url', 'matterport_url', 'showcase_url']);   // listing media + marketing page → seller portal
const ENUMS   = { side: ['buyer', 'seller', 'both', 'listing'], agent: ['sara', 'james', 'both'] };
const ALLOWED = new Set([...NUMERIC, ...TEXT, ...DATE, ...URLF, ...Object.keys(ENUMS)]);

const MISSING_COL = (msg) => /agent_overrides|schema cache|column/i.test(msg || '');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const body = await readJson(req);
    const sourceKey = String(body.source_key || '').trim();
    if (!sourceKey) return fail(res, 400, 'source_key required');
    const fields = (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) ? body.fields : {};

    const supa = adminClient();

    // Current overrides (fail clearly if the column isn't migrated yet).
    const sel = await supa.from('deals').select('id, agent_overrides').eq('source_key', sourceKey).maybeSingle();
    if (sel.error) {
      if (MISSING_COL(sel.error.message)) return fail(res, 409, 'agent_overrides column missing — run db/066_deal_agent_overrides.sql');
      return fail(res, 500, sel.error.message);
    }
    if (!sel.data) return fail(res, 404, `no deal with source_key ${sourceKey}`);

    const cur = (sel.data.agent_overrides && typeof sel.data.agent_overrides === 'object' && !Array.isArray(sel.data.agent_overrides))
      ? { ...sel.data.agent_overrides } : {};

    for (const [k, vRaw] of Object.entries(fields)) {
      if (!ALLOWED.has(k)) continue;
      // Empty → clear the override (revert to Cowork's synced value).
      if (vRaw == null || String(vRaw).trim() === '') { delete cur[k]; continue; }
      if (NUMERIC.has(k)) {
        const n = Number(String(vRaw).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(n) || n < 0) return fail(res, 400, `${k} must be a non-negative number`);
        cur[k] = Math.round(n);
      } else if (DATE.has(k)) {
        const s = String(vRaw).trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fail(res, 400, `${k} must be a YYYY-MM-DD date`);
        cur[k] = s;
      } else if (URLF.has(k)) {
        const s = String(vRaw).trim();
        if (!/^https?:\/\//i.test(s)) return fail(res, 400, `${k} must be a full URL (https://…)`);
        cur[k] = s.slice(0, 500);
      } else if (ENUMS[k]) {
        const s = String(vRaw).trim().toLowerCase();
        if (!ENUMS[k].includes(s)) return fail(res, 400, `${k} must be one of: ${ENUMS[k].join(', ')}`);
        cur[k] = s;
      } else { // TEXT
        cur[k] = String(vRaw).trim().slice(0, 200);
      }
    }

    // Store null (not {}) when no overrides remain, so a cleared deal reads clean.
    const next = Object.keys(cur).length ? cur : null;
    const { error: updErr } = await supa.from('deals').update({ agent_overrides: next }).eq('id', sel.data.id);
    if (updErr) {
      if (MISSING_COL(updErr.message)) return fail(res, 409, 'agent_overrides column missing — run db/066_deal_agent_overrides.sql');
      return fail(res, 500, updErr.message);
    }

    return ok(res, { source_key: sourceKey, overrides: next || {} });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
