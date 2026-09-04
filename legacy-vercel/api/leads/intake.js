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
//   property_inquiry?: {                           // marketing attribution (e.g. 433 packet form)
//     property, utm_source?, utm_medium?, utm_campaign?, referrer?, landing_path?
//   }
// }
//
// Returns: { success: true, lead_id, is_new }

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';
import { draftWelcome } from '../_lib/handlers/ai-welcome.js';
import { scoreLead }    from '../_lib/handlers/ai-score-lead.js';
import { syncLeadToFUB } from '../fub/sync.js';
import { alertAgents, deskUrl } from '../_lib/agent-alert.js';
import { sendSpeedToLead } from '../_lib/handlers/speed-to-lead.js';
import { enrollLeads } from '../_lib/handlers/sequences-enroll.js';
import { sendEmail as sendEmailResend, resendConfigured } from '../_lib/resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from '../_lib/sendgrid.js';

const ALLOWED_SOURCE  = new Set(['website_form','open_house','referral','ihomefinder_idx','manual']);
const ALLOWED_JOURNEY = new Set(['discovering','narrowing','touring','ready_to_offer']);
const ALLOWED_TYPE    = new Set(['buyer','seller','both','land','relocation']);

// Bots fill hidden fields a human never sees. Add one of these as a hidden,
// visually-offscreen input to each form; a filled value = a bot.
const HONEYPOT_FIELDS = ['company','website','url','fax'];

