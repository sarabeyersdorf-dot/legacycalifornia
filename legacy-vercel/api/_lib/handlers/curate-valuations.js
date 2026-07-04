// api/_lib/handlers/curate-valuations.js
// /api/curate/valuations   (agent-only)
//   GET               → list valuation requests for this agent (newest first)
//   PATCH { id, status } → update workflow status (new|reviewed|contacted|archived)
//
// The public SUBMIT path lives in api/c/[token].js (client-facing, tokenized).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');
const STATUSES = ['new', 'reviewed', 'contacted', 'archived'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa  = adminClient();
  const agent = agentKey(profile);

  try {
    if (req.method === 'GET') {
      const { data, error } = await supa
        .from('valuation_requests')
        .select('id, created_at, name, email, phone, address, city, zip, beds, baths, sqft, condition, notes, range_low, range_high, comps, status, collection_id')
        .eq('agent', agent)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return fail(res, 500, error.message);
      return ok(res, { requests: data || [] });
    }

    if (req.method === 'PATCH') {
      const b = await readJson(req);
      if (!b?.id) return fail(res, 400, 'id required');
      if (!STATUSES.includes(b?.status)) return fail(res, 400, `status must be one of ${STATUSES.join(', ')}`);
      const { data, error } = await supa.from('valuation_requests')
        .update({ status: b.status }).eq('id', b.id).eq('agent', agent).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { request: data });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
