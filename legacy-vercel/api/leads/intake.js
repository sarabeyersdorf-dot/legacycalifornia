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
import { draftWelcome } from '../ai/welcome.js';
import { scoreLead }    from '../ai/score-lead.js';
import { syncLeadToFUB } from '../fub/sync.js';

const ALLOWED_SOURCE  = new Set(['website_form','open_house','referral','ihomefinder_idx','manual']);
const ALLOWED_JOURNEY = new Set(['discovering','narrowing','touring','ready_to_offer']);
const ALLOWED_TYPE    = new Set(['buyer','seller','both','land','relocation']);

function sanitize(body) {
  const out = {};
  out.first_name    = (body.first_name || '').trim() || null;
  out.last_name     = (body.last_name  || '').trim() || null;
  out.email         = (body.email      || '').trim().toLowerCase();
  out.phone         = (body.phone      || '').trim() || null;
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
    const fields = sanitize(body);

    if (!fields.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email)) {
      return fail(res, 400, 'valid email required');
    }

    const supa = adminClient();

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
