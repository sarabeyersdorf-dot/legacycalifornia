// api/_lib/handlers/auth-magic-link.js
// POST /api/auth/magic-link
// Body: { email, redirect?: string }
//
// Flow:
//   1. If the auth user doesn't exist yet, create them (no confirmation email).
//   2. Use Supabase Admin `generateLink({ type: 'magiclink' })` to mint a
//      single-use sign-in URL.
//   3. Deliver the email via Resend with our own branded template — Supabase's
//      built-in mailer is bypassed entirely.
//
// If Resend is not configured, we fall back to Supabase's built-in
// signInWithOtp() so the user still gets an email (just from the Supabase
// shared sender). That keeps non-prod environments working.

import { adminClient, userClient } from '../supabase.js';
import { sendEmail as sendEmailResend, resendConfigured } from '../resend.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { email, redirect } = await readJson(req);
    if (!email) return fail(res, 400, 'email required');

    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const emailRedirectTo = redirect || `${origin}/api/auth/callback`;

    // Path A — Resend is configured: mint the link admin-side, send via Resend.
    if (resendConfigured()) {
      const supa = adminClient();

      // Ensure the user exists. If not, create them with email auto-confirmed
      // so the magic link signs them straight in.
      try {
        await supa.auth.admin.createUser({ email, email_confirm: true });
      } catch (e) {
        // 422 "User already registered" is expected on repeat logins — ignore.
      }

      const { data, error } = await supa.auth.admin.generateLink({
        type:    'magiclink',
        email,
        options: { redirectTo: emailRedirectTo }
      });
      if (error) return fail(res, 400, error.message);

      const actionLink = data?.properties?.action_link;
      if (!actionLink) return fail(res, 500, 'no action_link returned from supabase');

      const html = magicLinkHtml(actionLink);
      const text = magicLinkText(actionLink);

      await sendEmailResend({
        to:      email,
        subject: 'Your link into Legacy',
        html, text
      });

      return ok(res, { sent: true, via: 'resend' });
    }

    // Path B — Resend not configured: fall back to Supabase's built-in mailer.
    const supa = userClient(null);
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: { emailRedirectTo }
    });
    if (error) return fail(res, 400, error.message);
    return ok(res, { sent: true, via: 'supabase' });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

function magicLinkHtml(url) {
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:520px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
  <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:14px;">Legacy Properties</div>
  <h1 style="font-style:italic;font-weight:500;font-size:28px;line-height:1.2;margin:0 0 18px;">Welcome in.</h1>
  <p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 22px;">Tap the link below to open your dashboard. It signs you in instantly — no password to remember. The link works once and expires in an hour.</p>
  <p style="margin:0 0 28px;">
    <a href="${url}" style="display:inline-block;background:#1A1714;color:#FAF6EC;text-decoration:none;padding:14px 22px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;">Open my dashboard</a>
  </p>
  <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0 0 6px;">If you did not request this, you can ignore the email — nothing happens until the link is clicked.</p>
  <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:24px 0 0;">— Sara Cooper · Broker · DRE #02141987 · 209-559-4966</p>
</div>`;
}

function magicLinkText(url) {
  return `Welcome in.

Tap the link below to open your dashboard. It signs you in instantly — no password to remember. The link works once and expires in an hour.

${url}

If you did not request this, you can ignore the email — nothing happens until the link is clicked.

— Sara Cooper · Broker · DRE #02141987 · 209-559-4966`;
}
