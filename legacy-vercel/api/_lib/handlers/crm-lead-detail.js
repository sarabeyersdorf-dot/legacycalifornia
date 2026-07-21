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
const CONTACT_TYPES     = new Set(['buyer', 'seller', 'both', 'past_client', 'sphere', 'do_not_contact']);
const BUYER_STAGES      = new Set(['new', 'nurture', 'showing_homes', 'writing_offers', 'in_escrow', 'closed']);
const SELLER_STAGES     = new Set(['new', 'nurture', 'preparing', 'on_market', 'reviewing_offers', 'in_escrow', 'closed']);
const CONSENT_FIELDS    = ['call_opt_out', 'sms_opt_out', 'email_opt_out', 'not_interested'];

// Rank a side stage so a dual client's kanban/header follows the more-advanced
// side, and map each side stage to the coarse pipeline_stage (one source of
// truth — changing a status moves the contact in the pipeline).
const STAGE_RANK = { new: 0, nurture: 1, showing_homes: 2, preparing: 2, on_market: 3, writing_offers: 3, reviewing_offers: 3, in_escrow: 4, closed: 5 };
const STAGE_TO_PIPELINE = {
  new: 'new', nurture: 'nurture',
  showing_homes: 'active', preparing: 'active', on_market: 'active',
  writing_offers: 'active', reviewing_offers: 'active',
  in_escrow: 'under_contract', closed: 'closed'
};
// The pipeline_stage that best represents a contact given its side stages + category.
function derivePipeline(contactType, buyerStage, sellerStage) {
  if (contactType === 'sphere' || contactType === 'past_client') return 'sphere';
  const candidates = [buyerStage, sellerStage].filter((s) => s && STAGE_RANK[s] != null);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (STAGE_RANK[b] > STAGE_RANK[a] ? b : a));
  return STAGE_TO_PIPELINE[best] || null;
}

