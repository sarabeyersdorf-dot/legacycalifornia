// api/_lib/handlers/crm-deal-create.js
// POST /api/crm/deal-create   (agent-only) — SPEC §4.2, "Add a deal".
//
// Creates a deal straight from the CRM instead of waiting for it to appear in
// deals.json (which today is inferred from a Dropbox folder showing up under
// __Pending — a filesystem heuristic that has been wrong). Sara typing the deal
// is better evidence.
//
// The row is marked created_in_crm=true (db/090) so the hourly sync-deals
// orphan-prune never deletes it, and carries a 'crm-' source_key so it can't
// collide with a deals.json key. Otherwise it is an ordinary deals row every view
// and portal reads normally.
//
// Body (address required; everything else optional):
//   { address, city, type, side, agent, stage, client }
//
// Two hard-won rules from the SOP are enforced as constraints here:
//   • A preparing deal has no RLA, so NO commission — this form never asks for one.
//   • Stage defaults to 'preparing' (a new deal in prep), never 'cancelled'.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

// The full stage vocabulary (SPEC §4.2). Stored in the unconstrained base `stage`
// column (stage_override's CHECK is narrower and is for deals.json-owned deals).
const STAGES = new Set(['preparing', 'listing', 'offer', 'pending', 'closed', 'cancelled', 'inactive', 'buyer-prospect', 'dispute']);
const SIDES  = new Set(['seller', 'buyer', 'both']);
const TYPES  = new Set(['residential', 'land', 'commercial', 'multi-family', 'manufactured']);
const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');
const MISSING_COL = (m) => /created_in_crm|listing_meta|schema cache|column/i.test(m || '');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const rand = () => Math.random().toString(16).slice(2, 7);

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = await readJson(req);
    const address = (b?.address || '').toString().trim().slice(0, 200);
    if (!address) return fail(res, 400, 'address required');

    const city  = (b?.city  || '').toString().trim().slice(0, 120) || null;
    const type  = TYPES.has(b?.type) ? b.type : (b?.type ? String(b.type).trim().slice(0, 40) : null);
    const side  = SIDES.has(b?.side) ? b.side : 'seller';
    const agent = ['sara', 'james', 'both'].includes(b?.agent) ? b.agent : agentKey(profile.role);
    const stage = STAGES.has(b?.stage) ? b.stage : 'preparing';   // never defaults to 'cancelled'
    const client = (b?.client || '').toString().trim().slice(0, 120) || null;

    const supa = adminClient();

    // Unique 'crm-' source_key (retry once on the rare collision).
    let sourceKey = `crm-${slug(address) || 'deal'}-${rand()}`;
    for (let i = 0; i < 2; i++) {
      const { data: clash } = await supa.from('deals').select('id').eq('source_key', sourceKey).maybeSingle();
      if (!clash) break;
      sourceKey = `crm-${slug(address) || 'deal'}-${rand()}`;
    }

    const row = {
      source_key: sourceKey,
      address, city, type, side, stage, agent,
      created_in_crm: true,
      listing_meta: client ? { client } : null
    };

    let ins = await supa.from('deals').insert(row).select('id, source_key, address, city, type, side, stage, agent').single();
    // Fail-soft on a pre-090 / pre-listing_meta schema: retry without the newer
    // columns so a deal can still be created (it just isn't prune-protected until
    // db/090 lands — flagged in the response).
    if (ins.error && MISSING_COL(ins.error.message)) {
      const { created_in_crm, listing_meta, ...bare } = row;
      ins = await supa.from('deals').insert(bare).select('id, source_key, address, city, type, side, stage, agent').single();
      if (!ins.error) return ok(res, { deal: ins.data, warning: 'created, but db/090 not applied yet — this deal is not yet prune-protected. Apply db/090_deal_created_in_crm.sql.' });
    }
    if (ins.error) return fail(res, 500, ins.error.message);

    return ok(res, { deal: ins.data });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
