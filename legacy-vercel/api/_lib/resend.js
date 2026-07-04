// api/_lib/resend.js
// Resend transactional email helper — direct REST, no SDK.
// Docs: https://resend.com/docs/api-reference/emails/send-email
//
// Env vars:
//   RESEND_API_KEY      (required)  — get one at https://resend.com/api-keys
//   RESEND_FROM_EMAIL   (default: onboarding@resend.dev — Resend's pre-verified
//                        sandbox sender; only sends to the verified address on
//                        the Resend account. Switch to a verified domain
//                        sender like "Sara Cooper <sara@legacycalifornia.com>"
//                        once DNS is set up.)
//   RESEND_FROM_NAME    (default: "Sara Cooper · Legacy Properties")
//   RESEND_REPLY_TO     (default: SaraSellsCalifornia@gmail.com)

const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL        = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME         = process.env.RESEND_FROM_NAME  || 'Sara Cooper · Legacy Properties';
const REPLY_TO          = process.env.RESEND_REPLY_TO   || 'SaraSellsCalifornia@gmail.com';

const API_URL = 'https://api.resend.com/emails';

export function resendConfigured() {
  return !!RESEND_API_KEY;
}

/**
 * Send a single transactional email via Resend.
 * @returns {{ skipped?: boolean, id?: string, via: 'resend' }}
 */
export async function sendEmail({ to, toName, subject, html, text, attachments }) {
  if (!resendConfigured()) return { skipped: true, reason: 'RESEND_API_KEY not set', via: 'resend' };
  if (!to)      throw new Error('sendEmail: `to` required');
  if (!subject) throw new Error('sendEmail: `subject` required');
  if (!html && !text) throw new Error('sendEmail: either `html` or `text` required');

  const body = {
    from:      `${FROM_NAME} <${FROM_EMAIL}>`,
    to:        [toName ? `${toName} <${to}>` : to],
    reply_to:  REPLY_TO,
    subject,
    html:      html || `<pre style="font-family:Georgia,serif;font-size:15px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(text || '')}</pre>`,
    text:      text || stripHtml(html)
  };
  // Optional attachments (e.g. a calendar invite): [{ filename, content(base64) }]
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${JSON.stringify(json)}`);
  }
  return { id: json?.id || null, via: 'resend' };
}

function stripHtml(s = '') {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function escapeHtml(s = '') {
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
