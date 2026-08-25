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
import { detectLeadSource, parseLead } from '../_lib/lead-intake.js';
import { alertAgents } from '../_lib/agent-alert.js';
import { getCallerProfile, isAgent } from '../_lib/auth.js';

const GMAIL_METADATA_HEADERS = ['From', 'Subject'];
const MAX_MESSAGES_PER_MAILBOX = 50; // keep each 15-minute run bounded

const agentForMailbox = (addr) => /james/i.test(String(addr || '')) ? 'james' : 'sara';

// ── Lead intake helpers ────────────────────────────────────────────────────
function decodeB64Url(data) {
  try { return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
}
function bodyFromPayload(payload) {
  const walk = (node, type) => {
    if (!node) return '';
    if (node.mimeType === type && node.body && node.body.data) return decodeB64Url(node.body.data);
    for (const c of (node.parts || [])) { const r = walk(c, type); if (r) return r; }
    return '';
  };
  return walk(payload, 'text/plain') || stripHtml(walk(payload, 'text/html'));
}
// Full plain-text body — fetched ONLY for a detected lead email (a handful a
// day), so the metadata-only fast path for ordinary mail is untouched.
async function getMessageBody(accessToken, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return '';
  const json = await r.json().catch(() => ({}));
  return bodyFromPayload(json.payload) || json.snippet || '';
}

// Create (or find) a hot lead from a parsed portal inquiry. Dedups on the unique
// leads.email, falling back to phone when the portal gave no email — so the same
// prospect arriving via several notifications collapses to one lead. Returns
// true only when a NEW lead was created.
async function upsertHotLead(supa, p, agent) {
  const today = new Date().toISOString().slice(0, 10);
  const noteBits = [
    `Hot lead from ${p.portal_label} — auto-captured ${today} from ${agent === 'james' ? "James's" : "Sara's"} inbox.`,
    p.property ? `Interested in: ${p.property}.` : '',
    p.message ? `Message: “${p.message}”` : ''
  ].filter(Boolean);
  const row = {
    first_name: p.first_name || null,
    last_name:  p.last_name || null,
    email:      p.email || null,
    phone:      p.phone || null,
    source:     'inbound_email',
    lead_type:  'buyer',
    temperature:'hot',
    assigned_agent: agent,
    status:     'active',
    notes:      noteBits.join(' ')
  };

  let leadId = null, isNew = false;
  if (p.email) {
    const ex = await supa.from('leads').select('id').eq('email', p.email).maybeSingle();
    if (ex.data) leadId = ex.data.id;
    else {
      const ins = await supa.from('leads').insert(row).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      leadId = ins.data.id; isNew = true;
    }
  } else if (p.phone) {
    const ex = await supa.from('leads').select('id').eq('phone', p.phone).limit(1);
    if (ex.data && ex.data[0]) leadId = ex.data[0].id;
    else {
      const ins = await supa.from('leads').insert(row).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      leadId = ins.data.id; isNew = true;
    }
  }

  // Always log the inquiry as an event so a re-inquiry from an existing lead
  // still shows fresh activity (and the property/message is preserved).
  if (leadId) {
    await supa.from('lead_events').insert({
      lead_id: leadId, event_type: 'form_submitted', source: 'portal',
      event_data: { portal: p.portal, property: p.property || null, message: p.message || null }
    }).then(() => {}, () => {});
  }
  return isNew;
}

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

  let inserted = 0, matched = 0, skipped = 0, leadsCreated = 0;
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

        // Portal lead intake: a lead-notification email (Realtor.com / Homes.com
        // / Zillow, either direct or forwarded through Follow Up Boss) becomes a
        // HOT lead in the CRM rather than a pending_review inbox message. The full
        // body is fetched only for these detected leads, so ordinary mail keeps
        // the cheap metadata-only path.
        const leadSource = detectLeadSource(senderEmail, subject);
        if (leadSource) {
          try {
            const body = await getMessageBody(accessToken, id);
            const parsed = parseLead(leadSource, { subject, body: body || snippet });
            if (parsed && (parsed.email || parsed.phone)) {
              if (await upsertHotLead(supa, parsed, agentForMailbox(account.email_address))) leadsCreated += 1;
            }
          } catch (_) {
            // A parse/insert hiccup on one lead must never abort the mailbox sync.
          }
          continue; // handled as a lead — don't also file it as an inbox message
        }

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
        if (!insErr) {
          inserted += 1;
          // Text the agent the moment a lead in a cold sequence replies — that's
          // a live conversation. (The sequence itself halts on the next tick.)
          // SMS-only: passing just `sms` skips the email channel in alertAgents.
          if (contactId) {
            try {
              const { data: ld } = await supa.from('leads')
                .select('first_name, last_name, email, sequence_id, property_address')
                .eq('id', contactId).maybeSingle();
              if (ld && ld.sequence_id) {
                const nm = [ld.first_name, ld.last_name].filter(Boolean).join(' ') || ld.email || 'A lead';
                const where = ld.property_address ? ` (${ld.property_address})` : '';
                const preview = String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 90);
                await alertAgents(supa, {
                  sms: `📩 ${nm}${where} just replied to your outreach${preview ? `: "${preview}"` : ''}. Their sequence is stopping — open the CRM to reply.`
                });
              }
            } catch (_) { /* alert is best-effort — never break the sync */ }
          }
        }
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

  return { mailbox: account.email_address, checked: ids.length, inserted, matched, skipped, leadsCreated };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  let okCron = !!req.headers['x-vercel-cron'] || (cronSecret ? bearer === cronSecret : true);
  // A signed-in agent may also trigger a sync on demand (the "Sync email now"
  // button) — same pull logic as the scheduled run.
  if (!okCron) {
    try { const { profile } = await getCallerProfile(req, res); if (isAgent(profile)) okCron = true; } catch (_) { /* fall through to 401 */ }
  }
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
