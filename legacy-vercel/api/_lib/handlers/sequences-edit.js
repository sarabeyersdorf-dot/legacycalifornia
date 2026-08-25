// api/_lib/handlers/sequences-edit.js
// GET  /api/sequences/edit?sequence_name=expired_listing
//        → the raw, editable steps of a sequence (subject/body templates, timing).
// POST /api/sequences/edit   { sequence_name, steps:[{ step_number, subject_template,
//        body_template, preview_text }], description? }
//        → save the edited copy. Merges by step_number so ONLY the copy fields are
//          overwritten — channel, delay_hours, and any other step field are preserved.
//
// Powers the CRM sequence editor. Agent-only. The `sequences` table is DB-owned
// (seeded by migration, never touched by the deals.json sync), so edits are durable.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const supa = adminClient();

    // ── Load the raw steps for editing ─────────────────────────────
    if (req.method === 'GET') {
      const name = String((req.query && req.query.sequence_name) || 'expired_listing').trim();
      const { data: seq, error } = await supa
        .from('sequences').select('id, name, description, steps, send_mode').eq('name', name).maybeSingle();
      if (error) return fail(res, 500, error.message);
      if (!seq)  return fail(res, 404, 'sequence not found: ' + name);

      const steps = (Array.isArray(seq.steps) ? seq.steps.slice() : [])
        .sort((a, b) => (a.step_number || 0) - (b.step_number || 0))
        .map((s) => ({
          step_number:      s.step_number,
          channel:          s.channel || 'email',
          delay_hours:      s.delay_hours || 0,
          subject_template: s.subject_template || '',
          body_template:    s.body_template || '',
          preview_text:     s.preview_text || ''
        }));

      return ok(res, {
        sequence:    seq.name,
        description: seq.description || '',
        send_mode:   seq.send_mode || 'draft',
        steps
      });
    }

    // ── Save edited copy ───────────────────────────────────────────
    if (req.method === 'POST') {
      const b = await readJson(req);
      const name = String(b.sequence_name || '').trim();
      if (!name)                                        return fail(res, 400, 'sequence_name required');
      if (!Array.isArray(b.steps) || !b.steps.length)   return fail(res, 400, 'steps required');

      const { data: seq, error: e0 } = await supa
        .from('sequences').select('id, steps').eq('name', name).maybeSingle();
      if (e0)   return fail(res, 500, e0.message);
      if (!seq) return fail(res, 404, 'sequence not found: ' + name);

      // Merge onto the stored steps by step_number: overwrite only the copy
      // fields, never the timing/channel. Unknown step numbers are ignored.
      const existing = Array.isArray(seq.steps) ? seq.steps.map((s) => ({ ...s })) : [];
      const byNum = new Map(existing.map((s) => [Number(s.step_number), s]));
      let touched = 0;
      for (const s of b.steps) {
        const n = Number(s.step_number);
        if (!byNum.has(n)) continue;
        const cur = byNum.get(n);
        if (typeof s.subject_template === 'string') { cur.subject_template = s.subject_template; touched++; }
        if (typeof s.body_template === 'string')    { cur.body_template = s.body_template; }
        if (typeof s.preview_text === 'string')     { cur.preview_text = s.preview_text; }
      }
      const merged = Array.from(byNum.values()).sort((a, c) => (a.step_number || 0) - (c.step_number || 0));

      const patch = { steps: merged };
      if (typeof b.description === 'string' && b.description.trim()) patch.description = b.description.trim();

      const { error: e1 } = await supa.from('sequences').update(patch).eq('id', seq.id);
      if (e1) return fail(res, 500, e1.message);

      return ok(res, { saved: true, steps_updated: touched, steps: merged });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
