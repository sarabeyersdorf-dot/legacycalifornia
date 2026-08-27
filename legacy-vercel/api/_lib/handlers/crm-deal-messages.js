// api/_lib/handlers/crm-deal-messages.js
// GET /api/crm/deal-messages?key=<SYNC_SECRET>&since=48h  (or since=<ISO>)
//
// Deal correspondence for the briefing, out of the database — so it can read
// James's mailbox (which syncs to deal_messages) instead of running a separate
// 7:50 task on his own Cowork. Deduped at ingest (message_id), ordered by the
// real send time (sent_at), matched to a deal, tagged with the mailbox owner,
// and stripped of bulk mail by an EXPLICIT deny list (never heuristics — the
// list is returned in the payload so it's auditable and editable). Non-bulk mail
// we can't place is still returned, under `unmatched[]` — a title company we
// can't match is exactly the thing worth surfacing. Bodies are truncated so the
// payload stays under a consumer's fetch cap. Key-gated, no-store.
//
// Matching priority (first hit wins):
//   1. escrow / order number in the subject or body — unambiguous
//   2. property street name in the subject
//   3. sender address listed in the deal's `contacts`
//
// Cowork 2026-08-27 handoff, item 3. This is the payoff — it retires James's run.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';

// EXPLICIT bulk deny list — edit here, never guess. Returned in the payload.
const DENY_SENDERS = new Set([
  'news@car.org', 'consumer@e.mail.realtor.com', 'notifications-noreply@linkedin.com',
  'thetechbuzz@mail.beehiiv.com', 'nar@mail.nar.realtor'
]);
const DENY_DOMAINS = new Set([
  'car.org', 'e.mail.realtor.com', 'mail.realtor.com', 'linkedin.com',
  'beehiiv.com', 'mail.beehiiv.com', 'nar.realtor', 'mail.nar.realtor',
  'mail.zillow.com', 'e.mail.zillow.com', 'mailchimpapp.net', 'ml.homes.com'
]);
const STREET_TYPES = new Set(['st','street','dr','drive','ct','court','rd','road','ave','avenue','ln','lane','way','blvd','cir','circle','pl','place','ter','terrace','hwy','highway','pkwy','trail','trl','loop','run','path','pass']);
const DIRECTIONALS = new Set(['e','w','n','s','ne','nw','se','sw','east','west','north','south']);

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';
function isBulk(email) {
  const e = String(email || '').toLowerCase();
  if (DENY_SENDERS.has(e)) return true;
  const dom = domainOf(e);
  if (!dom) return false;
  if (DENY_DOMAINS.has(dom)) return true;
  for (const d of DENY_DOMAINS) if (dom.endsWith('.' + d)) return true;
  return false;
}

// Distinctive street word(s) from an address: drop the house number, directionals
// and the street-type suffix, keep words of length >= 4 ("695 Feather Dr" →
// ["feather"], "433 E Highway 4" → ["highway"]).
function streetKeywords(address) {
  const words = String(address || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.filter((w) => /[a-z]/.test(w) && w.length >= 4 && !STREET_TYPES.has(w) && !DIRECTIONALS.has(w));
}

function buildDealIndex(deals) {
  return (deals || []).map((d) => {
    const contactsText = (d.contacts && typeof d.contacts === 'object') ? JSON.stringify(d.contacts) : String(d.contacts || '');
    const escrowTokens = new Set();
    if (d.escrow_order) escrowTokens.add(String(d.escrow_order).toLowerCase());
    // "Order P-708659", "Escrow #2473532-TS", "Order #FSST-5312600364", "escrow P-708410"
    const re = /(?:order|escrow)\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/gi;
    let m; while ((m = re.exec(contactsText))) {
      const tok = m[1].toLowerCase().replace(/[.,;:)\]]+$/, '');
      if (tok.length >= 5 && /\d/.test(tok)) escrowTokens.add(tok);
    }
    const emails = new Set((contactsText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()));
    return { source_key: d.source_key, address: d.address || null, agent: d.agent || null,
             escrowTokens, streetTokens: streetKeywords(d.address), emails };
  });
}

function matchDeal(msg, index) {
  const subj = String(msg.subject || '').toLowerCase();
  const body = String(msg.content || '').toLowerCase();
  const hay  = subj + ' \n ' + body;
  const sender = String(msg.raw_email_address || '').toLowerCase();
  for (const d of index) for (const t of d.escrowTokens) if (hay.includes(t)) return d;   // 1
  for (const d of index) for (const s of d.streetTokens)  if (subj.includes(s)) return d;  // 2
  for (const d of index) if (d.emails.has(sender)) return d;                               // 3
  return null;
}

const ownerOf = (seen) => {
  const a = Array.isArray(seen) ? seen : [];
  const s = a.includes('sara'), j = a.includes('james');
  return (s && j) ? 'both' : s ? 'sara' : j ? 'james' : null;
};
const truncate = (s, n) => { const v = String(s || ''); return v.length > n ? v.slice(0, n) : v; };

function parseSince(sinceRaw) {
  const s = String(sinceRaw || '48h').trim();
  const rel = s.match(/^(\d+)\s*([hd])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const ms = rel[2].toLowerCase() === 'd' ? n * 86400000 : n * 3600000;
    return new Date(Date.now() - ms);
  }
  const t = new Date(s);
  return isNaN(t.getTime()) ? new Date(Date.now() - 48 * 3600000) : t;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');

  try {
    const supa = adminClient();
    const since = parseSince(req.query?.since);
    const sinceIso = since.toISOString();

    const [{ data: deals }, { data: rows }] = await Promise.all([
      supa.from('deals').select('source_key, address, agent, escrow_order, contacts'),
      supa.from('deal_messages')
        .select('id, contact_id, direction, channel, content, subject, raw_email_address, status, created_at, sent_at, seen_by')
        .eq('channel', 'email').gte('created_at', sinceIso)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(400)
    ]);

    const index = buildDealIndex(deals);
    const messages = [], unmatched = [];
    let dropped_bulk = 0;

    for (const m of (rows || [])) {
      if (isBulk(m.raw_email_address)) { dropped_bulk += 1; continue; }
      const d = matchDeal(m, index);
      const item = {
        from:      m.raw_email_address || null,
        subject:   m.subject || null,
        body:      truncate(m.content, 1500),
        truncated: String(m.content || '').length > 1500,
        sent_at:   m.sent_at || null,          // real send time; NULL if unparsed
        at:        m.created_at,               // ingest time (fallback for ordering)
        direction: m.direction,
        owner:     ownerOf(m.seen_by),         // sara | james | both | null
        deal:      d ? d.source_key : null,
        address:   d ? d.address : null
      };
      if (d) messages.push(item); else unmatched.push(item);
    }

    return ok(res, {
      generated_at: new Date().toISOString(),
      since: sinceIso,
      counts: { matched: messages.length, unmatched: unmatched.length, dropped_bulk },
      // Auditable + editable — Cowork can see exactly what was filtered out.
      deny_list: { senders: [...DENY_SENDERS], domains: [...DENY_DOMAINS] },
      messages,
      unmatched
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
