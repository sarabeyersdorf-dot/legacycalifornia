// api/sms/inbound.js
// POST /api/sms/inbound?key=<PERSONAL_SMS_SECRET>
//
// Personal-phone SMS bridge. An SMS-forwarder app on an agent's phone (Android)
// POSTs each text here; it lands in the SAME unified Messages inbox + contact
// card as the Twilio texts, matched to a contact by phone number.
//
// Auth: a shared secret in the query string (?key=) — the forwarder app is
// unauthenticated, so the secret in the URL is what gates it. Set
// PERSONAL_SMS_SECRET in Vercel; without it the endpoint is closed.
//
// Works with any "paste-a-URL" SMS-forwarder app: it reads GET or POST, and
// pulls the fields out of the query string AND/OR the body under every common
// name the popular apps use — you don't have to customize the app's payload.
//
// Recognized fields (any of these aliases; JSON, form, or query-string):
//   the number   sender / from / phone / msisdn / number / address / source
//   the message  message / text / body / content / msg / sms
//   agent        agent  ('james' anywhere → James, else Sara)      (optional)
//   direction    direction / dir  ('out'|'sent' → outbound)  default inbound
//   ts           timestamp / ts / sentStamp / receivedStamp        (optional)
//
// Privacy by design: a text is only stored when its number matches an existing
// CRM contact. Personal (non-client) texts don't match, so they're dropped and
// never stored. We don't alert the agent (it's their own phone — they saw it).

import { adminClient } from '../_lib/supabase.js';

function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') {
    raw = await new Promise((resolve) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); req.on('error', () => resolve(''));
    });
  }
  if (!raw) return {};
  const t = raw.trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* fall through */ } }
  const out = {};
  for (const pair of t.split('&')) { const [k, v] = pair.split('='); if (k) out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' ')); }
  return out;
}

const pick = (o, ...keys) => { for (const k of keys) { if (o[k] != null && String(o[k]).length) return o[k]; } return null; };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  // Accept GET and POST — "paste-a-URL" forwarder apps use either one.
  if (req.method !== 'POST' && req.method !== 'GET') { res.statusCode = 405; return res.end('method_not_allowed'); }

  const secret = process.env.PERSONAL_SMS_SECRET;
  const key = req.query?.key || '';
  if (!secret || key !== secret) { res.statusCode = 403; return res.end('forbidden'); }

  // Always answer 200 so a hiccup never makes the forwarder app retry-storm.
  const ok = (extra) => { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, ...extra })); };

  try {
    // Read fields from the query string AND the body (minus the secret), so it
    // works whether the app sends GET params or a fixed POST payload.
    const body = req.method === 'POST' ? await readBody(req) : {};
    const { key: _k, ...q } = (req.query || {});
    const b = { ...q, ...body };

    const agent = /james/i.test(String(pick(b, 'agent') || '')) ? 'james' : 'sara';
    const dirRaw = String(pick(b, 'direction', 'dir') || 'inbound').toLowerCase();
    const direction = /out|sent/.test(dirRaw) ? 'outbound' : 'inbound';
    const text = pick(b, 'text', 'message', 'body', 'content', 'msg', 'sms');
    // The OTHER party's number, under whatever name the app uses.
    const phone = pick(b, 'phone', 'sender', 'msisdn', 'number', 'address', 'source')
      || (direction === 'outbound' ? pick(b, 'to', 'from') : pick(b, 'from', 'to'));

    if (!text || !phone) return ok({ stored: false, reason: 'missing text or phone' });

    const supa = adminClient();
    const want = normPhone(phone);
    if (!want) return ok({ stored: false, reason: 'unparseable phone' });

    // Match to a contact. No match → drop (keeps personal texts out of the CRM).
    const { data: leads } = await supa.from('leads').select('id, phone').not('phone', 'is', null).limit(5000);
    const hit = (leads || []).find((l) => normPhone(l.phone) === want);
    if (!hit) return ok({ stored: false, reason: 'no matching contact' });

    // Light dedupe — SMS forwarder apps can re-POST on flaky networks. Skip an
    // identical text on the same thread within the last 90 seconds.
    const sinceIso = new Date(Date.now() - 90000).toISOString();
    const { data: recent } = await supa.from('deal_messages')
      .select('id, content, direction').eq('contact_id', hit.id).gte('created_at', sinceIso).limit(20);
    if ((recent || []).some((r) => r.direction === direction && String(r.content || '').trim() === String(text).trim())) {
      return ok({ stored: false, reason: 'duplicate' });
    }

    const { error } = await supa.from('deal_messages').insert({
      contact_id:       hit.id,
      direction,
      channel:          'sms',
      content:          String(text),
      raw_phone_number: String(phone),
      status:           'active'
    });
    if (error) return ok({ stored: false, reason: error.message });

    await supa.from('leads').update({ last_contact_at: new Date().toISOString() }).eq('id', hit.id).then(() => {}, () => {});
    return ok({ stored: true, contact_id: hit.id, direction });
  } catch (e) {
    return ok({ stored: false, reason: e.message });
  }
}
