// api/_lib/sendgrid.js
// SendGrid transactional email helper — direct REST, no SDK.
// Docs: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
//
// Env vars:
//   SENDGRID_API_KEY     (required) — generate at https://app.sendgrid.com/settings/api_keys
//   SENDGRID_FROM_EMAIL  (default: sara@legacycalifornia.com)
//                        Must be a Verified Sender or part of an authenticated
//                        domain in SendGrid, or sends will 403.
//   SENDGRID_FROM_NAME   (default: "Sara Cooper · Legacy Properties")
//   SENDGRID_REPLY_TO    (default: SaraSellsCalifornia@gmail.com)

const SENDGRID_API_KEY  = process.env.SENDGRID_API_KEY;
const FROM_EMAIL        = process.env.SENDGRID_FROM_EMAIL  || 'sara@legacycalifornia.com';
const FROM_NAME         = process.env.SENDGRID_FROM_NAME   || 'Sara Cooper · Legacy Properties';
const REPLY_TO          = process.env.SENDGRID_REPLY_TO    || 'SaraSellsCalifornia@gmail.com';

const API_URL = 'https://api.sendgrid.com/v3/mail/send';

export function sendgridConfigured() {
  return !!SENDGRID_API_KEY;
}

/**
 * Send a single transactional email via SendGrid.
 * Returns { skipped, id, raw } where `id` is the SendGrid X-Message-Id header.
 */
export async function sendEmail({ to, toName, subject, html, text }) {
  if (!sendgridConfigured()) return { skipped: true, reason: 'SENDGRID_API_KEY not set' };
  if (!to)      throw new Error('sendEmail: `to` required');
  if (!subject) throw new Error('sendEmail: `subject` required');
  if (!html && !text) throw new Error('sendEmail: either `html` or `text` required');

  const body = {
    personalizations: [{
      to: [{ email: to, name: toName || undefined }],
      subject
    }],
    from:     { email: FROM_EMAIL, name: FROM_NAME },
    reply_to: { email: REPLY_TO,   name: FROM_NAME },
    content: [
      { type: 'text/plain', value: text || stripHtml(html) },
      { type: 'text/html',  value: html || `<pre style="font-family:Georgia,serif;font-size:15px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(text || '')}</pre>` }
    ]
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  // SendGrid returns 202 Accepted with empty body on success
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SendGrid ${res.status}: ${errText}`);
  }
  const id = res.headers.get('x-message-id') || null;
  return { id, raw: { status: res.status } };
}

function stripHtml(s = '') {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function escapeHtml(s = '') {
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
