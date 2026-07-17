// api/cron/email-sync.js
// GET /api/cron/email-sync   (Vercel cron, every 15 minutes)
//
// Phase 2D — email deal inbox. Mirrors the Twilio inbound pattern
// (api/twilio/inbound.js) but pulls instead of receiving a webhook:
//
//   For each ACTIVE row in email_accounts:
//     1. Use the stored refresh_token to mint a fresh Gmail access token.
//     2. List inbox messages received since last_synced_at (24h back on the
//        very first sync), metadata-only (From/Subject + snippet — never the
//        full body) to keep this cheap and avoid ingesting content we don't
//        need.
//     3. Strip the sender's bare email address out of the From header and
//        match it (case-insensitively, exact) against leads.email.
//          match    -> status='active',        contact_id = lead.id
//          no match -> status='pending_review', contact_id = null
//     4. Insert one deal_messages row per message (channel:'email',
//        direction:'inbound'). Never auto-create a lead here — unmatched
//        senders wait in the review queue, same as unmatched phone numbers.
//     5. Advance that mailbox's last_synced_at.
//
// Fail-soft PER MAILBOX: one mailbox's sync is wrapped in its own try/catch
// so a revoked/expired token on one account never blocks the other or crashes
// the cron run. Uses the service-role client — this is an unattended cron,
// there is no agent session.
//
// Reconnect flagging (testing-mode OAuth app => 7-day refresh token lifetime
// for test users): when refreshAccessToken() fails, that specifically means
// the stored refresh_token no longer works and the owner needs to click
// "Connect Email" again — so we flag email_accounts.needs_reconnect = true
// with a short human-readable last_sync_error, distinct from any other
// mid-sync failure (e.g. a transient Gmail list/message error), which is
// NOT reconnect-worthy and is left alone. A mailbox that completes a sync
// successfully (i.e. token refresh worked) always clears the flag, so a
// one-off failure that resolves itself doesn't leave a stale warning.

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';

const GMAIL_METADATA_HEADERS = ['From', 'Subject'];
const MAX_MESSAGES_PER_MAILBOX = 50; // keep each 15-minute run bounded

// Thrown only for a failed access-token refresh, so the caller can tell
// "the refresh_token is dead, flag needs_reconnect" apart from any other
// mid-sync error (bad Gmail response, DB hiccup, etc.) that shouldn't send
// the owner off to reconnect a mailbox that's actually fine.
class TokenRefreshError extends Error {
  constructor(detail, summary) {
    super(detail);
    this.name = 'TokenRefreshError';
    this.isTokenRefreshError = true;
    this.summary = summary;
  }
}

// Short, human-readable reason for the Settings card / morning brief — never
// the raw Google error payload.
function summarizeTokenError(errorCode) {
  if (errorCode === 'invalid_grant') return 'Google sign-in expired — please reconnect';
  return 'Google sign-in failed — please reconnect';
}

// Pull the bare address out of a From header like `"Jane Doe" <jane@x.com>`
// or a bare `jane@x.com`. Mirrors the fail-soft, never-throw style of
// normPhone() in api/twilio/inbound.js, keyed on email instead of phone.
export function extractEmailAddress(fromHeader) {
  const s = String(fromHeader || '');
  const angle = s.match(/<([^>]+)>/);
  const raw = angle ? angle[1] : s;
  const trimmed = raw.trim().toLowerCase();
  // crude but sufficient sanity check — never throws
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token'
    })
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    const errorCode = json.error || 'unknown';
    throw new TokenRefreshError(
      `token refresh failed (${r.status}): ${errorCode}`,
      summarizeTokenError(errorCode)
    );
  }
  return json.access_token;
}

async function listMessageIds(accessToken, afterUnixSeconds) {
  const q = `in:inbox after:${afterUnixSeconds}`;
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({
    q, maxResults: String(MAX_MESSAGES_PER_MAILBOX)
  })}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`list messages failed (${r.status}): ${json.error?.message || 'unknown'}`);
  return (json.messages || []).map((m) => m.id);
}

async function getMessageMeta(accessToken, id) {
  const params = new URLSearchParams({ format: 'metadata' });
  GMAIL_METADATA_HEADERS.forEach((h) => params.append('metadataHeaders', h));
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${params}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`get message failed (${r.status}): ${json.error?.message || 'unknown'}`);
  return json;
}

