// api/_lib/email-html.js
//
// Shared email plumbing for every outbound-email path (single message, ledger
// welcome + auto-send, CRM bulk send). Keeps the branded HTML wrapper and the
// provider selection in ONE place so the single and bulk senders stay in sync.
//
// - pickEmailProvider(): Resend preferred, SendGrid fallback, or null.
// - bodyToHtml(text, agent, opts): the parchment-branded inline-HTML wrapper,
//   signed with the SENDING agent's identity. opts.footerHtml appends below the
//   signature (used for the unsubscribe line on bulk / newsletter mail).
// - unsubscribeFooter(token): a compliant one-click unsubscribe line.

import { sendEmail as sendEmailResend,   resendConfigured }   from './resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from './sendgrid.js';

export function pickEmailProvider() {
  if (resendConfigured())   return { name: 'resend',   send: sendEmailResend };
  if (sendgridConfigured()) return { name: 'sendgrid', send: sendEmailSendgrid };
  return null;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function bodyToHtml(text, agent, opts = {}) {
  const safe = esc(text);
  const paragraphs = safe.split(/\n\s*\n/).map((p) =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  const a = agent || {};
  const sig = [
    esc(a.name || 'Legacy Properties'),
    a.title ? esc(a.title) : null,
    a.dre_number ? `DRE #${esc(a.dre_number)}` : null,
    a.phone ? esc(a.phone) : null
  ].filter(Boolean).join(' · ');
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paragraphs}
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:24px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">${sig}<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
    ${opts.footerHtml || ''}
  </div>`;
}

// CAN-SPAM: every bulk / newsletter email must carry a working opt-out. The
// token is leads.unsubscribe_token; /api/unsubscribe flips leads.email_opt_out.
export function unsubscribeFooter(token) {
  if (!token) return '';
  const url = `https://legacycalifornia.com/api/unsubscribe?token=${encodeURIComponent(token)}`;
  return `<p style="font-size:11px;line-height:1.5;color:#A89C8A;margin:16px 0 0;text-align:center;">
    You're receiving this because you asked to hear from Legacy Properties.
    <a href="${url}" style="color:#8C6E3D;">Unsubscribe</a>.
  </p>`;
}
