// api/_lib/ihomefinder.js
// Pushing a contact into iHomefinder as a lead, so their Listing Alerts can
// reach that person. Shared by the CRM's "Send to iHomefinder alerts" button
// (crm-push-to-idx.js) and by website lead intake (api/leads/intake.js).
//
// WHY THIS MATTERS FOR INTAKE
// Sara: "the leads have to go to ihomefinder for a client to set up a search —
// first it comes to us and then the lead gets another email to set it up in
// ihomefinder." That double registration is the friction. A person filled in a
// form, landed in the CRM, and then had to sign up a SECOND time somewhere else
// before any listing alert would ever reach them. Most people don't.
//
// iHomefinder's alerts are the only thing that can watch the whole MLS — they
// confirmed in writing there is no listing feed to import (case 00896993) and no
// webhook (00896645), and creating a lead is the one thing their Client API does
// (00896894). So the fix is for OUR server to do that second registration on the
// visitor's behalf, from the one form they already filled in.
//
// CONFIGURATION
// Nothing about their API is guessed here — their documentation is unreachable
// from the build environment, so the base URL, auth style and paths are read from
// env and a missing one is reported by name. Both documented auth styles are
// supported: a bearer token, also substituted into {token} in the path for their
// v1 style, or basic user/pass.
//
//   IHOMEFINDER_CLIENT_API_BASE    required
//   IHOMEFINDER_CLIENT_API_TOKEN   (or _USER / _PASS)
//   IHOMEFINDER_LEAD_PATH          e.g. /clientapi/v1/{token}/leads
//   IHOMEFINDER_MARKET_PATH        optional — subscribe that lead to a market report
//
// Until those are set every call returns { skipped: true, reason }. That is a
// deliberate no-op, not an error: a website visitor must never see a form fail
// because an integration isn't configured yet.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Sara's MarketBoost market reports, the same ones already rendering on the town
// pages (market-report.html and town-*.html carry these ids in ihfKestrel.render).
// A lead who told us where they're looking gets subscribed to that town's report,
// which is the closest thing to "a search that actually works" their API offers.
// Sutter Creek and Wilseyville have no market built yet — they simply get no
// subscription rather than a wrong one.
export const MARKETS = {
  'murphys':      '3019792',
  'arnold':       '3019793',
  'copperopolis': '3019794',
  'angels camp':  '3019795'
};

export function marketIdForAreas(areas) {
  if (!Array.isArray(areas)) return null;
  for (const a of areas) {
    const key = String(a || '').trim().toLowerCase();
    if (MARKETS[key]) return MARKETS[key];
  }
  return null;
}

export function idxConfig() {
  return {
    base:       (process.env.IHOMEFINDER_CLIENT_API_BASE || '').replace(/\/+$/, ''),
    token:       process.env.IHOMEFINDER_CLIENT_API_TOKEN || '',
    user:        process.env.IHOMEFINDER_CLIENT_API_USER  || '',
    pass:        process.env.IHOMEFINDER_CLIENT_API_PASS  || '',
    leadPath:    process.env.IHOMEFINDER_LEAD_PATH   || '',
    marketPath:  process.env.IHOMEFINDER_MARKET_PATH || ''
  };
}

// Why a push can't run right now, or null when it can. Named settings so the
// message is actionable rather than "not configured".
export function idxUnavailable(cfg) {
  if (!cfg.base)                 return 'IHOMEFINDER_CLIENT_API_BASE is not set';
  if (!cfg.token && !cfg.user)   return 'IHOMEFINDER_CLIENT_API_TOKEN (or _USER/_PASS) is not set';
  if (!cfg.leadPath)             return 'IHOMEFINDER_LEAD_PATH is not set';
  return null;
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (cfg.user) h.Authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
  else if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

const expand = (path, cfg) => path.replace('{token}', encodeURIComponent(cfg.token || ''));

// One call out, with the provider's own words preserved on failure — the first
// call against live credentials is what reveals their exact contract.
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
  if (!res.ok) return { ok: false, status: res.status, error: (text || '').slice(0, 600), json };
  return { ok: true, status: res.status, json };
}

// Their id could arrive under any of these; HAL puts the canonical URL in
// _links.self.href, whose last segment is the id.
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

/**
 * Create this contact as a lead in iHomefinder and, when a market is given and a
 * market path is configured, subscribe them to it.
 *
 * Never throws: every caller here is either a website visitor's form submit or an
 * agent's click, and neither should fail because of this integration.
 *
 * @returns {{pushed?:boolean, skipped?:boolean, already?:boolean, reason?:string,
 *            ihf_lead_id?:string, market?:object, error?:string}}
 */
export async function pushLeadToIdx(supa, lead, opts = {}) {
  const cfg = idxConfig();
  const why = idxUnavailable(cfg);
  if (why) return { skipped: true, reason: why };

  if (!lead?.email || !EMAIL_RE.test(lead.email)) {
    return { skipped: true, reason: 'no email address — iHomefinder alerts are email' };
  }
  // Their own opt-out governs their copy. Pushing an opted-out person into an
  // alert system would mail them anyway.
  if (lead.email_opt_out) return { skipped: true, reason: 'contact has opted out of email' };
  if (lead.ihf_lead_id && !opts.force) {
    return { already: true, ihf_lead_id: lead.ihf_lead_id, reason: 'already in iHomefinder' };
  }

  const headers = authHeaders(cfg);
  // Both camelCase and snake_case spellings are sent: their field naming isn't
  // verifiable from here, unknown fields are ignored by any sane REST API, and
  // this avoids losing a round trip to a casing mismatch.
  const payload = {
    firstName: lead.first_name || '', lastName: lead.last_name || '',
    first_name: lead.first_name || '', last_name: lead.last_name || '',
    email: lead.email,
    phone: lead.phone || '', phoneNumber: lead.phone || '',
    source: opts.source || 'Legacy Properties website'
  };

  const r = await callIdx(`${cfg.base}${expand(cfg.leadPath, cfg)}`, headers, payload);
  if (!r.ok) return { error: `iHomefinder refused the lead (HTTP ${r.status}): ${r.error || 'no detail'}` };

  const ihfId = extractLeadId(r.json) || 'created';
  if (supa && lead.id) {
    await supa.from('leads')
      .update({ ihf_lead_id: ihfId, ihf_synced_at: new Date().toISOString() })
      .eq('id', lead.id)
      .then(() => {}, () => {});   // the push happened; a failed stamp must not undo it
  }

  let market = null;
  const marketId = opts.marketId || null;
  if (marketId && cfg.marketPath) {
    const mr = await callIdx(
      `${cfg.base}${expand(cfg.marketPath, cfg).replace('{leadId}', encodeURIComponent(ihfId))}`,
      headers,
      { marketReportId: marketId, marketId, email: lead.email, leadId: ihfId }
    );
    market = mr.ok
      ? { subscribed: true, market_id: marketId }
      : { subscribed: false, market_id: marketId, error: `HTTP ${mr.status}: ${(mr.error || '').slice(0, 200)}` };
  } else if (marketId) {
    market = { subscribed: false, market_id: marketId, reason: 'IHOMEFINDER_MARKET_PATH is not set' };
  }

  return { pushed: true, ihf_lead_id: ihfId, market };
}
