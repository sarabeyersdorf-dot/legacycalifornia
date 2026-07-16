// api/_lib/handlers/crm-roster.js
// GET /api/crm/roster?bucket=leads|clients|past|sphere|all&q=&limit=
// Browsable people lists behind the sidebar roster items. The count returned
// here is computed from the SAME query that fills the list, so the sidebar
// pill and the list can never disagree (the pills are refreshed from this
// response on open).
//
// bucket=all is a separate mode for typeahead contact-tagging (e.g. the
// Notes tab's "tag a contact" field): no status/stage filter at all, so it
// can find anyone — active, archived, sphere, past client. It REQUIRES a
// search term (min 2 chars) and returns nothing without one, since it's
// meant to be typed-into, not browsed.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const COLS = 'id, first_name, last_name, email, phone, temperature, score, lead_type, pipeline_stage, journey_stage, last_contact_at, created_at, source';

function bucketQuery(supa, bucket) {
  let q = supa.from('leads').select(COLS, { count: 'exact' });
  if (bucket === 'clients')     return q.eq('status', 'active').in('pipeline_stage', ['closed', 'close']);
  if (bucket === 'past')        return q.eq('status', 'archived').in('pipeline_stage', ['closed', 'close']);
  if (bucket === 'sphere')      return q.eq('status', 'active').eq('pipeline_stage', 'sphere');
  if (bucket === 'all')         return q;   // no filter — every lead, any status/stage
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
    const bucket = ['leads', 'clients', 'past', 'sphere', 'all'].includes(req.query?.bucket) ? req.query.bucket : 'leads';
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);
    const term = (req.query?.q || '').toString().trim();

    if (bucket === 'all' && term.length < 2) {
      return ok(res, { bucket, count: 0, people: [] });
    }

    let q = bucketQuery(supa, bucket);
    if (term) {
      const t = term.replace(/[%(),]/g, ' ').trim();
      if (t) {
        const clauses = [
          `first_name.ilike.%${t}%`,
          `last_name.ilike.%${t}%`,
          `email.ilike.%${t}%`,
          `phone.ilike.%${t}%`
        ];
        // A typed "First Last" (or "Last First") won't match either name
        // column alone as a single substring — split on the first space and
        // also try first_name+last_name matched pairwise, both orders, so
        // "Dan Har" finds a lead with first_name="Dan", last_name="Harder".
        const words = t.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          const w1 = words[0];
          const w2 = words.slice(1).join(' ');
          clauses.push(`and(first_name.ilike.%${w1}%,last_name.ilike.%${w2}%)`);
          clauses.push(`and(first_name.ilike.%${w2}%,last_name.ilike.%${w1}%)`);
        }
        q = q.or(clauses.join(','));
      }
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
