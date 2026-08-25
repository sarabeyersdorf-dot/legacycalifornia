// api/_lib/handlers/sequences-status.js
// GET /api/sequences/status?sequence_name=expired_listing
//
// A live read-out of where a sequence batch stands, for the CRM "Batch status"
// panel. Computed entirely from the durable lead columns the cron maintains:
//   sequence_id            — set while enrolled, nulled when the lead finishes
//   sequence_step          — 0-based index of the NEXT step to send
//   sequence_autosend      — armed once Email 1 is approved (2..n auto-send)
//   sequence_paused        — halted (replied, or flagged for a manual fix)
//   sequence_next_due_at    — when the next step goes out
// Read-only. Agents only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const name = String((req.query && req.query.sequence_name) || 'expired_listing').trim();
    const supa = adminClient();

    const { data: seq, error: seqErr } = await supa
      .from('sequences').select('id, name, steps, send_mode').eq('name', name).maybeSingle();
    if (seqErr) return fail(res, 500, seqErr.message);
    if (!seq)   return fail(res, 404, 'sequence not found: ' + name);
    const seqId = seq.id;
    const totalSteps = Array.isArray(seq.steps) ? seq.steps.length : 0;

    // Leads still in the sequence (active + paused keep sequence_id; finished nulls it).
    const { data: leads = [], error: lErr } = await supa
      .from('leads')
      .select('id, first_name, last_name, email, sequence_step, sequence_autosend, sequence_paused, sequence_next_due_at')
      .eq('sequence_id', seqId)
      .limit(2000);
    if (lErr) return fail(res, 500, lErr.message);

    // Everyone ever enrolled (their sequence messages persist even after finishing).
    const { data: msgRows = [] } = await supa
      .from('messages').select('lead_id').eq('sequence_id', seqId).limit(20000);
    const enrolledEver = new Set((msgRows || []).map((m) => m.lead_id).filter(Boolean)).size;

    // Buckets.
    let awaitingApproval = 0, active = 0, paused = 0;
    const byNextEmail = {};          // { emailNumber: { count, earliest_due } }
    let soonest = null;              // { at, email_number }
    for (const l of leads) {
      if (l.sequence_paused) { paused++; continue; }
      if (!l.sequence_autosend) { awaitingApproval++; continue; }  // Email 1 held for approval
      active++;
      const nextEmail = (Number(l.sequence_step) || 0) + 1;        // step is 0-based → next email #
      const due = l.sequence_next_due_at || null;
      const b = byNextEmail[nextEmail] || (byNextEmail[nextEmail] = { email_number: nextEmail, count: 0, earliest_due: null });
      b.count++;
      if (due && (!b.earliest_due || due < b.earliest_due)) b.earliest_due = due;
      if (due && (!soonest || due < soonest.at)) soonest = { at: due, email_number: nextEmail };
    }

    // Finished = ever-enrolled who no longer hold a sequence_id (clamped ≥ 0).
    const stillIn = leads.length;
    const finished = Math.max(0, enrolledEver - stillIn);

    // Replied — best-effort: pause-on-reply is logged as a score_change event
    // carrying reason:'inbound_reply' and this sequence's id. Narrowed server-side.
    let replied = null;
    try {
      const { data: repl = [] } = await supa
        .from('lead_events')
        .select('lead_id')
        .eq('event_type', 'score_change')
        .filter('event_data->>reason', 'eq', 'inbound_reply')
        .filter('event_data->>sequence_id', 'eq', String(seqId))
        .limit(5000);
      replied = new Set((repl || []).map((r) => r.lead_id).filter(Boolean)).size;
    } catch (_) { replied = null; }

    const breakdown = Object.values(byNextEmail).sort((a, b) => a.email_number - b.email_number);

    return ok(res, {
      sequence: seq.name,
      total_steps: totalSteps,
      enrolled_ever: enrolledEver,
      awaiting_approval: awaitingApproval,
      active,
      paused,
      replied,                      // may be null if the lookup failed
      finished,
      next_send: soonest,           // { at, email_number } or null
      breakdown                     // [{ email_number, count, earliest_due }]
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
