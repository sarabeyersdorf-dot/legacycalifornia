// api/_lib/handlers/crm-actions.js
// GET  /api/crm/actions?lead_id=<id>   → the actions applicable to this contact,
//                                         from the contact_actions registry
//                                         (filtered by the lead's roles + stage),
//                                         grouped by action_group.
// POST /api/crm/actions { lead_id, action_id }
//                                       → "perform" a registry action by recording
//                                         a lead-linked task at the action's
//                                         default_visibility. Client-visibility
//                                         actions then surface in the portal.
//
// The registry is the SSOT: add a row to contact_actions → it appears in the
// card menu with no redeploy.  Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  if (req.method === 'GET')  return list(req, res);
  if (req.method === 'POST') return perform(req, res, profile);
  return fail(res, 405, 'method_not_allowed');
}

async function loadLead(supa, id) {
  const { data } = await supa.from('leads')
    .select('id, first_name, last_name, roles, pipeline_stage, assigned_agent')
    .eq('id', id).maybeSingle();
  return data || null;
}

// Registry query, done in JS over the small table (roles overlap + stage gate).
function applicableActions(actions, lead) {
  const leadRoles = lead.roles || [];
  return (actions || []).filter((a) =>
    (a.roles || []).some((r) => leadRoles.includes(r)) &&
    (!a.stages || a.stages.length === 0 || a.stages.includes(lead.pipeline_stage))
  );
}

async function list(req, res) {
  try {
    const supa = adminClient();
    const leadId = req.query?.lead_id;
    if (!leadId) return fail(res, 400, 'lead_id required');
    const lead = await loadLead(supa, leadId);
    if (!lead) return fail(res, 404, 'lead not found');

    const { data: actions, error } = await supa.from('contact_actions')
      .select('id, label, action_group, endpoint, default_visibility, sort_order')
      .eq('active', true)
      .order('action_group', { ascending: true })
      .order('sort_order', { ascending: true });
    if (error) return fail(res, 500, error.message);

    const applicable = applicableActions(actions, lead);
    const groups = {};
    for (const a of applicable) (groups[a.action_group] ||= []).push(a);
    return ok(res, { groups, roles: lead.roles || [], stage: lead.pipeline_stage });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function perform(req, res, profile) {
  try {
    const supa = adminClient();
    const body = await readJson(req);
    const leadId   = body?.lead_id;
    const actionId = body?.action_id;
    if (!leadId || !actionId) return fail(res, 400, 'lead_id and action_id required');

    const lead = await loadLead(supa, leadId);
    if (!lead) return fail(res, 404, 'lead not found');
    const { data: action } = await supa.from('contact_actions')
      .select('id, label, default_visibility').eq('id', actionId).maybeSingle();
    if (!action) return fail(res, 404, 'action not found');

    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
    const { data: task, error } = await supa.from('agent_tasks').insert({
      agent:      agentKey(profile.role),
      lead_id:    lead.id,
      client:     name,
      title:      action.label,
      visibility: action.default_visibility === 'client' ? 'client' : 'internal',
      source:     'action'
    }).select().single();
    if (error) return fail(res, 500, `task: ${error.message}`);

    return ok(res, { task, client_visible: task.visibility === 'client' });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