// The team's ACTUAL working logins. When one of these submits a form we still
// record the lead (so end-to-end testing works) but we DON'T score it, draft it,
// enroll it in nurture, sync it to FUB, or alert the agents — otherwise the CRM
// scores staff as buyers and queues outreach addressed to the team itself
// (Bug 9: a staff address scored as a $500K buyer and drafted an SMS to itself).
//
// NOTE: this is the STAFF-MAILBOX list, not a "don't let us test" list. James
// deliberately tests the buyer journey from james@jamesbeyersdorf.com — that is
// a real test lead and must run the full pipeline, so his personal domain is NOT
// suppressed here. Only the real agent mailboxes are. To deliberately test from
// a staff address anyway, pass test_lead:true on the form submit (below).
const INTERNAL_ADDRESSES = new Set([
  'sarasellscalifornia@gmail.com',
  'jamessellscalifornia@gmail.com'
]);
const INTERNAL_DOMAINS = ['legacycalifornia.com'];
function isInternalAddress(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  if (INTERNAL_ADDRESSES.has(e)) return true;
  const domain = e.split('@')[1] || '';
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

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

    // Team address → tag it and hold back every downstream automation. An
    // explicit test_lead:true on the submit overrides this so a staff address can
    // be run through the FULL pipeline on purpose when we're testing.
    const internal = isInternalAddress(fields.email) && body.test_lead !== true;
    if (internal) fields.source = 'internal_test';

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
      // Merge on match: only fill fields that are genuinely EMPTY or NULL on the
      // stored record — NEVER overwrite a value already curated in the CRM. This
      // is the guarantee that a lead carefully saved as "Robert Ellison Jr.,
      // trustee" is not flattened to "bob" the night he types his name quickly
      // into a form: his stored name is non-empty, so the incoming value is
      // dropped. (Use an explicit blank test rather than !existing[k], so a
      // legitimate stored 0 / false is treated as present, not blank.)
      const isBlank = (x) => x === null || x === undefined || x === '';
      const patch = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v != null && v !== '' && isBlank(existing[k])) patch[k] = v;
      }
      // Journey stage / lead type are the ONE intentional exception: a returning
      // lead may have genuinely progressed (discovering → ready_to_offer), so a
      // freshly stated value updates. These are pipeline signals, not the curated
      // identity/contact fields the rule above protects.
      if (fields.journey_stage)   patch.journey_stage   = fields.journey_stage;
      if (fields.lead_type)       patch.lead_type       = fields.lead_type;
      patch.last_contact_at = new Date().toISOString();

      const { data, error } = await supa
        .from('leads').update(patch).eq('id', existing.id).select().single();
      if (error) return fail(res, 500, `leads update: ${error.message}`);
      lead = data; is_new = false;
    } else {
      // Sara: "send to both of us always." The alert already reached both, but
      // the follow-up lanes filter a non-broker to their own assigned leads, and
      // nothing here set the column — so every website lead defaulted to Sara and
      // James's day never showed one. 'both' (db/099) puts it on each list.
      const { data, error } = await supa
        .from('leads').insert({ ...fields, assigned_agent: 'both', last_contact_at: new Date().toISOString() })
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

    // Property inquiry (e.g. the 433 investor-packet form): store the marketing
    // ATTRIBUTION on its own row so we can tell which tagged link produced the
    // lead. Gated + fail-soft; mirrors the optional tour block above. Placed
    // before the internal-test return so an end-to-end test still writes the row.
    if (body.property_inquiry && typeof body.property_inquiry === 'object' && !Array.isArray(body.property_inquiry)) {
      const pi = body.property_inquiry;
      const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
      const piName    = clip([fields.first_name, fields.last_name].filter(Boolean).join(' ') || pi.name, 200);
      const propLabel = clip(pi.property, 160);

      // Store the attribution row. Fail-soft: attribution is additive, so a
      // write hiccup here must never block the lead.
      let inquiryStored = true;
      try {
        await supa.from('property_inquiries').insert({
          lead_id:      lead.id,
          property:     propLabel,
          name:         piName,
          email:        fields.email,
          phone:        fields.phone,
          message:      fields.notes,
          utm_source:   clip(pi.utm_source, 200),
          utm_medium:   clip(pi.utm_medium, 200),
          utm_campaign: clip(pi.utm_campaign, 200),
          referrer:     clip(pi.referrer, 600),
          landing_path: clip(pi.landing_path, 600)
        });
      } catch (_) { inquiryStored = false; }

      // Notify Sara on EVERY inquiry — directly, here, not through the general
      // agent alert below. That alert is deliberately suppressed for staff
      // addresses (scoring/drafting to ourselves), which is exactly why the two
      // Aug 22–23 staff test submissions landed in the table silently. A packet
      // request on a $1.4M listing is too important to depend on that path, so
      // this fires for every inquiry, staff or not. LOUD on failure: the row is
      // already saved above; if the email can't send we log it AND drop a
      // `notification_failed` lead_event so the miss is visible in the CRM,
      // never silently swallowed.
      try {
        const emailProvider = resendConfigured() ? sendEmailResend
          : (sendgridConfigured() ? sendEmailSendgrid : null);
        if (!emailProvider) throw new Error('no email provider configured (RESEND_API_KEY / SENDGRID_API_KEY both unset)');
        const who = piName || fields.email;
        const subject = `New property inquiry — ${who}${propLabel ? ' · ' + propLabel : ''}`;
        const text =
            `A new investor-packet / property inquiry just came in on legacycalifornia.com.\n\n`
          + `Name:     ${who}\n`
          + `Email:    ${fields.email}\n`
          + `Phone:    ${fields.phone || '(none)'}\n`
          + `Property: ${propLabel || '(unspecified)'}\n`
          + `Source:   ${clip(pi.utm_source, 200) || '(none)'}\n`
          + (fields.notes ? `Message:  ${fields.notes}\n` : '')
          + `\nOpen this lead in the CRM: ${deskUrl(lead.id)}`;
        await emailProvider({ agent: 'sara', to: 'sarasellscalifornia@gmail.com', toName: 'Sara Cooper', subject, text });
      } catch (notifyErr) {
        const msg = (notifyErr && notifyErr.message) || String(notifyErr);
        console.error('[property_inquiry] notification to Sara FAILED:', msg);
        try {
          await supa.from('lead_events').insert({
            lead_id:    lead.id,
            event_type: 'notification_failed',
            source:     'system',
            event_data: { kind: 'property_inquiry_email', to: 'sarasellscalifornia@gmail.com', error: msg, inquiry_stored: inquiryStored }
          });
        } catch (_) { /* console.error above is the last-resort record */ }
      }
    }

    // Internal test submissions record the lead and its event (so the pipeline
    // is verified end to end) but skip scoring, drafting, FUB sync, and the
    // agent alert entirely.
    if (internal) {
      return ok(res, { lead_id: lead.id, is_new, internal_test: true, side_effects: { skipped: 'internal address' } });
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

    // Alert BOTH agents (SMS + email) — a form submit / search setup / tour is
    // always high-signal, so it pings immediately. Awaited (fail-soft) so the
    // work isn't cut off after the response, but never blocks a real lead.
    try {
      const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || fields.email;
      const action = (body.tour && body.tour.scheduled_at) ? 'requested a tour'
        : fields.notes ? 'sent a message'
        : (fields.journey_stage === 'ready_to_offer') ? 'is ready to make an offer'
        : 'submitted a form / set up a search';
      const bits = [];
      if (fields.lead_type) bits.push(fields.lead_type);
      if (fields.areas && fields.areas.length) bits.push('areas: ' + fields.areas.join(', '));
      if (fields.price_min || fields.price_max) bits.push('budget: ' + (fields.price_min ? '$' + fields.price_min : '?') + '–' + (fields.price_max ? '$' + fields.price_max : '?'));
      if (fields.phone) bits.push(fields.phone);
      // Surface which listing + tagged campaign an inquiry came from, so the alert
      // itself answers "which link produced this lead".
      if (body.property_inquiry && body.property_inquiry.property) {
        bits.push('re: ' + String(body.property_inquiry.property));
        const camp = [body.property_inquiry.utm_source, body.property_inquiry.utm_campaign].filter(Boolean).join(' / ');
        if (camp) bits.push('via ' + camp);
      }
      const desk = deskUrl(lead.id);
      const sms = `New ${is_new ? '' : 'returning '}lead: ${name} ${action}${bits.length ? ' — ' + bits.join(' · ') : ''}. Open lead: ${desk}`;
      const text = `${name} ${action} on legacycalifornia.com.\n\n`
        + `Email: ${fields.email}\nPhone: ${fields.phone || '(none)'}\n`
        + `Type: ${fields.lead_type || '—'}\nJourney: ${fields.journey_stage || '—'}\n`
        + `Areas: ${(fields.areas || []).join(', ') || '—'}\nBudget: ${fields.price_min || '?'}–${fields.price_max || '?'}\n`
        + (fields.notes ? `Message: ${fields.notes}\n` : '')
        + `\nOpen this lead in the CRM: ${desk}`;
      sideEffects.agent_alert = await alertAgents(supa, { subject: `New website lead — ${name}`, sms, text });
    } catch (e) { sideEffects.agent_alert_error = e.message; }

    // Speed to Lead: instant, human-sounding auto-reply to the lead themselves so
    // no inquiry sits unanswered while Sara or James follows up personally. Once
    // per lead, never to a staff/opted-out address; fully fail-soft.
    try { sideEffects.speed_to_lead = await sendSpeedToLead(supa, lead); }
    catch (e) { sideEffects.speed_to_lead_error = e.message; }

    // Auto-enroll by type into the matching nurture drip. Only for a BRAND-NEW
    // lead that isn't already in a sequence — so we never yank a lead out of the
    // Expired drip (or an existing drip) or re-drip an existing contact. Email 1
    // drafts and waits for approval; 2-4 auto-send and stop on any reply.
    if (is_new && !lead.email_opt_out && !lead.sequence_id) {
      try {
        const seqName = fields.lead_type === 'buyer'  ? 'buyer_nurture'
                      : fields.lead_type === 'seller' ? 'seller_nurture'
                      : 'new_lead_nurture';   // both / land / relocation / unknown
        sideEffects.nurture_enroll = await enrollLeads(supa, { leadIds: [lead.id], sequence_name: seqName });
      } catch (e) { sideEffects.nurture_enroll_error = e.message; }
    }

    return ok(res, { lead_id: lead.id, is_new, side_effects: sideEffects });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
