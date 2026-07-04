// api/c/[token].js
// The ONE anonymous, client-facing route. No login. Access is gated entirely by
// the unguessable share_token, validated here before the service-role client
// touches anything. Only the collection's INCLUDED listings are ever revealed —
// the properties table is never exposed wholesale to anon callers.
//
//   GET  /api/c/:token                         → branded collection payload (+ logs an 'open')
//   POST /api/c/:token { op:'react', ... }      → record a client reaction
//   POST /api/c/:token { op:'event', ... }      → record view / dwell telemetry
//   POST /api/c/:token { op:'valuation', ... }  → AI preliminary valuation (Feature 4)
//
// Feature 4 is rate-limited (3/day per email or phone), honeypot + timing bot-
// checked, fails soft (always captures the seller lead + alerts the agent even
// if the AI call is unavailable), and NEVER emits anything read as an appraisal.

import { adminClient } from '../_lib/supabase.js';
import { anthropicJSON } from '../_lib/anthropic.js';
import { sendSMS } from '../_lib/twilio.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';
import { shapeListing } from '../_lib/handlers/curate-search.js';

const BROKERAGE = { name: 'Legacy Properties', broker: 'Sara Cooper', broker_title: 'Broker-Owner', broker_dre: '02141987' };
const VAL_MODEL = 'claude-sonnet-4-6';           // matches api/_lib/anthropic.js default
const RATE_PER_DAY = 3;
const MIN_ELAPSED_MS = 1200;                     // faster than this ≈ a bot

const fmtUSDfull = (n) => (n == null || !Number.isFinite(+n)) ? '—' : '$' + Math.round(+n).toLocaleString('en-US');

function disclaimer(agentName, dre) {
  const who = dre ? `${agentName}, DRE #${dre}` : agentName;
  return `Listing information is deemed reliable but not guaranteed. Any price range, valuation, or opinion provided here is preliminary. ${who} must personally view a property to provide a truly accurate listing or valuation price range. ${BROKERAGE.name} | ${BROKERAGE.broker}, ${BROKERAGE.broker_title} | DRE #${BROKERAGE.broker_dre}`;
}

async function loadCollection(supa, token) {
  if (!token || !/^[a-f0-9]{24,}$/i.test(token)) return null;
  const { data } = await supa
    .from('curated_collections')
    .select('*, leads(first_name)')
    .eq('share_token', token).maybeSingle();
  if (!data) return null;
  if (data.status !== 'active') return { gone: true };
  if (data.expires_at && new Date(data.expires_at) < new Date()) return { gone: true };
  return data;
}

