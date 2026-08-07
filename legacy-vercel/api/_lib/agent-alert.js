// api/_lib/agent-alert.js
// Notify BOTH agents (Sara + James) by SMS + email in one call. Used for
// consumer-engagement alerts — website intake and the IDX behavioral webhook —
// so an engagement reaches both agents on both channels.
//
// This is business → agent (B2A), not business → consumer, so no SMS-consent
// gating applies. Fully fail-soft: never throws, so an alert failure can't break
// the flow that triggered it. Returns a per-agent/per-channel result array.
//
// Phones/emails come from the `agents` table (agentIdentity); SMS via Twilio,
// email via Resend (Sendgrid fallback) — the same providers the rest of the CRM
// already uses. A channel with no configured provider or no address is skipped.

import { sendSMS } from './twilio.js';
import { sendEmail as sendEmailResend, resendConfigured } from './resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from './sendgrid.js';
import { agentIdentity } from './collection-render.js';

const AGENT_KEYS = ['sara', 'james'];

// The CRM desk URL, following PUBLIC_SITE_URL (flips to the custom domain via
// one env var) with a safe default.
export function deskUrl() {
  const base = (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.vercel.app').replace(/\/+$/, '');
  return `${base}/crm.html`;
}

// alertAgents(supa, { subject, sms, text, html })
//   sms   → SMS body sent to each agent's phone
//   subject/text/html → email sent to each agent's address (text used if no html)
export async function alertAgents(supa, { subject, sms, text, html } = {}) {
  const emailProvider = resendConfigured() ? sendEmailResend : (sendgridConfigured() ? sendEmailSendgrid : null);
  const out = [];
  for (const key of AGENT_KEYS) {
    let a = {};
    try { a = (await agentIdentity(supa, key)) || {}; } catch (_) { a = {}; }

    if (sms && a.phone) {
      try { const r = await sendSMS({ to: a.phone, body: sms }); out.push({ agent: key, channel: 'sms', ok: !r.skipped }); }
      catch (e) { out.push({ agent: key, channel: 'sms', ok: false, error: e.message }); }
    }

    if (emailProvider && a.email && (subject || text || html)) {
      try {
        const r = await emailProvider({ agent: key, to: a.email, toName: a.name || null, subject: subject || 'Legacy CRM alert', text: text || sms || '', html: html || undefined });
        out.push({ agent: key, channel: 'email', ok: !r.skipped });
      } catch (e) { out.push({ agent: key, channel: 'email', ok: false, error: e.message }); }
    }
  }
  return out;
}
