// api/leads/intake.js
// Single endpoint that handles every lead capture form on the site:
//   - Homepage journey selector ("Save my place")
//   - "Find My Match" form on /platform.html
//   - "Message Sara" on /listings.html
//   - Tour booking on /listing.html  (also creates a tours row)
//   - Any future form — just POST to /api/leads/intake
//
// Body:
// {
//   first_name?, last_name?, email (required), phone?,
//   source?:        'website_form' | 'open_house' | 'referral' | 'ihomefinder_idx' | 'manual',
//   journey_stage?: 'discovering' | 'narrowing' | 'touring' | 'ready_to_offer',
//   lead_type?:     'buyer' | 'seller' | 'both' | 'land' | 'relocation',
//   areas?:         string[],
//   price_min?:     number,
//   price_max?:     number,
//   message?:       string,                       // free-text from the form
//   property_mls?:  string,                       // listing.html context
//   property_id?:   uuid,                         // saved properties context
//   tour?:          { scheduled_at, tour_type? }  // when intake is from tour booking
// }
//
// Returns: { success: true, lead_id, is_new }

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';
import { draftWelcome } from '../_lib/handlers/ai-welcome.js';
import { scoreLead }    from '../_lib/handlers/ai-score-lead.js';
import { syncLeadToFUB } from '../fub/sync.js';

const ALLOWED_SOURCE  = new Set(['website_form','open_house','referral','ihomefinder_idx','manual']);
const ALLOWED_JOURNEY = new Set(['discovering','narrowing','touring','ready_to_offer']);
const ALLOWED_TYPE    = new Set(['buyer','seller','both','land','relocation']);

// Bots fill hidden fields a human never sees. Add one of these as a hidden,
// visually-offscreen input to each form; a filled value = a bot.
const HONEYPOT_FIELDS = ['company','website','url','fax'];

// Per-IP / per-email velocity guard. Fail-OPEN: if the intake_hits table isn't
// there yet or the DB hiccups, we never block a real lead.
async function rateLimited(supa, ip, email) {
  try {
    const since = new Date(Date.now() - 3600_000).toISOString();
    if (ip) {
      const { count } = await supa.from('intake_hits').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since);
      if ((count || 0) >= 12) return true;
    }
    if (email) {
      const { count } = await supa.from('intake_hits').select('id', { count: 'exact', head: true }).eq('email', email).gte('created_at', since);
      if ((count || 0) >= 6) return true;
    }
    await supa.from('intake_hits').insert({ ip, email });
  } catch (_) { /* table missing / transient error → don't lose a real lead */ }
  return false;
}

function sanitize(body) {
  const out = {};
  out.first_name    = (body.first_name || '').trim() || null;
  out.last_name     = (body.last_name  || '').trim() || null;
  out.email         = (body.email      || '').trim().toLowerCase();
  out.phone         = (body.phone      || '').trim() || null;
  // Express SMS opt-in (A2P): only when the form checkbox was affirmatively
  // checked; we stamp when and where for the audit trail.
  if (body.sms_consent === true || body.sms_consent === 'on' || body.sms_consent === 'true') {
    out.sms_consent = true;
    out.sms_consent_at = new Date().toISOString();
    out.sms_consent_source = ((body.source || 'website') + ' form').slice(0, 120);
  }
  out.source        = ALLOWED_SOURCE.has(body.source)         ? body.source        : 'website_form';
  out.journey_stage = ALLOWED_JOURNEY.has(body.journey_stage) ? body.journey_stage : null;
  out.lead_type     = ALLOWED_TYPE.has(body.lead_type)        ? body.lead_type     : null;
  out.areas         = Array.isArray(body.areas) ? body.areas.filter(s => typeof s === 'string').slice(0, 20) : null;
  out.price_min     = Number.isFinite(+body.price_min) ? Math.max(0, +body.price_min) : null;
  out.price_max     = Number.isFinite(+body.price_max) ? Math.max(0, +body.price_max) : null;
  out.notes         = (body.message    || '').trim() || null;
  return out;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const body = await readJson(req);

    // Honeypot — silently accept so the bot doesn't learn, but create nothing.
    for (const f of HONEYPOT_FIELDS) {
      if (body[f] && String(body[f]).trim()) return ok(res, { lead_id: null, is_new: false, ignored: true });
    }

    const fields = sanitize(body);

    if (!fields.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email)) {
      return fail(res, 400, 'valid email required');
    }

    const supa = adminClient();

    // Velocity guard (fail-open)
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    if (await rateLimited(supa, ip, fields.email)) {
      return fail(res, 429, 'too many submissions — please try again in a little while');
    }

    // Upsert by email
    const { data: existing } = await supa
      .from('leads').select('*').eq('email', fields.email).maybeSingle();

    let lead, is_new;
    if (existing) {
      // Merge: only fill blanks, never overwrite agent-curated fields like score/notes
      const patch = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v != null && v !== '' && !existing[k]) patch[k] = v;
      }
      // Journey stage can be re-stated (lead progressing)
      if (fields.journey_stage)   patch.journey_stage   = fields.journey_stage;
      if (fields.lead_type)       patch.lead_type       = fields.lead_type;
      patch.last_contact_at = new Date().toISOString();

      const { data, error } = await supa
        .from('leads').update(patch).eq('id', existing.id).select().single();
      if (error) return fail(res, 500, `leads update: ${error.message}`);
      lead = data; is_new = false;
    } else {
      const { data, error } = await supa
        .from('leads').insert({ ...fields, last_contact_at: new Date().toISOString() })
        .select().single();
      if (error) return fail(res, 500, `leads insert: ${error.message}`);
      lead = data; is_new = true;
    }

    // Record the form_submitted event
    await supa.from('lead_events').insert({
      lead_id:    lead.id,
      event_type: 'form_submitted',
      source:     'website',
      event_data: {
        is_new,
        journey_stage: fields.journey_stage,
        property_mls:  body.property_mls || null,
        property_id:   body.property_id  || null,
        message:       fields.notes
      }
    });

    // If this intake came from the tour booking on listing.html, create the tour row
    if (body.tour && body.tour.scheduled_at) {
      await supa.from('tours').insert({
        lead_id:      lead.id,
        property_id:  body.property_id || null,
        scheduled_at: body.tour.scheduled_at,
        tour_type:    body.tour.tour_type === 'video' ? 'video' : 'in_person',
        status:       'requested'
      });
      await supa.from('lead_events').insert({
        lead_id:    lead.id,
        event_type: 'tour_booked',
        source:     'website',
        event_data: { scheduled_at: body.tour.scheduled_at, property_id: body.property_id || null }
      });
    }

    // Fire-and-forget: AI welcome draft + score + FUB sync.
    // We await sequentially but swallow individual errors so the form never
    // appears broken to the lead.
    const sideEffects = {};
    try { sideEffects.ai_welcome = await draftWelcome(lead.id); }
    catch (e) { sideEffects.ai_welcome_error = e.message; }

    try { sideEffects.score = await scoreLead(lead.id); }
    catch (e) { sideEffects.score_error = e.message; }

    try { sideEffects.fub = await syncLeadToFUB(lead); }
    catch (e) { sideEffects.fub_error = e.message; }

    return ok(res, { lead_id: lead.id, is_new, side_effects: sideEffects });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
