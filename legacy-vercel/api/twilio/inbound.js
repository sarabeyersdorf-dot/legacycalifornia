// api/twilio/inbound.js
// POST /api/twilio/inbound
//
// Phase 2C — Twilio deal communications inbox. Point BOTH the Messaging
// webhook and the Voice status-callback for Sara's Twilio number at this URL.
//
// On each event:
//   1. Verify the X-Twilio-Signature (when TWILIO_AUTH_TOKEN is set).
//   2. Normalise the event into { direction, channel, content, duration, phone }.
//   3. Match `phone` (the other party) against leads.phone (last-10 digits).
//        match    → write status='active',  contact_id = lead.id  (into the brief)
//        no match → write status='pending_review', contact_id = null (triage queue)
//   4. Never auto-create a lead here — unmatched numbers wait in the review queue.
//
// Fail-soft: always answers Twilio with 200 + empty TwiML so a hiccup never
// crashes the webhook or triggers retry storms. Uses the service-role client
// because Twilio is unauthenticated (no agent session).

import crypto from 'node:crypto';
import { adminClient } from '../_lib/supabase.js';
import { sendSMS, alertSara } from '../_lib/twilio.js';
import { agentIdentity } from '../_lib/collection-render.js';

// Empty TwiML — acknowledges the event with no auto-reply / no further action.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
function twiml(res, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/xml');
  res.end(EMPTY_TWIML);
}

// Last 10 digits — collapses +12095594966 / (209) 559-4966 / 209-559-4966 / …
export function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

// Read + parse the x-www-form-urlencoded body Twilio posts. Prefer an already
// parsed req.body (Vercel), else drain the raw stream.
async function readParams(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  const raw = await new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
  if (req.body && typeof req.body === 'string') return Object.fromEntries(new URLSearchParams(req.body));
  return Object.fromEntries(new URLSearchParams(raw));
}

// Twilio request signature: HMAC-SHA1 of (full URL + sorted param key/values),
// base64, compared to X-Twilio-Signature. https://www.twilio.com/docs/usage/security
function signatureValid(req, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || process.env.TWILIO_SKIP_SIGNATURE === '1') return true; // dev / opt-out
  const sig = req.headers['x-twilio-signature'];
  if (!sig) return false;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const url   = `${proto}://${host}${req.url}`;
  const data  = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('method_not_allowed'); }

  let params;
  try { params = await readParams(req); } catch (_) { return twiml(res); }

  if (!signatureValid(req, params)) { res.statusCode = 403; return res.end('bad signature'); }

  try {
    // ---- Classify the event ------------------------------------------------
    const isCall = !!(params.CallSid || params.CallStatus);
    const channel = isCall ? 'call' : 'sms';

    // A single call fires several status callbacks (initiated/ringing/…/
    // completed). Only record the terminal one so we don't stack duplicate
    // rows per call. Messages have no such lifecycle.
    if (isCall && params.CallStatus && params.CallStatus !== 'completed') return twiml(res);

    const dir = String(params.Direction || 'inbound').toLowerCase();
    const direction = dir.startsWith('outbound') ? 'outbound' : 'inbound';

    // The "other party" is who we match to a contact: their From on an inbound
    // event, our To on an outbound one.
    const phone = direction === 'outbound' ? (params.To || params.From) : (params.From || params.To);
    if (!phone) return twiml(res);   // nothing to key on — ack and drop

    const content  = isCall ? null : (params.Body || null);
    const duration = isCall && params.CallDuration != null ? parseInt(params.CallDuration, 10) || 0 : null;

    const supa = adminClient();

    // ---- Match against an existing lead by phone (last-10) -----------------
    const want = normPhone(phone);
    let contactId = null;
    let hitLead = null;
    if (want) {
      const { data: leads } = await supa
        .from('leads').select('id, phone, first_name, last_name, assigned_agent').not('phone', 'is', null).limit(5000);
      const hit = (leads || []).find((l) => normPhone(l.phone) === want);
      contactId = hit ? hit.id : null;
      hitLead = hit || null;
    }

    // ---- Sync STOP/START keywords to the consent record --------------------
    // Twilio's Advanced Opt-Out already blocks sends at the carrier level;
    // this keeps OUR records (sequence gating, composer warnings, audit
    // trail) in agreement with what the client actually asked for.
    if (contactId && direction === 'inbound' && channel === 'sms' && content) {
      const kw = String(content).trim().toLowerCase();
      const STOP  = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
      const START = new Set(['start', 'unstop', 'yes']);
      if (STOP.has(kw)) {
        await supa.from('leads').update({
          sms_opt_out: true, sms_consent: false,
          sms_consent_at: new Date().toISOString(),
          sms_consent_source: 'SMS STOP keyword'
        }).eq('id', contactId);
      } else if (START.has(kw)) {
        await supa.from('leads').update({
          sms_opt_out: false, sms_consent: true,
          sms_consent_at: new Date().toISOString(),
          sms_consent_source: 'SMS START keyword'
        }).eq('id', contactId);
      }
    }

    // Matched → straight to 'active' (shows in the brief). Unmatched →
    // 'pending_review' for the agent to triage. Never auto-create a lead here.
    await supa.from('deal_messages').insert({
      contact_id:            contactId,
      direction,
      channel,
      content,
      call_duration_seconds: duration,
      raw_phone_number:      String(phone),
      status:                contactId ? 'active' : 'pending_review'
    });

    // ---- Alert the agent so a lead's reply is seen immediately -------------
    // Any inbound text pings the assigned agent (matched) or Sara (unmatched).
    // Fail-soft and quiet: never on STOP/START keywords, never on calls, never
    // blocks the 200 back to Twilio.
    if (direction === 'inbound' && channel === 'sms' && content) {
      const kw = String(content).trim().toLowerCase();
      const isKeyword = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'start', 'unstop', 'yes'].includes(kw);
      if (!isKeyword) {
        try {
          const snippet = String(content).replace(/\s+/g, ' ').trim().slice(0, 140);
          if (contactId) {
            const who = [hitLead?.first_name, hitLead?.last_name].filter(Boolean).join(' ') || 'A lead';
            const agentKey = hitLead?.assigned_agent === 'james' ? 'james' : 'sara';
            const agent = await agentIdentity(supa, agentKey).catch(() => null);
            const body = `${who} just texted: “${snippet}” — open Legacy CRM to reply.`;
            if (agent?.phone) await sendSMS({ to: agent.phone, body });
            else await alertSara(body);
          } else {
            await alertSara(`New text from an unknown number ${String(phone)}: “${snippet}” — triage it in Legacy CRM.`);
          }
        } catch (_) { /* alert is best-effort; never block the webhook */ }
      }
    }

    return twiml(res);
  } catch (e) {
    // Never surface a 500 to Twilio (would trigger retries). Ack and move on.
    return twiml(res);
  }
}