// Syncs a single mailbox end-to-end. Throws on failure — the caller wraps
// this per-mailbox so one bad token never blocks the rest.
async function syncMailbox(supa, account, clientId, clientSecret) {
  const accessToken = await refreshAccessToken(account.refresh_token, clientId, clientSecret);

  const sinceUnix = account.last_synced_at
    ? Math.floor(new Date(account.last_synced_at).getTime() / 1000)
    : Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);

  const ids = await listMessageIds(accessToken, sinceUnix);

  let inserted = 0, matched = 0, skipped = 0;
  const syncStartedAt = new Date().toISOString();

  if (ids.length) {
    // Pull every lead's email once per mailbox sync rather than per-message —
    // mirrors the inbound.js pattern of loading `leads` once and matching
    // in memory.
    const { data: leads } = await supa
      .from('leads').select('id, email').not('email', 'is', null).limit(5000);
    const leadByEmail = new Map();
    for (const l of (leads || [])) {
      const e = String(l.email || '').trim().toLowerCase();
      if (e) leadByEmail.set(e, l.id);
    }

    for (const id of ids) {
      try {
        const msg = await getMessageMeta(accessToken, id);
        const headers = msg?.payload?.headers || [];
        const fromHeader = headerValue(headers, 'From');
        const subject = headerValue(headers, 'Subject') || null;
        const snippet = msg?.snippet || null;

        const senderEmail = extractEmailAddress(fromHeader);
        if (!senderEmail) { skipped += 1; continue; } // nothing to key on — drop, like inbound.js does for phone

        // Never file the mailbox's own outbound-looking mail (e.g. mail Gmail
        // filed into inbox that this account itself sent) as an inbound lead
        // message from itself.
        if (senderEmail === String(account.email_address || '').toLowerCase()) { skipped += 1; continue; }

        const contactId = leadByEmail.get(senderEmail) || null;
        if (contactId) matched += 1;

        const { error: insErr } = await supa.from('deal_messages').insert({
          contact_id:        contactId,
          direction:          'inbound',
          channel:            'email',
          content:             snippet,
          subject,
          raw_email_address:  senderEmail,
          status:              contactId ? 'active' : 'pending_review'
        });
        if (!insErr) inserted += 1;
      } catch (_) {
        // One bad message must never abort the whole mailbox sync.
        skipped += 1;
      }
    }
  }

  // Reaching here means refreshAccessToken() succeeded, so whatever token
  // problem (if any) previously flagged this mailbox is resolved — clear it
  // alongside the routine last_synced_at advance.
  await supa.from('email_accounts')
    .update({
      last_synced_at:  syncStartedAt,
      needs_reconnect: false,
      last_sync_error: null,
      last_error_at:   null
    })
    .eq('id', account.id);

  return { mailbox: account.email_address, checked: ids.length, inserted, matched, skipped };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okCron = !!req.headers['x-vercel-cron'] || (cronSecret ? bearer === cronSecret : true);
  if (!okCron) return fail(res, 401, 'cron secret invalid');
  res.setHeader('Cache-Control', 'no-store');

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[email-sync] missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env var — skipping run');
    // Not a hard failure — nothing is configured yet, so there's nothing to
    // do. Ack with 200 so the cron doesn't show as perpetually broken before
    // Sara has connected a mailbox.
    return ok(res, { skipped: true, reason: 'not_configured' });
  }

  try {
    const supa = adminClient();
    const { data: accounts, error } = await supa
      .from('email_accounts').select('*').eq('active', true);
    if (error) return fail(res, 500, error.message);

    const results = [];
    for (const account of (accounts || [])) {
      try {
        const r = await syncMailbox(supa, account, clientId, clientSecret);
        results.push({ ok: true, ...r });
      } catch (e) {
        // Fail-soft per mailbox — a revoked/expired token on one account
        // (e.g. Sara re-does her Google password, or the 7-day test-user
        // refresh token in our OAuth-testing-mode app simply expires) must
        // never block James's mailbox or crash the cron run.
        console.error(`[email-sync] mailbox ${account.email_address} failed:`, e.message);
        results.push({ ok: false, mailbox: account.email_address, error: e.message });

        if (e && e.isTokenRefreshError) {
          try {
            await supa.from('email_accounts')
              .update({
                needs_reconnect: true,
                last_sync_error: e.summary,
                last_error_at:   new Date().toISOString()
              })
              .eq('id', account.id);
          } catch (_) {
            // Best-effort flagging — never let this break the cron run.
          }
        }
      }
    }

    return ok(res, { accounts: results.length, results });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