async function agentIdentity(supa, agentKey) {
  const { data } = await supa.from('agents').select('name, title, dre_number, phone, email, photo_url').eq('agent_key', agentKey).maybeSingle();
  return data || { name: agentKey === 'james' ? 'James Beyersdorf' : 'Sara Cooper', title: 'Agent', dre_number: null, phone: null, email: null, photo_url: null };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const token = req.query?.token;
  const supa = adminClient();

  try {
    const coll = await loadCollection(supa, token);
    if (!coll)        return fail(res, 404, 'collection not found');
    if (coll.gone)    return fail(res, 410, 'this collection link is no longer active');

    if (req.method === 'GET')  return view(supa, coll, res);
    if (req.method === 'POST') {
      const b = await readJson(req);
      const op = b?.op;
      if (op === 'react')     return react(supa, coll, b, res);
      if (op === 'event')     return event(supa, coll, b, res);
      if (op === 'valuation') return valuation(supa, coll, b, res);
      return fail(res, 400, `unknown op: ${op}`);
    }
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---- GET: branded payload --------------------------------------------------
async function view(supa, coll, res) {
  const agent = await agentIdentity(supa, coll.agent);

  const { data: cls } = await supa
    .from('collection_listings')
    .select('*, properties(*)')
    .eq('collection_id', coll.id).eq('included', true)
    .order('priority', { ascending: false })
    .order('sort_order', { ascending: true });

  const listings = (cls || [])
    .filter((row) => row.properties)
    .map((row) => ({
      ...shapeListing(row.properties),
      agent_note: row.agent_note || '',
      note_style: row.note_style || 'sticky',
      why_note: row.why_note || '',
      priority: !!row.priority
    }));

  // fire-and-forget open event
  supa.from('collection_events').insert({ collection_id: coll.id, event_type: 'open', meta: {} }).then(() => {}, () => {});

  return ok(res, {
    collection: { title: coll.title || '', intro_note: coll.intro_note || '', closing_note: coll.closing_note || '' },
    client: { first_name: coll.leads?.first_name || '' },
    agent: {
      name: agent.name, title: agent.title, dre_number: agent.dre_number,
      phone: agent.phone, email: agent.email, photo_url: agent.photo_url
    },
    brokerage: BROKERAGE,
    disclaimer: disclaimer(agent.name, agent.dre_number),
    listings,
    valuation: { enabled: true }
  });
}

// ---- POST react ------------------------------------------------------------
async function react(supa, coll, b, res) {
  const REACTIONS = ['love', 'not_for_me', 'tell_me_more', 'want_to_see'];
  if (!REACTIONS.includes(b?.reaction)) return fail(res, 400, `reaction must be one of ${REACTIONS.join(', ')}`);
  const row = {
    collection_id: coll.id,
    property_id: b?.property_id || null,
    reaction: b.reaction,
    comment: typeof b?.comment === 'string' ? b.comment.slice(0, 1000) : null,
    client_label: typeof b?.client_label === 'string' ? b.client_label.slice(0, 120) : (coll.leads?.first_name || null)
  };
  const { error } = await supa.from('collection_reactions').insert(row);
  if (error) return fail(res, 500, error.message);
  supa.from('collection_events').insert({
    collection_id: coll.id, property_id: row.property_id,
    event_type: 'reaction', meta: { reaction: row.reaction }
  }).then(() => {}, () => {});
  return ok(res, { recorded: true });
}

// ---- POST event (view / dwell) ---------------------------------------------
async function event(supa, coll, b, res) {
  const TYPES = ['listing_view', 'dwell', 'valuation_open'];
  if (!TYPES.includes(b?.event_type)) return fail(res, 400, `event_type must be one of ${TYPES.join(', ')}`);
  const row = {
    collection_id: coll.id,
    property_id: b?.property_id || null,
    event_type: b.event_type,
    dwell_ms: Number.isFinite(+b?.dwell_ms) ? Math.max(0, Math.min(+b.dwell_ms, 3_600_000)) : null,
    meta: (b && typeof b.meta === 'object' && b.meta) ? b.meta : {}
  };
  const { error } = await supa.from('collection_events').insert(row);
  if (error) return fail(res, 500, error.message);
  return ok(res, { recorded: true });
}

// ---- POST valuation (Feature 4) --------------------------------------------
async function valuation(supa, coll, b, res) {
  // Bot checks
  if (b?.company) return ok(res, { received: true });                       // honeypot filled → silently accept, do nothing
  if (Number.isFinite(+b?.elapsed_ms) && +b.elapsed_ms < MIN_ELAPSED_MS) return fail(res, 429, 'please take a moment and try again');

  const address = (b?.address || '').toString().trim();
  const email   = (b?.email || '').toString().trim().toLowerCase();
  const phone   = (b?.phone || '').toString().trim();
  if (!address)          return fail(res, 400, 'address is required');
  if (!email && !phone)  return fail(res, 400, 'an email or phone is required so we can reach you');

  // Rate limit: 3/day per email or phone
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const ors = [];
  if (email) ors.push(`email.eq.${email}`);
  if (phone) ors.push(`phone.eq.${phone}`);
  const { count: recent } = await supa.from('valuation_requests')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .or(ors.join(','));
  if ((recent || 0) >= RATE_PER_DAY) return fail(res, 429, "you've reached today's limit — we'll be in touch soon");

  const city = (b?.city || '').toString().trim();
  const zip  = (b?.zip || '').toString().trim();
  const sqft = Number.isFinite(+b?.sqft) ? +b.sqft : null;
  const beds = Number.isFinite(+b?.beds) ? +b.beds : null;
  const baths = Number.isFinite(+b?.baths) ? +b.baths : null;
  const condition = (b?.condition || '').toString().trim() || null;
  const special = (b?.notes || '').toString().slice(0, 1000) || null;

  // ---- Pull comps -----------------------------------------------------
  let cq = supa.from('properties')
    .select('address, city, zip, price, bedrooms, bathrooms, sq_ft, status, year_built, property_type')
    .in('status', ['active', 'pending', 'sold'])
    .not('price', 'is', null);
  if (zip && city)      cq = cq.or(`zip.eq.${zip},city.ilike.%${city}%`);
  else if (zip)         cq = cq.eq('zip', zip);
  else if (city)        cq = cq.ilike('city', `%${city}%`);
  if (sqft) cq = cq.gte('sq_ft', Math.round(sqft * 0.75)).lte('sq_ft', Math.round(sqft * 1.25));
  const { data: pool } = await cq.limit(25);

  let comps = (pool || []);
  if (sqft) comps = comps.sort((a, bb) => Math.abs((a.sq_ft || 0) - sqft) - Math.abs((bb.sq_ft || 0) - sqft));
  comps = comps.slice(0, 6).map((c) => ({
    address: c.address, city: c.city, price: c.price, beds: c.bedrooms, baths: c.bathrooms,
    sqft: c.sq_ft, status: c.status, ppsf: (c.price && c.sq_ft) ? Math.round(c.price / c.sq_ft) : null
  }));

  const agent = await agentIdentity(supa, coll.agent);

  // ---- AI range (fail-soft) ------------------------------------------
  let range_low = null, range_high = null, narrative = '';
  try {
    const ai = await runValuationAI({ address, city, zip, sqft, beds, baths, condition, special, comps, agentName: agent.name });
    range_low = ai.range_low; range_high = ai.range_high; narrative = ai.narrative;
  } catch (_) {
    narrative = `Thank you — I have your details for ${address}. I'll pull the most recent comparable sales myself and send you a preliminary range shortly.`;
  }

  // ---- Store the request (a seller lead) -----------------------------
  const { data: saved } = await supa.from('valuation_requests').insert({
    agent: coll.agent, collection_id: coll.id,
    name: (b?.name || '').toString().slice(0, 160) || null,
    email: email || null, phone: phone || null,
    address, city: city || null, zip: zip || null,
    beds, baths, sqft, condition, notes: special,
    range_low, range_high, comps, model: (range_low != null ? VAL_MODEL : null), status: 'new'
  }).select('id').single();

  // ---- Alert the agent (hot seller lead) — fail-soft -----------------
  try {
    if (agent.phone) {
      const rangeStr = (range_low != null && range_high != null) ? ` (${fmtUSDfull(range_low)}–${fmtUSDfull(range_high)})` : '';
      await sendSMS({ to: agent.phone, body: `New valuation request${rangeStr}: ${address}. ${b?.name || 'A client'} · ${email || phone}. — Legacy` });
    }
  } catch (_) { /* never block the client on the alert */ }

  supa.from('collection_events').insert({ collection_id: coll.id, event_type: 'valuation_open', meta: { address } }).then(() => {}, () => {});

  return ok(res, {
    received: true,
    request_id: saved?.id || null,
    range_low, range_high,
    range_label: (range_low != null && range_high != null) ? `${fmtUSDfull(range_low)} – ${fmtUSDfull(range_high)}` : null,
    narrative,
    comps_used: comps.length,
    preliminary: true,
    disclaimer: disclaimer(agent.name, agent.dre_number)
  });
}

async function runValuationAI({ address, city, zip, sqft, beds, baths, condition, special, comps, agentName }) {
  const SYSTEM = `You are a real estate assistant writing a PRELIMINARY market perspective for a homeowner, in the warm, plain-spoken voice of ${agentName} at Legacy Properties.
Hard rules:
1. Output a preliminary RANGE, never a single number.
2. This is a preliminary market perspective, NOT an appraisal or a formal opinion of value. Say so.
3. Explain the 3-4 comparable homes that drive the range in warm, plain English a non-expert understands.
4. Stay conservative. When unsure, widen the range rather than overpromise.
5. Do not invent comps or facts. Use only the comparable homes provided.
6. No markdown, no bullet points, no exclamation points. 2 short paragraphs maximum.
Return ONLY JSON: {"range_low": <int dollars>, "range_high": <int dollars>, "narrative": "<= 130 words"}.`;
  const compLines = comps.length
    ? comps.map((c, i) => `${i + 1}. ${c.address || 'nearby home'} — ${c.status}, ${c.beds ?? '?'}bd/${c.baths ?? '?'}ba, ${c.sqft ?? '?'} sqft, ${c.price != null ? '$' + c.price.toLocaleString('en-US') : 'n/a'}${c.ppsf ? ' ($' + c.ppsf + '/sqft)' : ''}`).join('\n')
    : '(no close comparables found in the database yet)';
  const prompt = `Homeowner's property:
Address: ${address}${city ? ', ' + city : ''}${zip ? ' ' + zip : ''}
Approx size: ${sqft ? sqft + ' sqft' : 'unknown'}; beds ${beds ?? '?'}; baths ${baths ?? '?'}; condition: ${condition || 'unspecified'}.
Anything special: ${special || 'none noted'}.

Comparable homes from our database:
${compLines}

Write the preliminary range and explanation now.`;
  const { json } = await anthropicJSON({
    model: VAL_MODEL, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500, temperature: 0.4
  });
  const low  = Math.round(Number(json.range_low));
  const high = Math.round(Number(json.range_high));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) throw new Error('bad AI range');
  return { range_low: low, range_high: high, narrative: String(json.narrative || '').trim() };
}
