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

// ── Designed templates (bulk sender "HTML design" option) ──────────────────
// Email-safe HTML only: table layout, inline styles, hosted images, a
// bulletproof button. Modern CSS (fl: flex/grid, external <style>, web fonts)
// is stripped by Gmail/Outlook, so everything here is deliberately old-school.
// Images MUST be a hosted https URL — you can't embed a picture in an email.
const cleanUrl = (u, httpsOnly) => {
  const s = String(u == null ? '' : u).trim().replace(/["'<>\s]/g, '');
  if (httpsOnly) return /^https:\/\/[^ ]+$/i.test(s) ? s : '';
  return /^https?:\/\/[^ ]+$/i.test(s) ? s : '';
};

// renderTemplate(tpl, agent, opts) → { html, text }
//   tpl.type: 'featured' (photo + headline + body + button) or
//             'listing'  (adds a price / beds·baths·sqft / address bar)
//   opts.footerHtml appended below the signature (unsubscribe line).
export function renderTemplate(tpl, agent, opts = {}) {
  tpl = tpl || {};
  const type     = tpl.type === 'listing' ? 'listing' : 'featured';
  const photo    = cleanUrl(tpl.photo, true);           // hosted image, https only
  const headline = String(tpl.headline || '').trim();
  const bodyText = String(tpl.body || '').trim();
  const btnLabel = String(tpl.button_label || '').trim();
  const btnUrl   = cleanUrl(tpl.button_url);
  const address  = String(tpl.address || '').trim();
  const price    = String(tpl.price || '').trim();
  const beds     = String(tpl.beds || '').trim();
  const baths    = String(tpl.baths || '').trim();
  const sqft     = String(tpl.sqft || '').trim();

  const paras = bodyText
    ? bodyText.split(/\n\s*\n/).map((p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#3A332B;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
    : '';

  const hero = photo
    ? `<tr><td style="padding:0;"><img src="${esc(photo)}" width="600" alt="${esc(headline || address || 'Legacy Properties')}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr>`
    : '';

  let detailBar = '';
  if (type === 'listing' && (price || address || beds || baths || sqft)) {
    const specs = [beds && `${esc(beds)} bd`, baths && `${esc(baths)} ba`, sqft && `${esc(sqft)} sq ft`]
      .filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
    detailBar =
      `<tr><td style="padding:20px 32px 4px;">
        ${price ? `<div style="font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#8C6E3D;line-height:1.1;">${esc(price)}</div>` : ''}
        ${address ? `<div style="font-size:15px;color:#1A1714;margin-top:4px;">${esc(address)}</div>` : ''}
        ${specs ? `<div style="font-size:13px;color:#7C6A4D;margin-top:6px;letter-spacing:.02em;">${specs}</div>` : ''}
      </td></tr>`;
  }

  const headlineRow = headline
    ? `<tr><td style="padding:${type === 'listing' ? '14' : '26'}px 32px 4px;"><div style="font-family:Georgia,'Cormorant Garamond',serif;font-size:23px;font-weight:bold;line-height:1.25;color:#1A1714;">${esc(headline)}</div></td></tr>`
    : '';

  const bodyRow = paras ? `<tr><td style="padding:16px 32px 4px;">${paras}</td></tr>` : '';

  const button = (btnLabel && btnUrl)
    ? `<tr><td style="padding:10px 32px 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td bgcolor="#1A1714" style="border-radius:6px;">
            <a href="${esc(btnUrl)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:Georgia,serif;font-size:15px;color:#FAF6EC;text-decoration:none;border-radius:6px;">${esc(btnLabel)}&nbsp;→</a>
          </td>
        </tr></table>
      </td></tr>`
    : '';

  const a = agent || {};
  const sig = [
    esc(a.name || 'Legacy Properties'),
    a.title ? esc(a.title) : null,
    a.dre_number ? `DRE #${esc(a.dre_number)}` : null,
    a.phone ? esc(a.phone) : null
  ].filter(Boolean).join(' · ');

  const html =
`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#E7DFCB;margin:0;padding:0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;background:#FAF6EC;">
      <tr><td style="padding:24px 32px 6px;">
        <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;">Legacy Properties</div>
      </td></tr>
      ${hero}
      ${detailBar}
      ${headlineRow}
      ${bodyRow}
      ${button}
      <tr><td style="padding:22px 32px 26px;">
        <hr style="border:none;border-top:1px solid #D9CFB7;margin:8px 0 14px;">
        <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">${sig}<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
        ${opts.footerHtml || ''}
      </td></tr>
    </table>
  </td></tr>
</table>`;

  const textParts = [];
  if (headline) textParts.push(headline);
  if (type === 'listing') {
    const line1 = [address, price].filter(Boolean).join(' — ');
    if (line1) textParts.push(line1);
    const specs = [beds && `${beds} bd`, baths && `${baths} ba`, sqft && `${sqft} sq ft`].filter(Boolean).join(' · ');
    if (specs) textParts.push(specs);
  }
  if (bodyText) textParts.push(bodyText);
  if (btnLabel && btnUrl) textParts.push(`${btnLabel}: ${btnUrl}`);
  const text = textParts.join('\n\n') || headline || 'Legacy Properties';

  return { html, text };
}

// COLD OUTREACH footer (CAN-SPAM baseline for a skip-traced list): a working
// one-click opt-out, the sender's real business identity, and a PHYSICAL MAILING
// ADDRESS — all three are legally required for unsolicited commercial email.
// Used by the Expired Listing sequence and any other cold send. The address is
// the brokerage's mailing address; update BUSINESS_ADDRESS if it changes.
const BUSINESS_ADDRESS = '4149 Cedar Cir, Angels Camp, CA 95222';
export function coldOutreachFooter(token) {
  const url = token
    ? `https://legacycalifornia.com/api/unsubscribe?token=${encodeURIComponent(token)}`
    : 'https://legacycalifornia.com';
  return `<hr style="border:none;border-top:1px solid #D9CFB7;margin:22px 0 12px;">
    <p style="font-size:11px;line-height:1.55;color:#A89C8A;margin:0;">
      Sara Cooper · Broker/Owner, Legacy Properties · ${esc(BUSINESS_ADDRESS)} · (209) 559-4966<br>
      You're receiving this because your property recently came off the market and public
      records list you as the owner. If you'd rather not hear from me,
      <a href="${url}" style="color:#8C6E3D;">unsubscribe here</a> and I won't reach out again.
    </p>`;
}

// Wrapper for a COLD sequence email: branded container + the body verbatim
// (the sequence copy already carries Sara's own signature) + the CAN-SPAM cold
// footer. Deliberately does NOT add bodyToHtml's auto-signature, which would
// duplicate the sign-off already in the copy.
export function coldEmailHtml(text, token) {
  const safe = esc(text);
  const paragraphs = safe.split(/\n\s*\n/).map((p) =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paragraphs}
    ${coldOutreachFooter(token)}
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
