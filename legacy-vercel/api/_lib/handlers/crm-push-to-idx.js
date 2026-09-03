// api/_lib/handlers/crm-push-to-idx.js
// POST /api/crm/push-to-idx   (agent-only)
//
// Pushes a CRM contact into iHomefinder as a lead, so iHomefinder's own Listing
// Alerts can reach them.
//
// WHY THIS EXISTS
// iHomefinder's Listing Alerts are the only thing that can watch the whole MLS
// for a client. They told us in writing there is no listing data feed to import
// (case 00896993) and no outbound webhook at any plan level (case 00896645), and
// there is no MetroList RESO licence — so nothing on our side can see the market.
// But their alerts only reach people who exist as LEADS in iHomefinder, and on
// 2026-08-17 their support reported "there are no lead currently in the system".
// Every active client lives in this CRM and not there. Creating a lead is the one
// thing their Client API does (case 00896894), so this is the bridge.
//
// WHY IT IS CONFIGURED RATHER THAN HARD-CODED
// iHomefinder's documentation is not reachable from the build environment, so
// the exact base URL, auth style and lead path are NOT guessed here — they are
// read from env, and a missing one produces an error that names it. Their
// published API is HAL-style REST with two documented auth styles (a token in
// the path on v1, a session Login on v2), so both token and basic are supported.
//
// On any non-2xx the provider's own status and body are returned verbatim to the
// caller. That is deliberate: the first real call against live credentials is
// what reveals their exact contract, and a swallowed error would waste that.
//
// Body:
//   { lead_id: uuid, market_id?: string, force?: boolean }
//
//   market_id — optional. iHomefinder's Client API can also subscribe a contact
//   to a MarketBoost Market Report; Sara's markets are the ones already rendering
//   on the town pages (3019792 Murphys, 3019793 Arnold, 3019794 Copperopolis,
//   3019795 Angels Camp). Subscription is attempted only when a path is
//   configured, and never fails the lead push — the person existing in
//   iHomefinder is the durable half.
//
//   force — push again even though this contact already carries an ihf_lead_id.
//   Off by default: their API has no read endpoint, so we cannot check whether a
//   lead still exists, and a blind re-push would duplicate the person.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Everything iHomefinder-specific lives here so it can be corrected from Vercel
// without a deploy, once a real response shows us their exact contract.
function idxConfig() {
  const base  = (process.env.IHOMEFINDER_CLIENT_API_BASE || '').replace(/\/+$/, '');
  const token = process.env.IHOMEFINDER_CLIENT_API_TOKEN || '';
  const user  = process.env.IHOMEFINDER_CLIENT_API_USER  || '';
  const pass  = process.env.IHOMEFINDER_CLIENT_API_PASS  || '';
  // {token} in the path covers their v1 style, where the auth token is a path
  // parameter rather than a header.
  const leadPath   = process.env.IHOMEFINDER_LEAD_PATH   || '';
  const marketPath = process.env.IHOMEFINDER_MARKET_PATH || '';
  return { base, token, user, pass, leadPath, marketPath };
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (cfg.user) {
    h.Authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
  } else if (cfg.token) {
    // Sent as a bearer as well as being available for {token} path substitution,
    // so whichever style their endpoint expects, one of the two carries it.
    h.Authorization = `Bearer ${cfg.token}`;
  }
  return h;
}

const expand = (path, cfg) => path.replace('{token}', encodeURIComponent(cfg.token || ''));

// One call out, with the provider's own words preserved on failure.
async function callIdx(url, headers, body) {
  let res, text;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, error: `could not reach iHomefinder: ${e.message}` };
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON — keep the text */ }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (text || '').slice(0, 600), json };
  }
  return { ok: true, status: res.status, json, text };
}

