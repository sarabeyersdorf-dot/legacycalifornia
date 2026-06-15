// api/ai/welcome.js
// Drafts a welcome SMS + email for a brand-new lead in Sara Cooper's voice.
// Saves both drafts to the messages table as status: 'pending_approval'.
// Does NOT send — Sara approves from the CRM.
//
// Exception: if journey_stage === 'ready_to_offer', send an SMS alert to Sara
// immediately at 209-559-4966. The lead's drafts still wait for approval.
//
// Usage:
//   - HTTP:  POST /api/ai/welcome  body: { lead_id }
//   - Server: `import { draftWelcome } from './ai/welcome.js'`

import { adminClient } from '../supabase.js';
import { anthropicJSON } from '../anthropic.js';
import { alertSara } from '../twilio.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const SARA_SYSTEM = `You are drafting messages on behalf of Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA.
Sara's voice is: warm, direct, knowledgeable, never corporate, never salesy.
She writes like she's texting a friend who happens to be a client.
Short sentences. No exclamation points. No filler phrases like "I hope this message finds you well."
Never use em-dashes or em-spaced lists. Plain prose only.
Never invent facts, listings, or commitments she has not made.`;

function buildUserPrompt(lead) {
  const priceMin = lead.price_min ? `$${lead.price_min.toLocaleString()}` : 'unknown';
  const priceMax = lead.price_max ? `$${lead.price_max.toLocaleString()}` : 'unknown';
  const areas    = (lead.areas && lead.areas.length) ? lead.areas.join(', ') : 'unspecified';

  return `Draft a welcome SMS (under 160 characters, no greeting fluff) and a welcome email (3-4 short paragraphs).
Lead:
  name:           ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'unknown'}
  journey_stage:  ${lead.journey_stage || 'unknown'}
  lead_type:      ${lead.lead_type     || 'unknown'}
  source:         ${lead.source        || 'website_form'}
  areas:          ${areas}
  price_range:    ${priceMin} - ${priceMax}
  notes:          ${lead.notes || '(none)'}

Respond in JSON only, no markdown fences:
{
  "sms":           "...",
  "email_subject": "...",
  "email_body":    "...",
  "reasoning":     "one sentence explaining the angle"
}`;
}

export async function draftWelcome(lead_id) {
  const supa = adminClient();

  const { data: lead, error } = await supa
    .from('leads').select('*').eq('id', lead_id).single();
  if (error || !lead) throw new Error('lead not found');

  // 1. Ask Anthropic for the two drafts
  const { json: drafts } = await anthropicJSON({
    system: SARA_SYSTEM,
    messages: [{ role: 'user', content: buildUserPrompt(lead) }],
    max_tokens: 800,
    temperature: 0.7
  });

  const sms      = (drafts.sms || '').trim();
  const subject  = (drafts.email_subject || '').trim();
  const body     = (drafts.email_body || '').trim();
  const reason   = (drafts.reasoning || '').trim();

  const rows = [];
  if (sms) {
    rows.push({
      lead_id, direction: 'outbound', channel: 'sms', body: sms,
      status: 'pending_approval', ai_generated: true, ai_draft_reasoning: reason
    });
  }
  if (subject && body) {
    rows.push({
      lead_id, direction: 'outbound', channel: 'email', subject, body,
      status: 'pending_approval', ai_generated: true, ai_draft_reasoning: reason
    });
  }

  let inserted = [];
  if (rows.length) {
    const { data, error: insErr } = await supa.from('messages').insert(rows).select();
    if (insErr) throw new Error(`messages insert: ${insErr.message}`);
    inserted = data || [];
  }

  // 2. Alert Sara directly for ready_to_offer leads
  let alert = null;
  if (lead.journey_stage === 'ready_to_offer') {
    const name  = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'A new lead';
    const phone = lead.phone || '(no phone)';
    const msg   = `New hot lead: ${name} is ready to make an offer. ${phone}. Open desk: legacycalifornia.com/crm`;
    try {
      alert = await alertSara(msg);
    } catch (e) {
      alert = { error: e.message };
    }
  }

  return { drafts: inserted, sara_alert: alert };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { lead_id } = await readJson(req);
    if (!lead_id) return fail(res, 400, 'lead_id required');
    const result = await draftWelcome(lead_id);
    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
