// api/_lib/handlers/curate-saved-searches.js
// /api/curate/saved-searches   (agent-only)
//   GET                 → list this agent's saved searches (+ client name)
//   POST {name,filters, client_lead_id?, id?}  → create or update
//   DELETE ?id=<uuid>   → remove a saved search
//
// "Contacts" are `leads` in this schema, so client_lead_id references leads(id).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');

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
        .from('saved_searches')
        .select('id, name, filters, client_lead_id, last_run_at, new_match_count, created_at, updated_at, leads(first_name,last_name)')
        .eq('agent', agent)
        .order('updated_at', { ascending: false });
      if (error) return fail(res, 500, error.message);
      const searches = (data || []).map((s) => ({
        id: s.id, name: s.name, filters: s.filters || {},
        client_lead_id: s.client_lead_id,
        client_name: s.leads ? [s.leads.first_name, s.leads.last_name].filter(Boolean).join(' ') : null,
        last_run_at: s.last_run_at, new_match_count: s.new_match_count || 0,
        created_at: s.created_at, updated_at: s.updated_at
      }));
      return ok(res, { searches });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!name) return fail(res, 400, 'name is required');
      const filters = (b && typeof b.filters === 'object' && b.filters) ? b.filters : {};
      const row = {
        agent, name, filters,
        client_lead_id: b?.client_lead_id || null
      };
      if (b?.id) {
        const { data, error } = await supa.from('saved_searches')
          .update(row).eq('id', b.id).eq('agent', agent).select().single();
        if (error) return fail(res, 500, error.message);
        return ok(res, { search: data });
      }
      const { data, error } = await supa.from('saved_searches').insert(row).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { search: data });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return fail(res, 400, 'id required');
      const { error } = await supa.from('saved_searches').delete().eq('id', id).eq('agent', agent);
      if (error) return fail(res, 500, error.message);
      return ok(res, { deleted: true, id });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
