// api/_lib/handlers/crm-roster.js
// GET /api/crm/roster?bucket=leads|clients|past|sphere&q=&limit=
// Browsable people lists behind the sidebar roster items. The count returned
// here is computed from the SAME query that fills the list, so the sidebar
// pill and the list can never disagree (the pills are refreshed from this
// response on open).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const COLS = 'id, first_name, last_name, email, phone, temperature, score, lead_type, pipeline_stage, journey_stage, last_contact_at, created_at, source';

function bucketQuery(supa, bucket) {
  let q = supa.from('leads').select(COLS, { count: 'exact' });
  if (bucket === 'clients')     return q.eq('status', 'active').in('pipeline_stage', ['closed', 'close']);
  if (bucket === 'past')        return q.eq('status', 'archived').in('pipeline_stage', ['closed', 'close']);
  if (bucket === 'sphere')      return q.eq('status', 'active').eq('pipeline_stage', 'sphere');
  return q.eq('status', 'active');   // leads (everyone active)
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();
  try {
    const bucket = ['leads', 'clients', 'past', 'sphere'].includes(req.query?.bucket) ? req.query.bucket : 'leads';
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);
    let q = bucketQuery(supa, bucket);
    const term = (req.query?.q || '').toString().trim();
    if (term) {
      const t = term.replace(/[%(),]/g, ' ').trim();
      if (t) q = q.or(`first_name.ilike.%${t}%,last_name.ilike.%${t}%,email.ilike.%${t}%,phone.ilike.%${t}%`);
    }
    const { data, error, count } = await q
      .order('last_contact_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return fail(res, 500, error.message);
    return ok(res, {
      bucket, count: count || 0,
      people: (data || []).map((l) => ({
        id: l.id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || '(no name)',
        email: l.email, phone: l.phone,
        temperature: l.temperature, score: l.score,
        stage: l.pipeline_stage, journey: l.journey_stage, type: l.lead_type,
        last_contact_at: l.last_contact_at, source: l.source
      }))
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
