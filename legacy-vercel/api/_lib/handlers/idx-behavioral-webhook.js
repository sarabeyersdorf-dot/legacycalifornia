// api/_lib/handlers/idx-behavioral-webhook.js
// POST /api/idx/behavioral-webhook
//
// Receives behavioural events from iHomefinder (IDX). Because iHomefinder's
// webhook payload shape varies a bit by event type, this handler normalises
// the common fields and accepts a few aliases.
//
// What it does:
//   1. Normalise the incoming event into {email, first_name, last_name,
//      phone, event_type, property, search_criteria}.
//   2. Find the matching lead by email (create one if missing — many IDX
//      events come before the lead has filled a form).
//   3. Insert a row into lead_events with source='ihomefinder_idx'.
//   4. Re-score the lead via scoreLead().
//   5. If the new score crosses 75 (was below, now ≥ 75), draft a hot-lead
//      SMS via direct Anthropic (claude-sonnet-4-6) and save it to messages
//      as status='pending_approval'. NEVER auto-sends.
//
// Auth: optional shared secret via IHOMEFINDER_WEBHOOK_SECRET. iHomefinder
// supports custom headers in their webhook configuration.

import { adminClient }       from '../supabase.js';
import { scoreLead }         from './ai-score-lead.js';
import { anthropicJSON }     from '../anthropic.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

// iHomefinder event names → our lead_events.event_type values
const EVENT_MAP = {
  'property_view':       'property_viewed',
  'property_viewed':     'property_viewed',
  'listing_view':        'property_viewed',
  'property_save':       'property_saved',
  'property_saved':      'property_saved',
  'favorite':            'property_saved',
  'listing_favorite':    'property_saved',
  'search':              'search_run',
  'search_run':          'search_run',
  'saved_search':        'search_run',
  'lead_capture':        'form_submitted',
  'contact_us':          'form_submitted',
  'showing_request':     'form_submitted',
  'register':            'form_submitted'
};

