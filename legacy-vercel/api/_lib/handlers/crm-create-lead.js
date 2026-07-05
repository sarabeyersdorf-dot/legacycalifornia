// api/_lib/handlers/crm-create-lead.js
// POST /api/crm/create-lead
//
// Creates a single lead from the CRM "+ New lead" form. Agent-only
// (server-side check) — matches the RLS on public.leads.
//
// Body (all optional except one of first_name / last_name / email):
//   { first_name, last_name, email, phone, lead_type, temperature,
//     assigned_agent, pipeline_stage, price_min, price_max, notes }
//
// Defaults:
//   - source:         'manual'
//   - status:         'active'
//   - temperature:    'new'
//   - pipeline_stage: 'new'
//   - assigned_agent: the signed-in agent (sara / james), else 'sara'
//
// De-dupe: if an active lead already exists with the same (lowercased) email,
// the existing lead is returned with existed:true rather than inserting a copy.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const ALLOWED_AGENTS = new Set(['sara', 'james', 'unassigned']);
const ALLOWED_TYPES  = new Set(['buyer', 'seller', 'land', 'investor']);
const ALLOWED_TEMPS  = new Set(['new', 'warm', 'hot', 'cold']);
const ALLOWED_STAGES = new Set(['new', 'nurture', 'touring', 'offer', 'close', 'sphere']);

function agentKeyForRole(role) {
  if (role === 'agent_james') return 'james';
  return 'sara';
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);

    const first = (body?.first_name || '').trim() || null;
    const last  = (body?.last_name  || '').trim() || null;
    const email = (body?.email || '').toLowerCase().trim() || null;
    const phone = (body?.phone || '').trim() || null;

    if (!first && !last && !email) {
      return fail(res, 400, 'Enter at least a name or an email.');
    }

    const supa = adminClient();

    // De-dupe on email so a double-tap or re-add doesn't create twins.
    if (email) {
      const { data: dupe } = await supa
        .from('leads').select('*').eq('email', email).maybeSingle();
      if (dupe) return ok(res, { lead: dupe, existed: true });
    }

    const assigned = ALLOWED_AGENTS.has(body?.assigned_agent)
      ? body.assigned_agent
      : agentKeyForRole(profile?.role);

    const row = {
      first_name:     first,
      last_name:      last,
      email,
      phone,
      source:         'manual',
      lead_type:      ALLOWED_TYPES.has(body?.lead_type)   ? body.lead_type   : null,
      temperature:    ALLOWED_TEMPS.has(body?.temperature) ? body.temperature : 'new',
      assigned_agent: assigned,
      pipeline_stage: ALLOWED_STAGES.has(body?.pipeline_stage) ? body.pipeline_stage : 'new',
      price_min:      num(body?.price_min),
      price_max:      num(body?.price_max),
      notes:          (body?.notes || '').trim() || null,
      status:         'active'
    };

    const { data: lead, error } = await supa.from('leads').insert(row).select().single();
    if (error) return fail(res, 500, `leads insert: ${error.message}`);

    return ok(res, { lead, existed: false });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
