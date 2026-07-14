// api/ai/draft-reply.js
// Drafts a contextual reply from Sara for any lead, given their full thread
// (messages), recent events (saved/viewed properties, etc.), and scheduled tours.
// Saves the draft to the messages table as status: 'pending_approval'.
//
// Usage:
//   POST /api/ai/draft-reply
//   body: { lead_id, channel?: 'sms'|'email'|'portal' (defaults 'sms'), instruction?: 'optional human nudge' }
//
// Returns the inserted draft row.

import { adminClient } from '../supabase.js';
import { anthropicJSON } from '../anthropic.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const SARA_SYSTEM = `You are drafting messages on behalf of Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA.
Sara's voice is: warm, direct, knowledgeable, never corporate, never salesy.
She writes like she's texting a friend who happens to be a client.
Short sentences. No exclamation points. No filler phrases. No em-dashes.
Never invent facts, listings, or commitments. If unsure, ask one specific question.

Hard rules:
1. Sara's phone number is 209-559-4966. ALWAYS write the actual number when a phone is referenced. NEVER write a placeholder like [phone], {{phone}}, or "call me at my number".
2. Do not repeat the same phrase, sentence, or idea twice in a single message. Every line earns its place.
3. If the lead's first name is "Sara" (matches Sara Cooper's own name), open with "Hi," instead of "Hey Sara". For any other first name, "Hey {first_name}" is fine.`;

function fmtMessages(rows) {
  return rows.map(m => {
    const who = m.direction === 'inbound' ? 'Lead' : 'Sara';
    const subj = m.subject ? ` "${m.subject}"` : '';
    return `[${m.created_at}] (${m.channel}) ${who}${subj}: ${m.body}`;
  }).join('\n');
}

function fmtEvents(rows) {
  return rows.map(e => `[${e.created_at}] ${e.event_type} ${JSON.stringify(e.event_data || {})}`).join('\n');
}

function fmtTours(rows) {
  return rows.map(t => `[${t.scheduled_at || 'unscheduled'}] ${t.tour_type} ${t.status}`).join('\n');
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { lead_id, channel = 'sms', instruction = '' } = await readJson(req);
    if (!lead_id) return fail(res, 400, 'lead_id required');
    if (!['sms','email','portal'].includes(channel)) return fail(res, 400, 'invalid channel');

    const supa = adminClient();

    const { data: lead, error: leadErr } = await supa
      .from('leads').select('*').eq('id', lead_id).single();
    if (leadErr || !lead) return fail(res, 404, 'lead not found');

    const { data: messages = [] } = await supa
      .from('messages').select('*').eq('lead_id', lead_id).order('created_at', { ascending: true }).limit(50);

    const { data: events = [] } = await supa
      .from('lead_events').select('*').eq('lead_id', lead_id).order('created_at', { ascending: false }).limit(30);

    const { data: tours = [] } = await supa
      .from('tours').select('*').eq('lead_id', lead_id).order('scheduled_at', { ascending: true });

    const channelDesc = channel === 'sms'    ? 'short SMS (<160 chars)'
                       : channel === 'portal' ? 'short, warm note (2-5 sentences) that will appear in the message drawer on their client portal — a bit more relaxed than an email, no subject line, no sign-off needed'
                       : 'short email (2-4 short paragraphs)';
    const userPrompt = `Draft a ${channelDesc} reply for this lead.

Lead profile:
  name:          ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'unknown'}
  journey_stage: ${lead.journey_stage || 'unknown'}
  lead_type:     ${lead.lead_type || 'unknown'}
  areas:         ${(lead.areas || []).join(', ') || 'unspecified'}
  price_range:   ${lead.price_min || '?'} - ${lead.price_max || '?'}
  temperature:   ${lead.temperature}
  score:         ${lead.score}

Today (UTC): ${new Date().toISOString()}

Conversation history (oldest first):
${fmtMessages(messages) || '(none)'}

Recent events (newest first):
${fmtEvents(events) || '(none)'}

Tours:
${fmtTours(tours) || '(none)'}

${instruction ? `Sara's note for you: ${instruction}\n` : ''}
Respond in JSON only, no markdown fences:
{
  ${channel === 'sms'    ? '"sms": "...",' : ''}
  ${channel === 'portal' ? '"portal": "...",' : ''}
  ${channel === 'email'  ? '"email_subject": "...", "email_body": "...",' : ''}
  "reasoning": "one sentence on the angle you chose"
}`;

    const { json: draft } = await anthropicJSON({
      system: SARA_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 700,
      temperature: 0.7
    });

    const row = {
      lead_id,
      direction: 'outbound',
      channel,
      status: 'pending_approval',
      ai_generated: true,
      ai_draft_reasoning: (draft.reasoning || '').trim(),
      body:    channel === 'sms' ? (draft.sms || '').trim()
             : channel === 'portal' ? (draft.portal || '').trim()
             : (draft.email_body || '').trim(),
      subject: channel === 'email' ? (draft.email_subject || '').trim() : null
    };

    if (!row.body) return fail(res, 502, 'AI returned empty draft');

    const { data: inserted, error: insErr } = await supa.from('messages').insert(row).select().single();
    if (insErr) return fail(res, 500, `messages insert: ${insErr.message}`);

    return ok(res, { draft: inserted });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
