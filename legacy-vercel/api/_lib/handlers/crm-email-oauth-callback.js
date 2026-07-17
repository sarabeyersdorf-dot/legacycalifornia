// api/_lib/handlers/crm-email-oauth-callback.js
// GET /api/crm/email-oauth-callback?code=...&state=sara|james
//
// Phase 2D — email integration. Google redirects the browser here directly
// after the owner grants (or denies) Gmail read-only access, so this endpoint
// is UNAUTHENTICATED by nature — do not gate it behind isAgent(). Instead it
// defends itself by:
//   1. Whitelisting `state` to exactly 'sara' or 'james' before trusting it.
//   2. Never trusting `state` alone for "which mailbox got connected" — the
//      actual address is fetched fresh from Google's userinfo endpoint using
//      the token we just received, which only Google could have produced.
//
// Exchanges `code` for tokens, resolves the connected mailbox address, and
// upserts email_accounts. Google only returns a refresh_token on the FIRST
// consent for a given account; on a re-auth (already-connected mailbox) it
// may omit it — in that case we keep the previously stored refresh_token
// rather than overwriting it with null.
//
// Always ends in a redirect back to /crm.html with a status query param the
// front end can show as a banner — never leaves the user on a raw JSON page.

import { adminClient } from '../supabase.js';

const ALLOWED_OWNERS = new Set(['sara', 'james']);

function redirectTo(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', `/crm.html?${qs}`);
  return res.end();
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const url   = new URL(req.url, `https://${req.headers.host}`);
  const code  = url.searchParams.get('code');
  const state = String(url.searchParams.get('state') || '').trim().toLowerCase();
  const googleError = url.searchParams.get('error');

  // Owner must be exactly whitelisted before we trust anything else on this
  // request — state round-trips through Google and a malformed/foreign value
  // here must never reach the database.
  if (!ALLOWED_OWNERS.has(state)) {
    return redirectTo(res, { email_oauth: 'error', reason: 'invalid_state' });
  }

  if (googleError) {
    // User declined consent, or Google itself errored — not a bug, just ack it.
    return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'declined' });
  }

  if (!code) {
    return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'missing_code' });
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[email-oauth-callback] missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI env var');
    return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'not_configured' });
  }

  try {
    // ---- Exchange the auth code for tokens ---------------------------------
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code'
      })
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('[email-oauth-callback] token exchange failed', tokenRes.status, tokenJson?.error, tokenJson?.error_description);
      return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'token_exchange_failed' });
    }

    const accessToken  = tokenJson.access_token;
    const newRefresh    = tokenJson.refresh_token || null; // may be absent on re-auth

    // ---- Resolve the ACTUAL connected mailbox from Google, not from `state` --
    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const userinfo = await userinfoRes.json().catch(() => ({}));
    const emailAddress = String(userinfo?.email || '').trim().toLowerCase();

    if (!userinfoRes.ok || !emailAddress || !emailAddress.includes('@')) {
      console.error('[email-oauth-callback] userinfo lookup failed', userinfoRes.status, userinfo);
      return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'userinfo_failed' });
    }

    const supa = adminClient();

    // ---- Upsert email_accounts, preserving the existing refresh_token when --
    // ---- Google doesn't hand us a new one (re-auth of an already-connected --
    // ---- mailbox). Look up by owner first (one mailbox per owner in normal --
    // ---- operation); fall back to a lookup by email_address (unique) in    --
    // ---- case this address was previously connected under a stale row.    --
    const { data: byOwner } = await supa
      .from('email_accounts').select('*').eq('owner', state).maybeSingle();

    let existing = byOwner;
    if (!existing) {
      const { data: byEmail } = await supa
        .from('email_accounts').select('*').eq('email_address', emailAddress).maybeSingle();
      existing = byEmail;
    }

    const refreshToken = newRefresh || existing?.refresh_token || null;
    if (!refreshToken) {
      // First-ever consent for this mailbox but Google didn't return a
      // refresh_token (shouldn't happen with access_type=offline&prompt=consent,
      // but guard anyway) — nothing usable to store.
      console.error('[email-oauth-callback] no refresh_token available (new or stored) for', emailAddress);
      return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'no_refresh_token' });
    }

    if (existing) {
      const { error: updErr } = await supa
        .from('email_accounts')
        .update({
          owner:         state,
          email_address: emailAddress,
          refresh_token: refreshToken,
          active:        true
        })
        .eq('id', existing.id);
      if (updErr) {
        console.error('[email-oauth-callback] update failed', updErr.message);
        return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'db_update_failed' });
      }
    } else {
      const { error: insErr } = await supa
        .from('email_accounts')
        .insert({
          owner:         state,
          email_address: emailAddress,
          refresh_token: refreshToken,
          active:        true
        });
      if (insErr) {
        console.error('[email-oauth-callback] insert failed', insErr.message);
        return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'db_insert_failed' });
      }
    }

    return redirectTo(res, { email_oauth: 'success', owner: state, email: emailAddress });
  } catch (e) {
    // Fail-soft: a hiccup here should never leave the browser stuck on a
    // half-finished OAuth flow. Ack with an error banner instead.
    console.error('[email-oauth-callback] unexpected error', e);
    return redirectTo(res, { email_oauth: 'error', owner: state, reason: 'unexpected' });
  }
}
