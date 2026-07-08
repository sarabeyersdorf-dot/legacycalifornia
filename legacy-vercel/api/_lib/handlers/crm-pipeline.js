// api/_lib/handlers/crm-pipeline.js
// GET /api/crm/pipeline
//
// Returns leads grouped by pipeline_stage with counts and estimated value.
// Estimated value uses the midpoint of (price_min, price_max) at a 2.5%
// commission assumption — adjustable per agent later.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const STAGES = ['new', 'nurture', 'consult', 'signed', 'active', 'under_contract', 'closed'];
// Legacy stage keys → new keys, so un-migrated leads still land in the right
// column even before db/012 runs. 'sphere' is intentionally not a column.
const STAGE_REMAP = { touring: 'active', offer: 'under_contract', close: 'closed' };
const COMMISSION_PCT = 0.025;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    // Prefer the side-aware columns (db/023); fall back gracefully if that
    // migration hasn't been run yet so the board still loads.
    const FULL = 'id, first_name, last_name, email, pipeline_stage, deal_side, buyer_stage, seller_stage, contact_type, score, temperature, price_min, price_max, journey_stage, lead_type, areas, updated_at';
    const BASE = 'id, first_name, last_name, email, pipeline_stage, deal_side, score, temperature, price_min, price_max, journey_stage, lead_type, areas, updated_at';
    let { data: leads, error } = await supa
      .from('leads').select(FULL).eq('status', 'active');
    if (error && /column|schema cache/i.test(error.message || '')) {
      ({ data: leads, error } = await supa
        .from('leads').select(BASE).eq('status', 'active'));
    }

    if (error) return fail(res, 500, error.message);

    const groups = Object.fromEntries(STAGES.map(s => [s, {
      stage: s, leads: [], count: 0, estimated_value: 0
    }]));
    // Sphere/unknown leads aren't kanban columns, but the CRM still needs them
    // for the Roster "Sphere" segment — carried in an extra group the kanban skips.
    const sphere = { stage: 'sphere', leads: [], count: 0, estimated_value: 0 };

    for (const lead of (leads || [])) {
      const key = STAGE_REMAP[lead.pipeline_stage] || lead.pipeline_stage;
      const g = groups[key];
      if (g) {
        g.leads.push(lead);
        g.count += 1;
        const midpoint = midPrice(lead.price_min, lead.price_max);
        if (midpoint) g.estimated_value += midpoint * COMMISSION_PCT;
      } else {
        sphere.leads.push(lead);
        sphere.count += 1;
      }
    }

    // Sort each stage by score desc (hottest leads first)
    for (const g of [...Object.values(groups), sphere]) {
      g.leads.sort((a, b) => (b.score || 0) - (a.score || 0));
      g.estimated_value = Math.round(g.estimated_value);
    }

    return ok(res, {
      stages: [...STAGES.map(s => groups[s]), sphere],
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