function pickEmail(p) {
  return (
    p.email || p.contact_email || p.lead_email ||
    p?.contact?.email || p?.lead?.email || p?.user?.email || null
  );
}
function pickFirst(p) {
  return (
    p.first_name || p.firstName ||
    p?.contact?.first_name || p?.contact?.firstName ||
    p?.lead?.first_name    || p?.lead?.firstName    || null
  );
}
function pickLast(p) {
  return (
    p.last_name || p.lastName ||
    p?.contact?.last_name || p?.contact?.lastName ||
    p?.lead?.last_name    || p?.lead?.lastName    || null
  );
}
function pickPhone(p) {
  return p.phone || p?.contact?.phone || p?.lead?.phone || null;
}
function pickEventType(p) {
  const raw = (p.event_type || p.eventType || p.event || p.type || '').toString().toLowerCase();
  return EVENT_MAP[raw] || null;
}
function pickProperty(p) {
  const prop = p.property || p.listing || p.subject || null;
  if (!prop) return null;
  return {
    mls_number: prop.mls_number || prop.mlsNumber || prop.mls || null,
    address:    prop.address    || prop.streetAddress || null,
    city:       prop.city       || null,
    price:      prop.price      || prop.list_price || null,
    sq_ft:      prop.sq_ft      || prop.squareFeet || null
  };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  // Optional shared-secret gate
  const expected = process.env.IHOMEFINDER_WEBHOOK_SECRET;
  if (expected) {
    const url    = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const qs     = url.searchParams.get('secret');
    const header = req.headers['x-ihomefinder-secret'] || req.headers['x-webhook-secret'] || '';
    if (qs !== expected && header !== expected) {
      return fail(res, 401, 'webhook secret invalid');
    }
  }

  try {
    const payload = await readJson(req);
    if (!payload || typeof payload !== 'object') return fail(res, 400, 'empty payload');

    const email      = (pickEmail(payload) || '').toLowerCase().trim();
    const first_name = pickFirst(payload);
    const last_name  = pickLast(payload);
    const phone      = pickPhone(payload);
    const event_type = pickEventType(payload);
    const property   = pickProperty(payload);

    if (!email)      return fail(res, 400, 'no contact email in payload');
    if (!event_type) return fail(res, 400, `unknown or missing event type: ${payload.event_type || payload.event || ''}`);

    const supa = adminClient();

    // 1. Find or create the lead
    let { data: lead } = await supa.from('leads').select('*').eq('email', email).maybeSingle();

    if (!lead) {
      const { data: created, error: createErr } = await supa.from('leads').insert({
        first_name:    first_name || null,
        last_name:     last_name  || null,
        email,
        phone:         phone || null,
        source:        'ihomefinder_idx',
        journey_stage: 'discovering',
        lead_type:     'buyer',
        temperature:   'new',
        score:         0,
        assigned_agent:'sara',
        pipeline_stage:'new',
        status:        'active'
      }).select().single();
      if (createErr) return fail(res, 500, `lead insert: ${createErr.message}`);
      lead = created;
    } else if (first_name || last_name || phone) {
      // Fill in any blanks iHomefinder now has for us
      const patch = {};
      if (first_name && !lead.first_name) patch.first_name = first_name;
      if (last_name  && !lead.last_name)  patch.last_name  = last_name;
      if (phone      && !lead.phone)      patch.phone      = phone;
      if (Object.keys(patch).length) {
        await supa.from('leads').update(patch).eq('id', lead.id);
      }
    }

    const oldScore = lead.score || 0;

    // 2. Insert the event
    const eventData = {
      ...(property ? { property } : {}),
      ...(payload.search_criteria || payload.searchCriteria ? { search: payload.search_criteria || payload.searchCriteria } : {}),
      ihomefinder_raw_event: payload.event || payload.eventType || payload.event_type || null,
      ihomefinder_timestamp: payload.timestamp || payload.occurred_at || null
    };
    await supa.from('lead_events').insert({
      lead_id:    lead.id,
      event_type,
      event_data: eventData,
      source:     'ihomefinder_idx'
    });

    // 3. Re-score
    const { score: newScore, temperature, breakdown } = await scoreLead(lead.id);

    // 4. Hot-lead nudge — only the first time we cross 75
    let draft = null;
    if (oldScore < 75 && newScore >= 75) {
      try {
        const userPrompt = `Draft a short SMS (<160 chars) from Sara Cooper to a lead who just crossed the hot-lead threshold (score ${oldScore} → ${newScore}).

Lead:
  name:        ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '(unknown name)'}
  email:       ${lead.email}
  phone:       ${lead.phone || '(none on file)'}
  journey:     ${lead.journey_stage || 'unknown'}
  areas:       ${(lead.areas || []).join(', ') || 'unspecified'}
  price_range: ${lead.price_min || '?'}-${lead.price_max || '?'}
  what triggered the change: ${event_type}${property ? ` on ${property.address || property.mls_number}` : ''}

Sara voice rules: warm, direct, never salesy. No exclamation points. No filler.
1. Sara's phone is 209-559-4966. Use the actual number. Never a placeholder.
2. Do not repeat the same idea twice.
3. If their first name is "Sara", open with "Hi," instead of "Hey Sara".
4. End with one specific next step (a question, a time, or a property to look at).

Respond in JSON only: { "sms": "...", "reasoning": "one sentence" }`;

        const { json: ai } = await anthropicJSON({
          system:     'You write SMS drafts in Sara Cooper\'s voice for Legacy Properties.',
          messages:   [{ role: 'user', content: userPrompt }],
          max_tokens: 350,
          temperature: 0.7
        });

        const body = (ai.sms || '').trim();
        if (body) {
          const { data: row } = await supa.from('messages').insert({
            lead_id:            lead.id,
            direction:          'outbound',
            channel:            'sms',
            body,
            subject:            null,
            status:             'pending_approval',
            ai_generated:       true,
            ai_draft_reasoning: `Hot-lead nudge (score ${oldScore}→${newScore}). ${(ai.reasoning || '').trim()}`
          }).select().single();
          draft = row || null;
        }
      } catch (e) {
        // Score change still persisted even if the draft fails.
        draft = { error: e.message };
      }
    }

    return ok(res, {
      lead_id:       lead.id,
      event_type,
      score:         { old: oldScore, new: newScore, breakdown },
      temperature,
      draft
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
