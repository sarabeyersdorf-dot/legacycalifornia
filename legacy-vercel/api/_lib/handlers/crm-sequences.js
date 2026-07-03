// api/_lib/handlers/crm-sequences.js
// /api/crm/sequences   (agent-only)
//   GET   → list drip sequences with derived, display-ready fields
//   POST  → create a sequence   { name, description?, trigger_type, steps[], active? }
//   PATCH → update a sequence    { id, ...any of the above }
//
// A sequence's `steps` is a jsonb array of
//   { step_number, delay_hours, channel('email'|'sms'), subject_template?, body_template }
// Enrolment/authoring of individual leads lives in POST /api/sequences/enroll.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const TRIGGERS = ['new_lead', 'open_house', 'price_drop', 'radio_silence', 'manual'];
const CHANNELS = ['email', 'sms'];

const cap = (s) => (s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const humanize = (name) => cap(String(name || '').replace(/[_-]+/g, ' ').trim());

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
  if (n <= 0) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}
function shapeSequence(seq, enrolledCount) {
  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  const maxDelay = steps.reduce((m, s) => Math.max(m, Number(s.delay_hours) || 0), 0);
  return {
    id: seq.id,
    name: displayName(seq),
    raw_name: seq.name,
    description: seq.description || '',
    trigger_type: seq.trigger_type || null,
    active: seq.active !== false,
    step_count: steps.length,
    duration_days: Math.max(1, Math.round(maxDelay / 24)),
    channels: channelsLabel(steps),
    reply_rate: replyRatePct(seq.reply_rate),
    enrolled: enrolledCount || 0,
    steps: steps
      .slice()
      .sort((a, b) => (Number(a.step_number) || 0) - (Number(b.step_number) || 0))
      .map((s) => ({
        step_number: Number(s.step_number) || 0,
        delay_hours: Number(s.delay_hours) || 0,
        when: whenLabel(s.delay_hours),
        channel: (s.channel || 'email').toUpperCase(),
        subject: s.subject_template || null,
        body: s.body_template || ''
      }))
  };
}

// Validate + normalise a steps array from the client into DB shape.
function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('at least one step is required');
  return raw.map((s, i) => {
    const channel = String(s.channel || 'email').toLowerCase();
    if (!CHANNELS.includes(channel)) throw new Error(`step ${i + 1}: channel must be email or sms`);
    const body = typeof s.body_template === 'string' ? s.body_template.trim() : '';
    if (!body) throw new Error(`step ${i + 1}: body is required`);
    const delay = Number(s.delay_hours);
    if (!Number.isFinite(delay) || delay < 0) throw new Error(`step ${i + 1}: delay_hours must be >= 0`);
    const subject = typeof s.subject_template === 'string' && s.subject_template.trim()
      ? s.subject_template.trim() : null;
    return { step_number: i + 1, delay_hours: Math.round(delay), channel, subject_template: subject, body_template: body };
  });
}

async function enrolledCountFor(supa, seqId) {
  const { count } = await supa.from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', seqId).eq('status', 'active').eq('sequence_paused', false);
  return count || 0;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    // ---- LIST ----------------------------------------------------------
    if (req.method === 'GET') {
      const { data: rows, error } = await supa
        .from('sequences')
        .select('id, name, description, trigger_type, steps, active, reply_rate, created_at')
        .order('created_at', { ascending: true });
      if (error) return fail(res, 500, `sequences: ${error.message}`);

      const enrolled = {};
      const { data: leadRows } = await supa.from('leads')
        .select('sequence_id').not('sequence_id', 'is', null)
        .eq('status', 'active').eq('sequence_paused', false);
      (leadRows || []).forEach((l) => { enrolled[l.sequence_id] = (enrolled[l.sequence_id] || 0) + 1; });

      return ok(res, { sequences: (rows || []).map((s) => shapeSequence(s, enrolled[s.id])) });
    }

    // ---- CREATE --------------------------------------------------------
    if (req.method === 'POST') {
      const body = await readJson(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const description = typeof body?.description === 'string' ? body.description.trim() : null;
      const trigger_type = String(body?.trigger_type || 'manual');
      const active = body?.active !== false;
      if (!name) return fail(res, 400, 'name is required');
      if (!TRIGGERS.includes(trigger_type)) return fail(res, 400, `trigger_type must be one of: ${TRIGGERS.join(', ')}`);
      const steps = normalizeSteps(body?.steps);

      const { data: created, error } = await supa.from('sequences')
        .insert({ name, description, trigger_type, steps, active })
        .select('*').single();
      if (error) return fail(res, 500, `create: ${error.message}`);
      return ok(res, { sequence: shapeSequence(created, 0) });
    }

    // ---- UPDATE --------------------------------------------------------
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!id) return fail(res, 400, 'id is required');

      const patch = {};
      if (typeof body.name === 'string')        patch.name = body.name.trim();
      if (typeof body.description === 'string')  patch.description = body.description.trim();
      if (body.trigger_type !== undefined) {
        if (!TRIGGERS.includes(String(body.trigger_type))) return fail(res, 400, `trigger_type must be one of: ${TRIGGERS.join(', ')}`);
        patch.trigger_type = String(body.trigger_type);
      }
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.steps !== undefined)  patch.steps = normalizeSteps(body.steps);
      if (!Object.keys(patch).length) return fail(res, 400, 'no updatable fields provided');

      const { data: updated, error } = await supa.from('sequences')
        .update(patch).eq('id', id).select('*').single();
      if (error) return fail(res, 500, `update: ${error.message}`);
      if (!updated) return fail(res, 404, 'sequence not found');
      return ok(res, { sequence: shapeSequence(updated, await enrolledCountFor(supa, id)) });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 400, e.message);
  }
}
