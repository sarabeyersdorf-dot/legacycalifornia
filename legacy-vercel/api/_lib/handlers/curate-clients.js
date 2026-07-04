// api/_lib/handlers/curate-clients.js
// GET /api/curate/clients?q=<text>   (agent-only)
// Search the agent's contacts (leads) by name / email / phone for the
// collection client-picker. Returns up to 12, most-recent first when q is empty.

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
    const q = (req.query?.q || '').toString().trim();
    let query = supa.from('leads')
      .select('id, first_name, last_name, email, phone')
      .order('updated_at', { ascending: false })
      .limit(12);
    if (q) {
      const s = q.replace(/[%,()]/g, ' ').trim();
      if (s) query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    const clients = (data || []).map((l) => ({
      id: l.id,
      name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Unnamed lead',
      email: l.email || null,
      phone: l.phone || null
    }));
    return ok(res, { clients });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
