// api/_lib/mailerlite.js
// MailerLite transactional email helper.
// Docs: https://developers.mailerlite.com/docs/transactional-email
//
// We use the Transactional API (single-shot) to send approved email drafts
// from the CRM. Bulk drip campaigns also use MailerLite but live in Phase 1G.

const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const FROM_EMAIL         = process.env.MAILERLITE_FROM_EMAIL  || 'sara@legacycalifornia.com';
const FROM_NAME          = process.env.MAILERLITE_FROM_NAME   || 'Sara Cooper · Legacy Properties';
const REPLY_TO           = process.env.MAILERLITE_REPLY_TO    || 'SaraSellsCalifornia@gmail.com';

const API_URL = 'https://connect.mailerlite.com/api';

export function mailerliteConfigured() {
  return !!MAILERLITE_API_KEY;
}

/**
 * Send a single transactional email.
 * @returns { skipped?: boolean, id?: string, raw?: any }
 */
export async function sendEmail({ to, toName, subject, html, text }) {
  if (!mailerliteConfigured()) return { skipped: true, reason: 'MAILERLITE_API_KEY not set' };
  if (!to)      throw new Error('sendEmail: `to` required');
  if (!subject) throw new Error('sendEmail: `subject` required');
  if (!html && !text) throw new Error('sendEmail: either `html` or `text` required');

  const body = {
    transactional: {
      from:     { email: FROM_EMAIL, name: FROM_NAME },
      reply_to: { email: REPLY_TO,  name: FROM_NAME },
      to:       [{ email: to, name: toName || to }],
      subject,
      html: html || `<pre style="font-family:Georgia,serif;font-size:15px;line-height:1.55;white-space:pre-wrap;">${(text || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>`,
      text: text || stripHtml(html)
    }
  };

  const res = await fetch(`${API_URL}/email/transactional`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MailerLite ${res.status}: ${JSON.stringify(json)}`);
  }
  return { id: json?.data?.id || null, raw: json };
}

function stripHtml(s = '') {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