// Their id could reasonably arrive under any of these; HAL puts the canonical
// URL in _links.self.href, whose last segment is the id.
function extractLeadId(json) {
  if (!json || typeof json !== 'object') return null;
  const direct = json.id || json.leadId || json.lead_id || json.contactId || json.contact_id;
  if (direct != null) return String(direct);
  const href = json?._links?.self?.href;
  if (typeof href === 'string') {
    const last = href.split('?')[0].replace(/\/+$/, '').split('/').pop();
    if (last) return last;
  }
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const b = await readJson(req);
    const leadId  = b?.lead_id;
    const marketId = typeof b?.market_id === 'string' ? b.market_id.trim() : '';
    const force   = b?.force === true;
    if (!leadId) return fail(res, 400, 'lead_id required');

    const cfg = idxConfig();
    // Name the missing setting rather than failing vaguely — this is the most
    // likely first failure and the agent can't act on "not configured".
    if (!cfg.base)                         return fail(res, 503, 'iHomefinder is not connected yet — set IHOMEFINDER_CLIENT_API_BASE in Vercel.');
    if (!cfg.token && !cfg.user)           return fail(res, 503, 'iHomefinder is not connected yet — set IHOMEFINDER_CLIENT_API_TOKEN (or _USER and _PASS) in Vercel.');
    if (!cfg.leadPath)                     return fail(res, 503, 'iHomefinder is not connected yet — set IHOMEFINDER_LEAD_PATH to their create-lead endpoint.');

    const supa = adminClient();
    const { data: lead, error: lErr } = await supa.from('leads')
      .select('id, first_name, last_name, email, phone, status, email_opt_out, ihf_lead_id, ihf_synced_at')
      .eq('id', leadId).maybeSingle();
    if (lErr)   return fail(res, 500, lErr.message);
    if (!lead)  return fail(res, 404, 'contact not found');

    // Guards. iHomefinder alerts are email; a contact with no address can't
    // receive one, and pushing an opted-out contact into an alert system would
    // send them mail they have refused.
    if (!lead.email || !EMAIL_RE.test(lead.email)) {
      return fail(res, 422, 'This contact has no email address — iHomefinder alerts are email, so there is nothing to send them to.');
    }
    if (lead.email_opt_out) {
      return fail(res, 409, `${lead.first_name || 'This contact'} has opted out of email — pushing them into listing alerts would email them anyway.`);
    }
    if (lead.status !== 'active') return fail(res, 409, 'contact is not active');
    if (lead.ihf_lead_id && !force) {
      return ok(res, {
        already: true, ihf_lead_id: lead.ihf_lead_id, synced_at: lead.ihf_synced_at,
        message: 'Already in iHomefinder — set their search criteria there.'
      });
    }

    const headers = authHeaders(cfg);
    // A tolerant body: their field naming isn't verifiable from here, so the
    // common spellings are all sent. Unknown fields are ignored by every REST
    // API worth the name, and this avoids a round-trip on a casing mismatch.
    const payload = {
      firstName: lead.first_name || '', lastName: lead.last_name || '',
      first_name: lead.first_name || '', last_name: lead.last_name || '',
      email: lead.email,
      phone: lead.phone || '', phoneNumber: lead.phone || '',
      source: 'Legacy Properties CRM'
    };

    const r = await callIdx(`${cfg.base}${expand(cfg.leadPath, cfg)}`, headers, payload);
    if (!r.ok) {
      return fail(res, 502, `iHomefinder refused the lead (HTTP ${r.status}): ${r.error || 'no detail returned'}`);
    }

    const ihfId = extractLeadId(r.json) || 'created';
    await supa.from('leads')
      .update({ ihf_lead_id: ihfId, ihf_synced_at: new Date().toISOString() })
      .eq('id', leadId);

    // Optional: subscribe them to one of the market reports already built in
    // iHomefinder. Best-effort — never undo a successful lead push.
    let market = null;
    if (marketId && cfg.marketPath) {
      const mr = await callIdx(
        `${cfg.base}${expand(cfg.marketPath, cfg).replace('{leadId}', encodeURIComponent(ihfId))}`,
        headers,
        { marketReportId: marketId, marketId, email: lead.email, leadId: ihfId }
      );
      market = mr.ok
        ? { subscribed: true, market_id: marketId }
        : { subscribed: false, market_id: marketId, error: `HTTP ${mr.status}: ${(mr.error || '').slice(0, 200)}` };
    } else if (marketId && !cfg.marketPath) {
      market = { subscribed: false, market_id: marketId, error: 'IHOMEFINDER_MARKET_PATH is not set, so no market subscription was attempted.' };
    }

    await supa.from('lead_events').insert({
      lead_id: leadId, event_type: 'pushed_to_ihomefinder', source: 'ihomefinder_idx',
      event_data: { ihf_lead_id: ihfId, market: market || null, by: profile.role }
    }).then(() => {}, () => {});

    return ok(res, {
      pushed: true, ihf_lead_id: ihfId, market,
      message: 'In iHomefinder now. Set their search criteria there to start the alerts.'
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