// Manual SMS consent toggle from the lead-detail "Update contact" panel
// (db/033). The checkbox always submits its current checked state on every
// save, so just stage the boolean here — sms_consent_at/sms_consent_source
// only get stamped in updateLead() once we know whether the value actually
// flipped from what's on record (see the "before" comparison below), so
// re-saving name/phone edits doesn't clobber the original consent date.
function applySmsConsent(patch, body) {
  if (body.sms_consent !== undefined) {
    patch.sms_consent = body.sms_consent === true || body.sms_consent === 'on' || body.sms_consent === 'true';
  }
}

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
    const [lead, messages, events, saved, tours, offers, notes, tasks, appts, dealMsgs] = await Promise.all([
      supa.from('leads').select('*').eq('id', id).single(),
      supa.from('messages').select('*').eq('lead_id', id).order('created_at'),
      supa.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('saved_properties').select('*, properties(*)').eq('lead_id', id).order('last_viewed_at', { ascending: false }),
      supa.from('tours').select('*, properties(address,city,mls_number)').eq('lead_id', id).order('scheduled_at', { ascending: false }),
      supa.from('offers').select('*, properties(address,city,mls_number)').eq('buyer_lead_id', id),
      supa.from('lead_notes').select('id, body, is_internal, created_at, created_by').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('agent_tasks').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      supa.from('appointments').select('*').eq('lead_id', id).order('starts_at', { ascending: false }),
      // Inbound texts/calls live in deal_messages, keyed by contact_id. Pull
      // them in so this lead's conversation shows texts alongside portal/email.
      supa.from('deal_messages').select('id, direction, channel, content, call_duration_seconds, raw_phone_number, created_at')
        .eq('contact_id', id).order('created_at').then((r) => r, () => ({ data: [] }))
    ]);

    if (lead.error || !lead.data) return fail(res, 404, 'lead not found');

    // Fold deal_messages into the conversation as message-shaped rows so the
    // existing thread renderer shows them inline, chronologically.
    const thread = (messages.data || []).slice();
    for (const d of (dealMsgs && dealMsgs.data) || []) {
      const isCall = d.channel === 'call';
      const dur = parseInt(d.call_duration_seconds, 10);
      const body = isCall
        ? ('☎ Call' + (dur ? ` · ${Math.floor(dur / 60)}m ${dur % 60}s` : ''))
        : (d.content || '');
      thread.push({
        id: 'dm-' + d.id, lead_id: id,
        direction: d.direction || 'inbound',
        channel: isCall ? 'call' : 'sms',
        body, subject: null, status: 'delivered', ai_generated: false,
        created_at: d.created_at, _source: 'deal_messages'
      });
    }
    thread.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));

    return ok(res, {
      lead:             lead.data,
      messages:         thread,
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
    applySmsConsent(patch, body);
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
    // portal/side logic stays correct; "do_not_contact" sets the status.
    if (body.contact_type !== undefined) {
      if (body.contact_type === null || body.contact_type === '') {
        patch.contact_type = null;
      } else if (!CONTACT_TYPES.has(body.contact_type)) {
        errors.push(`contact_type must be one of: ${[...CONTACT_TYPES].join(', ')}`);
      } else {
        patch.contact_type = body.contact_type;
        if (DEAL_SIDES.has(body.contact_type)) patch.deal_side = body.contact_type;
        if (body.contact_type === 'do_not_contact') patch.status = 'do_not_contact';
      }
    }
    // Side-aware pipeline status. Accept null/'' to clear the side.
    if (body.buyer_stage !== undefined) {
      if (body.buyer_stage === null || body.buyer_stage === '') patch.buyer_stage = null;
      else if (!BUYER_STAGES.has(body.buyer_stage)) errors.push(`buyer_stage must be one of: ${[...BUYER_STAGES].join(', ')}`);
      else patch.buyer_stage = body.buyer_stage;
    }
    if (body.seller_stage !== undefined) {
      if (body.seller_stage === null || body.seller_stage === '') patch.seller_stage = null;
      else if (!SELLER_STAGES.has(body.seller_stage)) errors.push(`seller_stage must be one of: ${[...SELLER_STAGES].join(', ')}`);
      else patch.seller_stage = body.seller_stage;
    }
    // Editable contact fields (manual "Update contact").
    if (typeof body.first_name === 'string') patch.first_name = body.first_name.trim() || null;
    if (typeof body.last_name === 'string')  patch.last_name  = body.last_name.trim() || null;
    if (typeof body.phone === 'string')      patch.phone      = body.phone.trim() || null;
    if (typeof body.email === 'string') {
      const em = body.email.trim().toLowerCase();
      if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) errors.push('email is not a valid address');
      else patch.email = em || null;
    }
    // Derive the coarse pipeline_stage (kanban + header) from the side stages /
    // category, unless the caller set pipeline_stage explicitly. Keeps status
    // and pipeline as one source of truth.
    if (patch.pipeline_stage === undefined) {
      const ct = patch.contact_type !== undefined ? patch.contact_type : undefined;
      const bs = patch.buyer_stage  !== undefined ? patch.buyer_stage  : undefined;
      const ss = patch.seller_stage !== undefined ? patch.seller_stage : undefined;
      if (ct !== undefined || bs !== undefined || ss !== undefined) {
        // Fill unspecified pieces from the existing row so the derivation is complete.
        const supaTmp = adminClient();
        const { data: cur } = await supaTmp.from('leads')
          .select('contact_type, buyer_stage, seller_stage').eq('id', id).maybeSingle();
        const derived = derivePipeline(
          ct !== undefined ? ct : cur?.contact_type,
          bs !== undefined ? bs : cur?.buyer_stage,
          ss !== undefined ? ss : cur?.seller_stage
        );
        if (derived) patch.pipeline_stage = derived;
      }
    }
    if (errors.length) return fail(res, 400, errors.join('; '));
    if (Object.keys(patch).length === 0) {
      return fail(res, 400, 'nothing to update');
    }

    const supa = adminClient();

    // 1. Fetch current state so we can compute and log the diff
    const { data: before, error: beforeErr } = await supa
      .from('leads').select('id, pipeline_stage, assigned_agent, sms_consent').eq('id', id).maybeSingle();
    if (beforeErr) return fail(res, 500, beforeErr.message);
    if (!before)   return fail(res, 404, 'lead not found');

    // 1b. SMS consent (A2P 10DLC, db/033): stamp when + source only when the
    // checkbox actually flips the recorded value, so unrelated contact edits
    // don't reset the consent date. Mirrors the source conventions used by
    // the STOP/START keyword handler (api/twilio/inbound.js) and the intake
    // forms (api/leads/intake.js, api/c/[token].js).
    if (patch.sms_consent !== undefined && patch.sms_consent !== before.sms_consent) {
      patch.sms_consent_at = new Date().toISOString();
      patch.sms_consent_source = patch.sms_consent
        ? 'Manually confirmed by agent'
        : 'Manually revoked by agent';
    }

    // 2. Apply the patch. If a not-yet-migrated column (contact_type / 022,
    //    buyer_stage|seller_stage / 023) is referenced before its migration
    //    runs, strip those optional columns and retry so name/phone/email/stage
    //    still save instead of the whole update hard-failing.
    patch.updated_at = new Date().toISOString();
    let { data: after, error: updErr } = await supa
      .from('leads').update(patch).eq('id', id).select().single();
    if (updErr && /(contact_type|buyer_stage|seller_stage).*(schema cache|does not exist|could not find)/i.test(updErr.message || '')) {
      const { contact_type, buyer_stage, seller_stage, ...safe } = patch;
      ({ data: after, error: updErr } = await supa.from('leads').update(safe).eq('id', id).select().single());
      if (!updErr) {
        return ok(res, { lead: after, warning: 'Saved, but the side/status columns are not migrated yet — run db/022_contact_type.sql and db/023_side_stages.sql in Supabase.' });
      }
    }
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
