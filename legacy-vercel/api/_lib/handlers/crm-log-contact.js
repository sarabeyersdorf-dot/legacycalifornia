// api/_lib/handlers/crm-log-contact.js
// POST /api/crm/log-contact  { lead_id, note? }
//
// "I already reached out." The morning brief's "gone quiet 14+ days" card only
// clears when something bumps leads.last_contact_at — but a phone call made
// outside the CRM never does, so the alert nags about contact that already
// happened (and about DNC leads we'd never text). This records the contact:
// it stamps last_contact_at = now() so the lead drops off the next brief, and
// optionally leaves a short lead_notes trail so the dismissal is auditable.
// Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);
    const lead_id = body?.lead_id;
    if (!lead_id) return fail(res, 400, 'lead_id required');

    const supa = adminClient();
    const { data: lead, error: leadErr } = await supa
      .from('leads').select('id').eq('id', lead_id).maybeSingle();
    if (leadErr) return fail(res, 500, leadErr.message);
    if (!lead)   return fail(res, 404, 'lead not found');

    const nowIso = new Date().toISOString();
    const { error: upErr } = await supa.from('leads')
      .update({ last_contact_at: nowIso }).eq('id', lead_id);
    if (upErr) return fail(res, 500, upErr.message);

    // Optional audit trail so a dismissed nudge isn't a silent reset. Fail-soft.
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (note) {
      await supa.from('lead_notes').insert({
        lead_id, body: note.slice(0, 2000), is_internal: true, created_by: user.id
      }).then(() => {}, () => {});
    }

    return ok(res, { logged: true, last_contact_at: nowIso });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
