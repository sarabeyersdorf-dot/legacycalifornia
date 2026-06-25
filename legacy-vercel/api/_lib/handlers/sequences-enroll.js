// api/_lib/handlers/sequences-enroll.js
// POST /api/sequences/enroll
//
// Body: { lead_id, sequence_name?, trigger_type? }
//   * Either sequence_name OR trigger_type must be provided.
//   * If sequence_name matches an existing public.sequences row, that one
//     is used. Otherwise we pick the first active sequence whose trigger_type
//     matches the body.
//
// Effects:
//   - leads.sequence_id            = sequence.id
//   - leads.sequence_step          = 0     (no steps fired yet)
//   - leads.sequence_paused        = false
//   - leads.sequence_next_due_at   = now() + steps[0].delay_hours
//
// We DO NOT touch last_contact_at here — that field tracks real outbound
// sends, not enrollment.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    // Agent-only — only Sara/James/admin can enroll a lead in a sequence.
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)            return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const { lead_id, sequence_name, trigger_type } = await readJson(req);
    if (!lead_id) return fail(res, 400, 'lead_id required');
    if (!sequence_name && !trigger_type) {
      return fail(res, 400, 'sequence_name or trigger_type required');
    }

    const supa = adminClient();

    // 1. Lead must exist and be active
    const { data: lead, error: leadErr } = await supa
      .from('leads').select('id, status').eq('id', lead_id).maybeSingle();
    if (leadErr) return fail(res, 500, leadErr.message);
    if (!lead)   return fail(res, 404, 'lead not found');
    if (lead.status !== 'active') return fail(res, 409, 'lead is not active');

    // 2. Resolve the sequence
    let q = supa.from('sequences').select('id, name, trigger_type, steps').eq('active', true).limit(1);
    if (sequence_name) q = q.eq('name', sequence_name);
    else               q = q.eq('trigger_type', trigger_type);
    const { data: seq, error: seqErr } = await q.maybeSingle();
    if (seqErr) return fail(res, 500, seqErr.message);
    if (!seq)   return fail(res, 404, 'no matching sequence');

    const steps = Array.isArray(seq.steps) ? seq.steps : [];
    if (!steps.length) return fail(res, 422, 'sequence has no steps');

    // 3. Schedule step 0
    const firstDelayHours = Number(steps[0].delay_hours) || 0;
    const nextDueAt = new Date(Date.now() + firstDelayHours * 3600_000).toISOString();

    const { error: upErr } = await supa.from('leads').update({
      sequence_id:          seq.id,
      sequence_step:        0,
      sequence_paused:      false,
      sequence_next_due_at: nextDueAt
    }).eq('id', lead_id);
    if (upErr) return fail(res, 500, upErr.message);

    // 4. Log a soft audit event (event_type must be in the schema CHECK list;
    //    score_change is the closest neutral fit and the morning brief
    //    already ignores it for scoring purposes).
    await supa.from('lead_events').insert({
      lead_id,
      event_type: 'score_change',
      source:     'manual',
      event_data: { sequence_enroll: true, sequence_id: seq.id, sequence_name: seq.name }
    });

    return ok(res, {
      enrolled: true,
      sequence: { id: seq.id, name: seq.name, total_steps: steps.length },
      next_due_at: nextDueAt
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
