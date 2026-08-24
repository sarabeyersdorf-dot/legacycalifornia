// api/_lib/handlers/sequences-enroll.js
// POST /api/sequences/enroll
//
// Body: { lead_id | lead_ids:[...], sequence_name?, trigger_type? }
//   * Either sequence_name OR trigger_type selects the sequence.
//   * lead_id enrolls one; lead_ids enrolls a batch (skip-traced lists arrive
//     as many leads at once).
//
// Per lead, sets:
//   sequence_id, sequence_step=0, sequence_paused=false, sequence_autosend=false,
//   sequence_started_at=now(), sequence_next_due_at = now()+steps[0].delay_hours
//
// Guards (never enroll a lead that would send a broken email):
//   * lead must exist and be 'active'
//   * lead must have an email (can't run an email sequence without one)
//   * for a LITERAL (verbatim) sequence, lead must have property_address —
//     the required merge field. Missing → skipped + reported, not enrolled.
//
// started_at anchors ABSOLUTE pacing in the cron, so delays are hours from
// enrollment (Day 0 / 3.5 / 7 / 13), not compounding step-to-step.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

// Merge-field fill for the immediate first-email draft (see enrollLeads). Kept
// in sync with sequences-cron.js — same {{token}} contract.
const SHOWCASE_URL = (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.com')
  .replace(/\/+$/, '') + '/showcase';
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}
function mergeVars(lead) {
  return {
    first_name:       lead.first_name || '',
    greeting:         lead.first_name ? `Hi ${lead.first_name},` : 'Hi,',
    property_address: lead.property_address || '',
    city:             lead.property_city || '',
    CASE_STUDY_URL:   SHOWCASE_URL
  };
}

export async function enrollLeads(supa, { leadIds, sequence_name, trigger_type }) {
  // Resolve the sequence.
  let q = supa.from('sequences').select('id, name, trigger_type, steps, send_mode').eq('active', true).limit(1);
  if (sequence_name) q = q.eq('name', sequence_name);
  else               q = q.eq('trigger_type', trigger_type);
  const { data: seq, error: seqErr } = await q.maybeSingle();
  if (seqErr) throw new Error(seqErr.message);
  if (!seq)   return { error: 'no matching sequence' };

  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  if (!steps.length) return { error: 'sequence has no steps' };
  const isLiteral = steps.some((s) => s && s.mode === 'literal');
  const firstDelayHours = Number(steps[0].delay_hours) || 0;

  const ids = [...new Set((leadIds || []).filter(Boolean))];
  const { data: leads = [] } = await supa
    .from('leads').select('id, status, email, first_name, property_address, property_city').in('id', ids);
  const byId = new Map(leads.map((l) => [l.id, l]));

  // First email (step 1) of a verbatim, send-now cold sequence is drafted
  // IMMEDIATELY on enrollment — not an hour later when the cron next runs — so
  // it lands on the agent's Today board the moment they enroll. Only the exact
  // shape the Expired sequence uses qualifies (literal copy, no delay, email);
  // anything AI-drafted or time-delayed is left to the cron as before.
  // Scoped to the Expired shape: auto_after_first + verbatim + no delay + email.
  // The null-next_due hold below then guarantees the cron never re-drafts it;
  // plain 'draft'-mode sequences (cron doesn't dedupe) are left to the cron.
  const step0 = steps[0];
  const draftStep0Now = !!(step0 && seq.send_mode === 'auto_after_first'
    && step0.mode === 'literal' && (Number(step0.delay_hours) || 0) === 0
    && step0.channel === 'email');

  const enrolled = [], skipped = [];
  for (const id of ids) {
    const lead = byId.get(id);
    if (!lead)                         { skipped.push({ id, reason: 'not found' }); continue; }
    if (lead.status !== 'active')      { skipped.push({ id, reason: 'not active' }); continue; }
    if (!lead.email)                   { skipped.push({ id, reason: 'no email' }); continue; }
    if (isLiteral && !String(lead.property_address || '').trim()) {
      skipped.push({ id, reason: 'missing property_address' }); continue;
    }
    const nowIso    = new Date().toISOString();
    const nextDueAt = new Date(Date.now() + firstDelayHours * 3600_000).toISOString();
    const { error: upErr } = await supa.from('leads').update({
      sequence_id:          seq.id,
      sequence_step:        0,
      sequence_paused:      false,
      sequence_autosend:    false,
      sequence_started_at:  nowIso,
      sequence_next_due_at: nextDueAt
    }).eq('id', id);
    if (upErr) { skipped.push({ id, reason: upErr.message }); continue; }
    await supa.from('lead_events').insert({
      lead_id: id, event_type: 'score_change', source: 'manual',
      event_data: { sequence_enroll: true, sequence_id: seq.id, sequence_name: seq.name }
    }).then(() => {}, () => {});

    // Draft Email 1 right now so it's approvable immediately (idempotent — never
    // create a second pending draft if one already exists for this lead+seq).
    if (draftStep0Now) {
      try {
        const { data: existingDraft } = await supa.from('messages')
          .select('id').eq('lead_id', id).eq('sequence_id', seq.id).eq('status', 'pending_approval').limit(1).maybeSingle();
        if (!existingDraft) {
          const vars    = mergeVars(lead);
          const subject = fillTemplate(step0.subject_template || '', vars);
          const body    = fillTemplate(step0.body_template || '', vars).trim();
          if (body) {
            await supa.from('messages').insert({
              lead_id: id, direction: 'outbound', channel: 'email', body, subject,
              status: 'pending_approval', ai_generated: false,
              ai_draft_reasoning: `Sequence "${seq.name}" step 1/${steps.length} (verbatim)`,
              sequence_id: seq.id
            });
            // Cold "approve first" sequence: hold step 1 for approval so the cron
            // doesn't draft a duplicate. crm-approve arms auto-send of 2..n.
            if (seq.send_mode === 'auto_after_first') {
              await supa.from('leads').update({ sequence_next_due_at: null }).eq('id', id);
            }
          }
        }
      } catch (_) { /* draft is best-effort; the cron will still pick it up */ }
    }
    enrolled.push(id);
  }

  return {
    sequence: { id: seq.id, name: seq.name, total_steps: steps.length, send_mode: seq.send_mode },
    enrolled, skipped
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = await readJson(req);
    const leadIds = b.lead_ids && Array.isArray(b.lead_ids) ? b.lead_ids
                  : (b.lead_id ? [b.lead_id] : []);
    if (!leadIds.length)               return fail(res, 400, 'lead_id or lead_ids required');
    if (!b.sequence_name && !b.trigger_type) return fail(res, 400, 'sequence_name or trigger_type required');

    const supa = adminClient();
    const result = await enrollLeads(supa, {
      leadIds, sequence_name: b.sequence_name, trigger_type: b.trigger_type
    });
    if (result.error) return fail(res, 404, result.error);

    return ok(res, {
      enrolled_count: result.enrolled.length,
      skipped_count:  result.skipped.length,
      ...result
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
