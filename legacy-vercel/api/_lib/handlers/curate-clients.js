// api/_lib/handlers/curate-clients.js
// GET /api/curate/clients?q=<query>
//
// Contact search for "Attach a client" on a curated collection. Matches the
// agent's leads by name / email / phone and returns { clients: [...] } shaped
// for the picker. Agent-only.
//
// (Was previously a stray copy of the collections handler, so the picker got
// { collections } instead of { clients } and always showed "No matches".)

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const supa = adminClient();
    const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';

    let query = supa
      .from('leads')
      .select('id, first_name, last_name, email, phone')
      .order('created_at', { ascending: false })
      .limit(30);

    if (q) {
      // Sanitize for the PostgREST .or() grammar (commas/parens are delimiters).
      const like = `%${q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim()}%`;
      query = query.or(
        `first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`
      );
    }

    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);

    const clients = (data || []).map((l) => ({
      id:    l.id,
      name:  [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Unnamed contact',
      email: l.email || null,
      phone: l.phone || null
    }));
    return ok(res, { clients });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
