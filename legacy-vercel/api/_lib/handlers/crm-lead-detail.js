// api/_lib/handlers/crm-lead-detail.js
//
// /api/crm/lead — two methods on the same URL:
//
//   GET  /api/crm/lead?id=<uuid>
//     Returns the full picture for one lead: the lead row + all messages,
//     recent events, saved properties, tours, and open offers. Used by the
//     CRM lead-detail panel.
//
//   PATCH /api/crm/lead
//     Body: { id, pipeline_stage?, assigned_agent? }
//     Updates the lead. Auth is enforced server-side — only Sara/James/admin
//     can patch. Each accepted field is validated against the schema's CHECK
//     constraints. Writes a lead_events row for every change so the activity
//     feed reflects who moved the lead and when.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const PIPELINE_STAGES   = new Set(['new', 'nurture', 'touring', 'offer', 'close']);
const ASSIGNED_AGENTS   = new Set(['sara', 'james', 'unassigned']);

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Auth — required for every method.
  const { user, profile } = await getCallerProfile(req);
  if (!user)              return fail(res, 401, 'not authenticated');
  if (!isAgent(profile))  return fail(res, 403, 'agents only');

  if (req.method === 'GET')   return readLead(req, res);
  if (req.method === 'PATCH') return updateLead(req, res, profile);
  return fail(res, 405, 'method_not_allowed');
}

// ---------------------------------------------------------------------------
// GET — full lead detail
// ---------------------------------------------------------------------------
async function readLead(req, res) {
  try {
    const id = req.query?.id;
    if (!id) return fail(res, 400, 'id required');

    const supa = adminClient();
    const [lead, messages, events, saved, tours, offers, notes] = await Promise.all([
      supa.from('leads').select('*').eq('id', id).single(),
      supa.from('messages').select('*').eq('lead_id', id).order('created_at'),
      supa.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('saved_properties').select('*, properties(*)').eq('lead_id', id).order('last_viewed_at', { ascending: false }),
      supa.from('tours').select('*, properties(address,city,mls_number)').eq('lead_id', id).order('scheduled_at', { ascending: false }),
      supa.from('offers').select('*, properties(address,city,mls_number)').eq('buyer_lead_id', id),
      supa.from('lead_notes').select('id, body, is_internal, created_at, created_by').eq('lead_id', id).order('created_at', { ascending: false }).limit(50)
    ]);

    if (lead.error || !lead.data) return fail(res, 404, 'lead not found');

    return ok(res, {
      lead:             lead.data,
      messages:         messages.data || [],
      events:           events.data   || [],
      saved_properties: saved.data    || [],
      tours:            tours.data    || [],
      offers:           offers.data   || [],
      notes:            notes.data    || []
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---------------------------------------------------------------------------
// PATCH — update pipeline_stage and/or assigned_agent
// ---------------------------------------------------------------------------
async function updateLead(req, res, profile) {
  try {
    const body = await readJson(req);
    const id = body?.id;
    if (!id) return fail(res, 400, 'id required');

    const patch = {};
    const errors = [];

    if (body.pipeline_stage !== undefined) {
      if (!PIPELINE_STAGES.has(body.pipeline_stage)) {
        errors.push(`pipeline_stage must be one of: ${[...PIPELINE_STAGES].join(', ')}`);
      } else {
        patch.pipeline_stage = body.pipeline_stage;
      }
    }
    if (body.assigned_agent !== undefined) {
      if (!ASSIGNED_AGENTS.has(body.assigned_agent)) {
        errors.push(`assigned_agent must be one of: ${[...ASSIGNED_AGENTS].join(', ')}`);
      } else {
        patch.assigned_agent = body.assigned_agent;
      }
    }
    if (errors.length) return fail(res, 400, errors.join('; '));
    if (Object.keys(patch).length === 0) {
      return fail(res, 400, 'nothing to update — pass pipeline_stage and/or assigned_agent');
    }

    const supa = adminClient();

    // 1. Fetch current state so we can compute and log the diff
    const { data: before, error: beforeErr } = await supa
      .from('leads').select('id, pipeline_stage, assigned_agent').eq('id', id).maybeSingle();
    if (beforeErr) return fail(res, 500, beforeErr.message);
    if (!before)   return fail(res, 404, 'lead not found');

    // 2. Apply the patch
    patch.updated_at = new Date().toISOString();
    const { data: after, error: updErr } = await supa
      .from('leads').update(patch).eq('id', id).select().single();
    if (updErr) return fail(res, 500, updErr.message);

    // 3. Log lead_events for each field that actually changed. We piggyback
    //    on 'score_change' (the only neutral event_type currently in the
    //    schema's CHECK list) and namespace the payload so the activity feed
    //    can surface the right label. A future migration adding
    //    'stage_change' / 'reassigned' to the CHECK constraint would make
    //    these cleaner — see notes alongside this commit.
    const agentRole = profile?.role || 'agent_unknown';
    const eventsToLog = [];
    if (patch.pipeline_stage && patch.pipeline_stage !== before.pipeline_stage) {
      eventsToLog.push({
        lead_id:    id,
        event_type: 'score_change',
        source:     'manual',
        event_data: {
          change:     'stage_change',
          from:       before.pipeline_stage,
          to:         patch.pipeline_stage,
          changed_by: agentRole
        }
      });
    }
    if (patch.assigned_agent && patch.assigned_agent !== before.assigned_agent) {
      eventsToLog.push({
        lead_id:    id,
        event_type: 'score_change',
        source:     'manual',
        event_data: {
          change:     'reassigned',
          from:       before.assigned_agent,
          to:         patch.assigned_agent,
          changed_by: agentRole
        }
      });
    }
    if (eventsToLog.length) {
      // Non-blocking: if event insert fails we still return the success of the patch.
      await supa.from('lead_events').insert(eventsToLog);
    }

    return ok(res, {
      lead:    after,
      changed: eventsToLog.map((e) => e.event_data.change),
      before:  { pipeline_stage: before.pipeline_stage, assigned_agent: before.assigned_agent }
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
