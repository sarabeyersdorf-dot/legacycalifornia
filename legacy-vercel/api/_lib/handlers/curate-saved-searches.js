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
        .select('id, name, filters, client_lead_id, auto_push, collection_id, last_auto_push_at, last_run_at, new_match_count, created_at, updated_at, leads(first_name,last_name)')
        .eq('agent', agent)
        .order('updated_at', { ascending: false });
      if (error) return fail(res, 500, error.message);
      const searches = (data || []).map((s) => ({
        id: s.id, name: s.name, filters: s.filters || {},
        client_lead_id: s.client_lead_id,
        client_name: s.leads ? [s.leads.first_name, s.leads.last_name].filter(Boolean).join(' ') : null,
        auto_push: !!s.auto_push, collection_id: s.collection_id || null,
        last_auto_push_at: s.last_auto_push_at,
        last_run_at: s.last_run_at, new_match_count: s.new_match_count || 0,
        created_at: s.created_at, updated_at: s.updated_at
      }));
      return ok(res, { searches });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);

      // Flip auto-email on an existing search without resending its name and
      // filters. The full POST replaces `filters` wholesale, so using it as a
      // toggle meant the UI had to echo the whole search back and any drift
      // silently rewrote the filters. Auto-push still can't be on without a
      // client to email — the cron always needs a recipient.
      if (b?.op === 'set-auto-push') {
        if (!b?.id) return fail(res, 400, 'id required');
        const { data: cur, error: readErr } = await supa.from('saved_searches')
          .select('id, client_lead_id').eq('id', b.id).eq('agent', agent).maybeSingle();
        if (readErr)  return fail(res, 500, readErr.message);
        if (!cur)     return fail(res, 404, 'saved search not found');
        const want = !!b.auto_push;
        if (want && !cur.client_lead_id) return fail(res, 409, 'Attach a client to this search before turning on auto-email.');
        const { data, error } = await supa.from('saved_searches')
          .update({ auto_push: want }).eq('id', b.id).eq('agent', agent).select().single();
        if (error) return fail(res, 500, error.message);
        return ok(res, { search: data, auto_push: want });
      }

      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!name) return fail(res, 400, 'name is required');
      const filters = (b && typeof b.filters === 'object' && b.filters) ? b.filters : {};
      const clientLeadId = b?.client_lead_id || null;
      // Auto-push (hands-off client delivery) requires a client to email —
      // never let it be true without one, so the cron always has a recipient.
      const autoPush = !!b?.auto_push && !!clientLeadId;
      const row = {
        agent, name, filters,
        client_lead_id: clientLeadId,
        auto_push: autoPush
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
