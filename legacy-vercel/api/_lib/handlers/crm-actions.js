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
    .select('id, first_name, last_name, roles, deal_side, pipeline_stage, assigned_agent')
    .eq('id', id).maybeSingle();
  return data || null;
}

// Effective roles are computed from deal_side + stage at query time so the menu
// is correct even when a lead is untagged or its Side was just changed (the
// stored roles[] column can go stale). An untagged lead shows both sides'
// actions rather than none.
function effectiveRoles(lead) {
  const s = lead.deal_side;
  let base;
  if (s === 'both')        base = ['buyer', 'seller'];
  else if (s === 'buyer')  base = ['buyer'];
  else if (s === 'seller') base = ['seller'];
  else                     base = ['buyer', 'seller']; // untagged → show both
  if (['closed', 'sphere'].includes(lead.pipeline_stage)) base.push('past_client');
  return base;
}

// Built-in default registry — the source of truth when the contact_actions
// table is empty or unreachable, so the Actions menu ALWAYS works out of the
// box (DB rows, when present, take precedence and can customize/extend it).
const DEFAULT_ACTIONS = [
  { id: 'send-text',            label: 'Send text',            action_group: 'communicate', endpoint: '/api/crm/message',      default_visibility: 'internal', roles: ['buyer','seller','past_client'], stages: null, sort_order: 10 },
  { id: 'send-email',           label: 'Send email',           action_group: 'communicate', endpoint: '/api/crm/message',      default_visibility: 'internal', roles: ['buyer','seller','past_client'], stages: null, sort_order: 20 },
  { id: 'log-call',             label: 'Log a call',           action_group: 'communicate', endpoint: '/api/crm/note',         default_visibility: 'internal', roles: ['buyer','seller','past_client'], stages: null, sort_order: 30 },
  { id: 'start-sequence',       label: 'Start sequence',       action_group: 'communicate', endpoint: '/api/sequences/enroll', default_visibility: 'internal', roles: ['buyer','seller'],               stages: null, sort_order: 40 },
  { id: 'create-task',          label: 'Create task',          action_group: 'schedule',    endpoint: '/api/crm/actions',      default_visibility: 'internal', roles: ['buyer','seller','past_client'], stages: null, sort_order: 50 },
  { id: 'book-appointment',     label: 'Book appointment',     action_group: 'schedule',    endpoint: '/api/crm/actions',      default_visibility: 'client',   roles: ['buyer','seller'],               stages: null, sort_order: 60 },
  { id: 'schedule-inspection',  label: 'Schedule inspection',  action_group: 'schedule',    endpoint: '/api/crm/actions',      default_visibility: 'client',   roles: ['seller'],                       stages: null, sort_order: 70 },
  { id: 'schedule-photographer',label: 'Schedule photographer',action_group: 'schedule',    endpoint: '/api/crm/actions',      default_visibility: 'internal', roles: ['seller'],                       stages: null, sort_order: 80 },
  { id: 'generate-cma',         label: 'Generate CMA',         action_group: 'market',      endpoint: '/api/crm/actions',      default_visibility: 'internal', roles: ['seller'],                       stages: null, sort_order: 90 },
  { id: 'send-seller-report',   label: 'Send seller report',   action_group: 'market',      endpoint: '/api/crm/actions',      default_visibility: 'client',   roles: ['seller'],                       stages: null, sort_order: 100 },
  { id: 'create-curated-search',label: 'Create curated search',action_group: 'market',      endpoint: '/api/crm/actions',      default_visibility: 'client',   roles: ['buyer'],                        stages: null, sort_order: 110 },
  { id: 'assign-agent',         label: 'Assign to agent',      action_group: 'transact',    endpoint: '/api/crm/broker',       default_visibility: 'internal', roles: ['buyer','seller','past_client'], stages: null, sort_order: 120 },
  { id: 'copy-portal-link',     label: 'Copy portal link',     action_group: 'transact',    endpoint: 'copy-portal-link',      default_visibility: 'internal', roles: ['buyer','seller'],               stages: null, sort_order: 130 },
  { id: 'request-review',       label: 'Request review',       action_group: 'transact',    endpoint: '/api/crm/message',      default_visibility: 'client',   roles: ['past_client'],                  stages: null, sort_order: 140 }
];

// Registry query, done in JS over the small table (roles overlap + stage gate).
function applicableActions(actions, lead) {
  const leadRoles = effectiveRoles(lead);
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

    // MUST select roles + stages — applicableActions filters on them; without
    // them every action is (wrongly) excluded and the menu comes up empty.
    let actions = null;
    const { data, error } = await supa.from('contact_actions')
      .select('id, label, action_group, endpoint, default_visibility, roles, stages, sort_order')
      .eq('active', true)
      .order('action_group', { ascending: true })
      .order('sort_order', { ascending: true });
    if (!error && data && data.length) actions = data;
    // Empty table or query error → fall back to the built-in registry so the
    // Actions menu always works.
    if (!actions) actions = DEFAULT_ACTIONS;

    const applicable = applicableActions(actions, lead);
    const groups = {};
    for (const a of applicable) (groups[a.action_group] ||= []).push(a);
    return ok(res, { groups, roles: effectiveRoles(lead), stage: lead.pipeline_stage });
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
    // Resolve the action from the DB, or from the built-in defaults if the
    // registry table is empty (default ids are stable strings, not uuids).
    let action = null;
    const { data: dbAction } = await supa.from('contact_actions')
      .select('id, label, default_visibility').eq('id', actionId).maybeSingle();
    action = dbAction || DEFAULT_ACTIONS.find((a) => a.id === actionId) || null;
    if (!action) return fail(res, 404, 'action not found');

    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
    // Always create the task INTERNAL (visibility off), regardless of the
    // action's default. The agent reviews and edits the wording, then flips the
    // toggle when they're ready for the client to see it — nothing reaches the
    // portal automatically. shareable = this action is meant to be shared.
    const { data: task, error } = await supa.from('agent_tasks').insert({
      agent:      agentKey(profile.role),
      lead_id:    lead.id,
      client:     name,
      title:      action.label,
      visibility: 'internal',
      source:     'action'
    }).select().single();
    if (error) return fail(res, 500, `task: ${error.message}`);

    return ok(res, { task, shareable: action.default_visibility === 'client' });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
