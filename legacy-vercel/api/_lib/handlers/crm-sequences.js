// api/_lib/handlers/crm-sequences.js
// GET /api/crm/sequences
//
// Agent-only. Returns the drip sequences (from public.sequences) with derived,
// display-ready fields for the CRM Sequences tab: step count, duration, channel
// mix, reply rate, live enrolment count, and the per-step cadence for the editor
// pane. Read-only — enrolment/authoring live elsewhere (POST /api/sequences/enroll).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const cap = (s) => (s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const humanize = (name) => cap(String(name || '').replace(/[_-]+/g, ' ').trim());

// A sequence's display name: prefer the human prefix baked into the description
// ("New buyer · slow drip — 7 steps…"), else humanize the machine name.
function displayName(seq) {
  const d = seq.description || '';
  if (d.includes('—')) return d.split('—')[0].trim();
  if (d.includes(' - ')) return d.split(' - ')[0].trim();
  return humanize(seq.name);
}

function channelsLabel(steps) {
  const set = new Set(steps.map((s) => (s.channel || '').toLowerCase()).filter(Boolean));
  if (set.has('email') && set.has('sms')) return 'Email + SMS';
  if (set.has('sms')) return 'SMS';
  return 'Email';
}

function whenLabel(h) {
  const hours = Number(h) || 0;
  if (hours <= 0) return 'Immediately';
  if (hours < 24) return `${hours}h after enroll`;
  return `Day ${Math.round(hours / 24)}`;
}

function replyRatePct(rr) {
  const n = Number(rr) || 0;
  if (n <= 0) return null;                 // no reply data yet → UI shows "—"
  return Math.round(n <= 1 ? n * 100 : n); // stored as fraction OR percent
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const supa = adminClient();

    const { data: rows, error } = await supa
      .from('sequences')
      .select('id, name, description, trigger_type, steps, active, reply_rate, created_at')
      .order('created_at', { ascending: true });
    if (error) return fail(res, 500, `sequences: ${error.message}`);

    // Live enrolment counts — one query, tallied in code (active, not paused).
    const enrolled = {};
    const { data: leadRows } = await supa
      .from('leads')
      .select('sequence_id')
      .not('sequence_id', 'is', null)
      .eq('status', 'active')
      .eq('sequence_paused', false);
    (leadRows || []).forEach((l) => { enrolled[l.sequence_id] = (enrolled[l.sequence_id] || 0) + 1; });

    const sequences = (rows || []).map((seq) => {
      const steps = Array.isArray(seq.steps) ? seq.steps : [];
      const maxDelay = steps.reduce((m, s) => Math.max(m, Number(s.delay_hours) || 0), 0);
      return {
        id:            seq.id,
        name:          displayName(seq),
        raw_name:      seq.name,
        description:   seq.description || '',
        trigger_type: seq.trigger_type || null,
        active:        seq.active !== false,
        step_count:    steps.length,
        duration_days: Math.max(1, Math.round(maxDelay / 24)),
        channels:      channelsLabel(steps),
        reply_rate:    replyRatePct(seq.reply_rate),
        enrolled:      enrolled[seq.id] || 0,
        steps: steps
          .slice()
          .sort((a, b) => (Number(a.step_number) || 0) - (Number(b.step_number) || 0))
          .map((s) => ({
            step_number: Number(s.step_number) || 0,
            when:        whenLabel(s.delay_hours),
            channel:     (s.channel || 'email').toUpperCase(),
            subject:     s.subject_template || null,
            body:        s.body_template || ''
          }))
      };
    });

    return ok(res, { sequences });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
