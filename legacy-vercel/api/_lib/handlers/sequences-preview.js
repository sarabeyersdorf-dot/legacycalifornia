// api/_lib/handlers/sequences-preview.js
// GET/POST /api/sequences/preview?sequence_name=expired_listing
//
// Renders EVERY step of a sequence exactly as the recipient will see it — the
// branded email HTML (coldEmailHtml), the subject, the send timing, and whether
// each step needs approval or auto-sends. Read-only (no DB writes, no send), so
// an agent can review the whole sequence before enrolling anyone.
//
// Merge fields default to a neutral sample (nameless lead → greeting "Hi,"), or
// can be supplied ({first_name, property_address, city}) to preview a real row.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { coldEmailHtml } from '../email-html.js';

// Same stable showcase link the cron uses for {{CASE_STUDY_URL}}.
const SHOWCASE_URL = (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.com')
  .replace(/\/+$/, '') + '/showcase';

// Mirror of the cron's fillTemplate — keep in sync with sequences-cron.js.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

// "Day 0", "Day 3.5", "Day 7", "Day 13" from delay_hours.
function whenLabel(hours) {
  const h = Number(hours) || 0;
  if (h === 0) return 'Day 0 · sends as soon as you approve';
  const d = Math.round((h / 24) * 10) / 10;
  return 'Day ' + d + ' · ' + h + 'h after enrollment';
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = (req.method === 'POST') ? await readJson(req) : {};
    const name = (b.sequence_name || (req.query && req.query.sequence_name) || 'expired_listing').trim();

    const supa = adminClient();
    const { data: seq, error } = await supa
      .from('sequences').select('id, name, description, steps, send_mode').eq('name', name).maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!seq)  return fail(res, 404, 'sequence not found: ' + name);

    const steps = Array.isArray(seq.steps)
      ? seq.steps.slice().sort((a, c) => (a.step_number || 0) - (c.step_number || 0))
      : [];

    // Sample (or provided) merge fields. A nameless skip-traced lead opens "Hi,".
    const firstName = (typeof b.first_name === 'string') ? b.first_name.trim() : '';
    const vars = {
      first_name:       firstName,
      greeting:         firstName ? `Hi ${firstName},` : 'Hi,',
      property_address: (b.property_address && String(b.property_address).trim()) || '1234 Example Street',
      city:             (b.city && String(b.city).trim()) || 'Murphys',
      CASE_STUDY_URL:   SHOWCASE_URL
    };

    const autoAfterFirst = seq.send_mode === 'auto_after_first';

    const rendered = steps.map((step, idx) => {
      const subject = fillTemplate(step.subject_template || '', vars);
      const body    = fillTemplate(step.body_template || '', vars).trim();
      const html    = step.channel === 'email' ? coldEmailHtml(body, 'preview') : null;
      const auto    = autoAfterFirst ? idx >= 1 : false;
      return {
        step_number:   step.step_number || (idx + 1),
        channel:       step.channel || 'email',
        when:          whenLabel(step.delay_hours),
        needs_approval: !auto,
        auto,
        subject,
        preview_text:  step.preview_text || '',
        html
      };
    });

    return ok(res, {
      sequence:  seq.name,
      description: seq.description || '',
      send_mode: seq.send_mode || 'draft',
      sample:    vars,
      steps:     rendered
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
