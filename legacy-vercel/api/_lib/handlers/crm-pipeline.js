// api/_lib/handlers/crm-pipeline.js
// GET /api/crm/pipeline
//
// Returns leads grouped by pipeline_stage with counts and estimated value.
// Estimated value uses the midpoint of (price_min, price_max) at a 2.5%
// commission assumption — adjustable per agent later.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const STAGES = ['new', 'nurture', 'touring', 'offer', 'close'];
const COMMISSION_PCT = 0.025;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    const { data: leads, error } = await supa
      .from('leads')
      .select('id, first_name, last_name, email, pipeline_stage, score, temperature, price_min, price_max, journey_stage, lead_type, updated_at')
      .eq('status', 'active');

    if (error) return fail(res, 500, error.message);

    const groups = Object.fromEntries(STAGES.map(s => [s, {
      stage: s, leads: [], count: 0, estimated_value: 0
    }]));

    for (const lead of (leads || [])) {
      const g = groups[lead.pipeline_stage] || groups.new;
      g.leads.push(lead);
      g.count += 1;
      const midpoint = midPrice(lead.price_min, lead.price_max);
      if (midpoint) g.estimated_value += midpoint * COMMISSION_PCT;
    }

    // Sort each stage by score desc (hottest leads first)
    for (const g of Object.values(groups)) {
      g.leads.sort((a, b) => (b.score || 0) - (a.score || 0));
      g.estimated_value = Math.round(g.estimated_value);
    }

    return ok(res, {
      stages: STAGES.map(s => groups[s]),
      total_leads: (leads || []).length,
      total_estimated_value: Math.round(
        STAGES.reduce((sum, s) => sum + groups[s].estimated_value, 0)
      )
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

function midPrice(min, max) {
  if (min && max) return (min + max) / 2;
  return min || max || 0;
}
