// api/_lib/handlers/crm-email-oauth-start.js
// GET /api/crm/email-oauth-start?owner=sara|james
//
// Phase 2D — email integration. Kicks off the Google OAuth 2.0 consent flow
// for connecting a Gmail inbox (read-only) so api/cron/email-sync.js can pull
// inbound mail into deal_messages. Agent-only — only Sara/James/admin may
// initiate a connection; the resulting tokens are stored server-side only
// (email_accounts.refresh_token is never exposed to any client).
//
// Validates `owner` strictly (sara|james) since it round-trips through Google
// as the `state` param and the callback trusts it to route the token.

import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, fail } from '../cors.js';

const ALLOWED_OWNERS = new Set(['sara', 'james']);

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  const owner = String(req.query?.owner || '').trim().toLowerCase();
  if (!ALLOWED_OWNERS.has(owner)) {
    return fail(res, 400, "owner must be 'sara' or 'james'");
  }

  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    console.error('[email-oauth-start] missing GOOGLE_CLIENT_ID / GOOGLE_OAUTH_REDIRECT_URI env var');
    return fail(res, 500, 'Email integration is not configured yet. Ask your developer to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI.');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/gmail.readonly',
    access_type:   'offline',
    prompt:        'consent',    // forces a fresh refresh_token even on re-auth
    state:         owner
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  res.statusCode = 302;
  res.setHeader('Location', authUrl);
  return res.end();
}
