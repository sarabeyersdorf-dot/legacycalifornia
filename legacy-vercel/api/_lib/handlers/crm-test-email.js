// api/_lib/handlers/crm-test-email.js
// POST /api/crm/test-email  { to: 'you@example.com' }
//
// Agent-only smoke test for the Resend configuration. Sends one tiny email
// and returns Resend's response (or error) verbatim so deliverability can be
// confirmed end-to-end without touching real leads / sequences.

import { sendEmail, resendConfigured } from '../resend.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');
    if (!resendConfigured()) return fail(res, 500, 'RESEND_API_KEY not set in Vercel');

    const to = (req.body?.to || '').trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return fail(res, 400, 'valid `to` email required');
    }

    const subject = 'Legacy Properties — Resend test';
    const text = `This is a test send from your Legacy Properties CRM at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}.

If you received this from sara@send.legacycalifornia.com and Gmail doesn't show "via resend.com" under the sender, your domain verification + DKIM are working correctly.

— sent by ${profile.display_name || profile.role} via /api/crm/test-email`;

    const result = await sendEmail({ to, subject, text });

    return ok(res, {
      sent: true,
      from_email: process.env.RESEND_FROM_EMAIL || '(default: onboarding@resend.dev)',
      from_name:  process.env.RESEND_FROM_NAME  || 'Sara Cooper · Legacy Properties',
      reply_to:   process.env.RESEND_REPLY_TO   || 'SaraSellsCalifornia@gmail.com',
      to,
      resend: result
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
