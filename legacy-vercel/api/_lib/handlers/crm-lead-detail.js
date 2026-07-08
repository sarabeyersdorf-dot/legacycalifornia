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

const PIPELINE_STAGES   = new Set(['new', 'nurture', 'consult', 'signed', 'active', 'under_contract', 'closed', 'sphere']);
const ASSIGNED_AGENTS   = new Set(['sara', 'james', 'both', 'unassigned']);
const STATUSES          = new Set(['active', 'archived', 'do_not_contact']);
const DEAL_SIDES        = new Set(['buyer', 'seller', 'both']);
const CONTACT_TYPES     = new Set(['buyer', 'seller', 'both', 'closed', 'past_client', 'sphere', 'nurture', 'has_agent', 'showing_homes', 'making_offers', 'do_not_call']);
const CONSENT_FIELDS    = ['call_opt_out', 'sms_opt_out', 'email_opt_out', 'not_interested'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Auth — required for every method.
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)              return fail(res, 401, 'not authenticated');
  if (!isAgent(profile))  return fail(res, 403, 'agents only');

  if (req.method === 'GET')    return readLead(req, res);
  if (req.method === 'PATCH')  return updateLead(req, res, profile);
  if (req.method === 'DELETE') return deleteLead(req, res);
  return fail(res, 405, 'method_not_allowed');
}

// ---------------------------------------------------------------------------
// DELETE — permanently remove a contact ("Trash"). Agents only.
// ---------------------------------------------------------------------------
async function deleteLead(req, res) {
  try {
    let id = req.query?.id;
    if (!id) { const body = await readJson(req).catch(() => ({})); id = body?.id; }
    if (!id) return fail(res, 400, 'id required');

    const supa = adminClient();
    // Clear links that may not cascade (identity + shared-visibility), then the
    // lead. Dependent rows with ON DELETE CASCADE (lead_events, messages, tours,
    // saved_properties) go automatically. Best-effort on the link tables so a
    // missing/renamed table never blocks the delete.
    await supa.from('deal_parties').delete().eq('lead_id', id).then(() => {}, () => {});
    await supa.from('portal_items').delete().eq('lead_id', id).then(() => {}, () => {});
    const { error } = await supa.from('leads').delete().eq('id', id);
    if (error) return fail(res, 500, error.message);
    return ok(res, { deleted: true, id });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---------------------------------------------------------------------------
// GET — full lead detail
// ---------------------------------------------------------------------------
async function readLead(req, res) {
  try {
    const id = req.query?.id;
    if (!id) return fail(res, 400, 'id required');

    const supa = adminClient();
    const [lead, messages, events, saved, tours, offers, notes, tasks, appts] = await Promise.all([
      supa.from('leads').select('*').eq('id', id).single(),
      supa.from('messages').select('*').eq('lead_id', id).order('created_at'),
      supa.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('saved_properties').select('*, properties(*)').eq('lead_id', id).order('last_viewed_at', { ascending: false }),
      supa.from('tours').select('*, properties(address,city,mls_number)').eq('lead_id', id).order('scheduled_at', { ascending: false }),
      supa.from('offers').select('*, properties(address,city,mls_number)').eq('buyer_lead_id', id),
      supa.from('lead_notes').select('id, body, is_internal, created_at, created_by').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('agent_tasks').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      supa.from('appointments').select('*').eq('lead_id', id).order('starts_at', { ascending: false })
    ]);

    if (lead.error || !lead.data) return fail(res, 404, 'lead not found');

    return ok(res, {
      lead:             lead.data,
      messages:         messages.data || [],
      events:           events.data   || [],
      saved_properties: saved.data    || [],
      tours:            tours.data    || [],
      offers:           offers.data   || [],
      notes:            notes.data    || [],
      tasks:            tasks.data     || [],
      appointments:     appts.data     || []
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
    if (body.status !== undefined) {
      if (!STATUSES.has(body.status)) {
        errors.push(`status must be one of: ${[...STATUSES].join(', ')}`);
      } else {
        patch.status = body.status;
      }
    }
    if (body.deal_side !== undefined) {
      if (body.deal_side === null || body.deal_side === '') {
        patch.deal_side = null;
      } else if (!DEAL_SIDES.has(body.deal_side)) {
        errors.push(`deal_side must be one of: ${[...DEAL_SIDES].join(', ')}`);
      } else {
        patch.deal_side = body.deal_side;
      }
    }
    // Contact "Side / category". buyer/seller/both also mirror to deal_side so
    // portal/side logic stays correct; "do_not_call" also sets call_opt_out.
    if (body.contact_type !== undefined) {
      if (body.contact_type === null || body.contact_type === '') {
        patch.contact_type = null;
      } else if (!CONTACT_TYPES.has(body.contact_type)) {
        errors.push(`contact_type must be one of: ${[...CONTACT_TYPES].join(', ')}`);
      } else {
        patch.contact_type = body.contact_type;
        if (DEAL_SIDES.has(body.contact_type)) patch.deal_side = body.contact_type;
        if (body.contact_type === 'do_not_call') patch.call_opt_out = true;
      }
    }
    // Contact-preference toggles — let an agent clear a wrongly-set "do not
    // call / text / email" or "not interested" flag directly from the lead.
    for (const f of CONSENT_FIELDS) {
      if (body[f] !== undefined) patch[f] = !!body[f];
    }
    if (errors.length) return fail(res, 400, errors.join('; '));
    if (Object.keys(patch).length === 0) {
      return fail(res, 400, 'nothing to update');
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
