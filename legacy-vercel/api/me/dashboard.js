// api/me/dashboard.js
// GET /api/me/dashboard
//
// Buyer's personal dashboard payload. Identity comes from the session cookie
// only — never from a client-supplied id.
//
// Returns display-ready strings under a `dashboard` key so the painter in
// legacy-client.js can lift it straight into the matching [data-bind] /
// [data-list] DOM nodes:
//
//   Scalars:  buyer.*, nav.*, greeting.*, stats.*, brief.*, digest.*
//   Lists:    new_matches[], saved[], tours[], messages[], digest.items[],
//             alerts[], market[]
//
// All money is pre-formatted (e.g. "$685K"). All specs are pre-formatted
// (e.g. "3 bed · 2 bath · 1,840 sq ft").
//
// Match percentage uses a deterministic 100-point heuristic — no per-property
// Anthropic call. The digest letter (Sara's note to the buyer) is the only
// AI call on this endpoint, with a fail-soft fallback.

import { adminClient } from '../_lib/supabase.js';
import { getCallerProfile } from '../_lib/auth.js';
import { anthropicMessage } from '../_lib/anthropic.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';

// ---------------------------------------------------------------------------
// Formatting helpers — keep payload "paint-ready"
// ---------------------------------------------------------------------------
const fmtUSD = (n) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  const v = Math.abs(+n);
  if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000)     return `$${Math.round(+n / 1_000)}K`;
  return `$${Math.round(+n)}`;
};

const fmtRange = (min, max) => {
  if (min && max) return `${fmtUSD(min)} – ${fmtUSD(max)}`;
  if (min) return `${fmtUSD(min)}+`;
  if (max) return `Under ${fmtUSD(max)}`;
  return 'Open';
};

const fmtSpecs = (p) => {
  const bits = [];
  if (p.bedrooms)  bits.push(`${p.bedrooms} bed`);
  if (p.bathrooms) bits.push(`${p.bathrooms} bath`);
  if (p.sq_ft)     bits.push(`${(+p.sq_ft).toLocaleString()} sq ft`);
  if (!bits.length && p.lot_acres) bits.push(`${p.lot_acres} ac`);
  return bits.join(' · ') || '—';
};

const fmtBedsBaths = (min_b = 3, min_bath = 2) =>
  `${min_b}+ bed · ${min_bath}+ bath`;

const fmtRelative = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 60000;
  if (d < 1)    return 'just now';
  if (d < 60)   return `${Math.round(d)} min ago`;
  if (d < 1440) return `${Math.round(d/60)}h ago`;
  return `${Math.round(d/1440)}d ago`;
};

const fmtTourDate = (iso) => {
  if (!iso) return { dow: '', day: '', month: '', time: '' };
  const d = new Date(iso);
  return {
    dow:   d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day:   String(d.getDate()),
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    time:  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  };
};

const initialsOf = (first, last, fallback = '') => {
  const a = (first || '').trim()[0] || '';
  const b = (last  || '').trim()[0] || '';
  return (a + b).toUpperCase() || fallback.trim()[0]?.toUpperCase() || '?';
};

const sanitize = (s) => (s || '').replace(/[<>]/g, '');

// ---------------------------------------------------------------------------
// Match scoring (deterministic, no AI)
//   max 100:  price-band fit 40, area fit 30, beds 15, lot 15
// ---------------------------------------------------------------------------
function matchPct(lead, p) {
  let score = 0;

  // Price (40)
  if (p.price && lead.price_min && lead.price_max) {
    if (p.price >= lead.price_min && p.price <= lead.price_max) score += 40;
    else {
      const mid  = (lead.price_min + lead.price_max) / 2;
      const dist = Math.abs(p.price - mid) / mid;
      score += Math.max(0, Math.round(40 * (1 - dist)));
    }
  } else if (p.price && lead.price_max && p.price <= lead.price_max) {
    score += 30;
  } else {
    score += 20; // unknown budget — give partial credit
  }

  // Area (30)
  const areas = (lead.areas || []).map((a) => a.toLowerCase());
  if (areas.length && p.city && areas.includes(p.city.toLowerCase())) score += 30;
  else if (!areas.length) score += 15;

  // Beds (15)
  const wantBeds = parseInt(((lead.must_haves || []).find((m) => /\d+\s*bed/i.test(m)) || '').match(/\d+/)?.[0] || '3', 10);
  if (p.bedrooms && p.bedrooms >= wantBeds) score += 15;
  else score += 5;

  // Lot (15) — bias toward land lovers
  const wantsLand = (lead.must_haves || []).some((m) => /acre|land|lot|privacy/i.test(m));
  if (wantsLand && p.lot_acres && p.lot_acres >= 1) score += 15;
  else if (!wantsLand) score += 10;

  return Math.max(0, Math.min(100, score));
}

function statusForMatch(pct) {
  if (pct >= 85) return 'Strong match';
  if (pct >= 70) return 'Worth a look';
  if (pct >= 55) return 'Maybe';
  return 'Stretch';
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user) return fail(res, 401, 'not authenticated');

    const supa = adminClient();

    // 1. Resolve the buyer's lead record
    //    Prefer profile.lead_id if linked; otherwise match by auth email.
    let lead = null;
    if (profile?.lead_id) {
      const { data } = await supa.from('leads').select('*').eq('id', profile.lead_id).maybeSingle();
      lead = data || null;
    }
    if (!lead) {
      const { data } = await supa.from('leads')
        .select('*')
        .eq('email', (user.email || '').toLowerCase())
        .maybeSingle();
      lead = data || null;
    }

    // No lead yet — return a friendly empty payload the painter can handle.
    if (!lead) {
      return ok(res, {
        dashboard: emptyDashboard(user, profile)
      });
    }

    // Backfill profile.lead_id so subsequent requests skip the email lookup.
    if (profile && !profile.lead_id) {
      await supa.from('users').update({ lead_id: lead.id }).eq('id', user.id);
    }

    // 2. Pull everything in parallel
    const [savedRes, toursRes, msgsRes, candidatesRes, marketRes] = await Promise.all([
      supa.from('saved_properties')
          .select('id, tag, view_count, last_viewed_at, properties(*)')
          .eq('lead_id', lead.id)
          .order('last_viewed_at', { ascending: false })
          .limit(12),
      supa.from('tours')
          .select('id, scheduled_at, status, tour_type, properties(address, city)')
          .eq('lead_id', lead.id)
          .gte('scheduled_at', new Date().toISOString())
          .order('scheduled_at')
          .limit(6),
      supa.from('messages')
          .select('id, direction, channel, subject, body, status, created_at')
          .eq('lead_id', lead.id)
          .in('status', ['sent', 'delivered'])
          .eq('direction', 'outbound')
          .order('created_at', { ascending: false })
          .limit(6),
      supa.from('properties')
          .select('*')
          .eq('status', 'active')
          .limit(40),
      supa.from('properties')
          .select('city, price, status')
          .in('status', ['active', 'sold'])
    ]);

    const saved      = (savedRes.data       || []).filter((r) => r.properties);
    const tours      = toursRes.data        || [];
    const messages   = msgsRes.data         || [];
    const candidates = candidatesRes.data   || [];
    const marketRows = marketRes.data       || [];

    const savedPropertyIds = new Set(saved.map((s) => s.properties.id));

    // 3. Build new_matches — top 3 unsaved, in-area, in-budget actives, scored.
    const matched = candidates
      .filter((p) => !savedPropertyIds.has(p.id))
      .map((p) => ({ p, pct: matchPct(lead, p) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);

    const newMatchesArr = matched.map(({ p, pct }) => ({
      photo:        (p.photos && p.photos[0]) || null,
      score:        `${pct}% match`,
      status:       statusForMatch(pct),
      specs:        fmtSpecs(p),
      address:      sanitize(`${p.address || ''}${p.city ? `, ${p.city}` : ''}`),
      note:         pct >= 85 ? 'Hits your brief on price, area, and size.' : undefined,
      tags:         (p.features?.tags || []).slice(0, 3).map((label) => ({ label })),
      listing_url:  p.mls_number ? `/listing.html?mls=${encodeURIComponent(p.mls_number)}` : '/listing.html',
      _price:       p.price  // kept for digest.items lookup; painter ignores _-prefixed keys
    }));

    // 4. Build saved list with the tags the buyer assigned in CRM
    const savedArr = saved.slice(0, 8).map((s) => {
      const p = s.properties;
      const tagPills = [];
      if (s.tag === 'favorite')   tagPills.push({ label: 'Favorite' });
      if (s.tag === 'maybe')      tagPills.push({ label: 'Maybe' });
      if (s.tag === 'too_pricey') tagPills.push({ label: 'Too pricey' });
      if (s.tag === 'for_james')  tagPills.push({ label: 'For James' });
      return {
        photo:       (p.photos && p.photos[0]) || null,
        price:       fmtUSD(p.price),
        address:     sanitize(`${p.address || ''}${p.city ? `, ${p.city}` : ''}`),
        tags:        tagPills,
        listing_url: p.mls_number ? `/listing.html?mls=${encodeURIComponent(p.mls_number)}` : '/listing.html'
      };
    });

    // 5. Tours — pre-format date pieces for the calendar tile UI
    const toursArr = tours.map((t) => {
      const d = fmtTourDate(t.scheduled_at);
      const prop = t.properties || {};
      return {
        dow:      d.dow,
        day:      d.day,
        month:    d.month,
        time:     d.time,
        property: sanitize(prop.address || 'Property TBD'),
        location: sanitize(prop.city || '')
      };
    });

    // 6. Messages — surface outbound (Sara → buyer) recent notes
    const messagesArr = messages.map((m) => ({
      avatar: 'art/sara-headshot.png',
      from:   'Sara Cooper',
      time:   fmtRelative(m.created_at),
      body:   sanitize(m.subject ? `${m.subject} — ${m.body.slice(0, 220)}` : m.body.slice(0, 240))
    }));

    // 7. Market snapshot — median price by town across (active + sold)
    const marketArr = buildMarketSnapshot(marketRows, lead.areas);

    // 8. Stats counters
    const matchStrength = matched.length
      ? Math.round(matched.reduce((s, m) => s + m.pct, 0) / matched.length)
      : 0;

    // 9. AI digest letter (Sara's note to the buyer). Fail-soft.
    let digestLetter = `Quick note while you're here. I keep pulling listings that match what you told me — three new ones below. Tell me which ones spark a question or a flat no, and I'll narrow the next round. — Sara`;
    try {
      digestLetter = await draftDigest(lead, matched);
    } catch (_) { /* keep fallback copy */ }

    // 10. Assemble the dashboard payload — strict shape per the selector contract
    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || user.email;
    const firstName = lead.first_name || (user.email || '').split('@')[0] || 'there';

    const dashboard = {
      buyer: {
        initials: initialsOf(lead.first_name, lead.last_name, user.email),
        name:     fullName,
        meta:     `${(lead.lead_type || 'buyer').toString().replace(/^\w/, (c) => c.toUpperCase())} · ${lead.temperature || 'new'} · score ${lead.score ?? 0}`
      },
      nav: {
        new_matches: String(newMatchesArr.length),
        saved:       String(saved.length),
        tours:       String(tours.length),
        messages:    String(messages.length)
      },
      greeting: {
        eyebrow:    `${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · welcome back`,
        first_name: firstName,
        narrative:  buildGreetingNarrative(newMatchesArr.length, tours.length, messages.length)
      },
      stats: {
        saved_homes:     String(saved.length),
        new_matches:     String(newMatchesArr.length),
        tours_upcoming:  String(tours.length),
        match_strength:  matchStrength ? `${matchStrength}%` : '—'
      },
      brief: {
        price:           fmtRange(lead.price_min, lead.price_max),
        beds_baths:      fmtBedsBaths(),
        lot:             pickLot(lead.must_haves),
        areas:           (lead.areas || []).join(', ') || 'Open to ideas',
        must_haves:      (lead.must_haves    || []).slice(0, 4).join(', ') || '—',
        nice_to_haves:   pickNiceToHaves(lead.must_haves)
      },
      new_matches: newMatchesArr,
      saved:       savedArr,
      tours:       toursArr,
      messages:    messagesArr,
      digest: {
        letter:       digestLetter,
        agent_name:   'Sara Cooper',
        agent_title:  'Broker · Legacy Properties',
        agent_avatar: 'art/sara-headshot.png',
        items:        newMatchesArr.slice(0, 3).map((m) => ({
          price:       fmtUSD(m._price),
          address:     m.address,
          listing_url: m.listing_url
        }))
      },
      alerts: buildAlerts(lead),
      market: marketArr
    };

    return ok(res, { dashboard });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------
function emptyDashboard(user, profile) {
  const firstName = (user.email || '').split('@')[0] || 'there';
  return {
    buyer: {
      initials: initialsOf('', '', user.email),
      name:     user.email,
      meta:     'New buyer · setting up your brief'
    },
    nav: { new_matches: '0', saved: '0', tours: '0', messages: '0' },
    greeting: {
      eyebrow:    'Welcome to Legacy',
      first_name: firstName,
      narrative:  'Your brief is still empty. Reply to Sara to tell her what you are looking for and we will fill this in.'
    },
    stats: { saved_homes: '0', new_matches: '0', tours_upcoming: '0', match_strength: '—' },
    brief: {
      price: 'Open', beds_baths: '—', lot: '—',
      areas: '—', must_haves: '—', nice_to_haves: '—'
    },
    new_matches: [], saved: [], tours: [], messages: [],
    digest: {
      letter:       'Welcome in. Tell me what you are picturing — town, price, must-haves — and I will start sending the matches.',
      agent_name:   'Sara Cooper',
      agent_title:  'Broker · Legacy Properties',
      agent_avatar: 'art/sara-headshot.png',
      items:        []
    },
    alerts: [],
    market: []
  };
}

function buildGreetingNarrative(matchCount, tourCount, msgCount) {
  const bits = [];
  if (matchCount) bits.push(`${matchCount} fresh match${matchCount === 1 ? '' : 'es'} on your brief`);
  if (tourCount)  bits.push(`${tourCount} tour${tourCount === 1 ? '' : 's'} coming up`);
  if (msgCount)   bits.push(`${msgCount} new note${msgCount === 1 ? '' : 's'} from Sara`);
  if (!bits.length) return 'Nothing new since you were here. Sara is on it.';
  return bits.join(' · ') + '.';
}

function buildMarketSnapshot(rows, areas = []) {
  // Group by city, median active price, vs. median sold price (proxy for change).
  const by = {};
  for (const r of rows) {
    if (!r.city || !r.price) continue;
    by[r.city] = by[r.city] || { active: [], sold: [] };
    if (r.status === 'active') by[r.city].active.push(r.price);
    if (r.status === 'sold')   by[r.city].sold.push(r.price);
  }
  const med = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const out = [];
  const focus = new Set((areas || []).map((s) => s.toLowerCase()));
  for (const [city, v] of Object.entries(by)) {
    const active = med(v.active);
    const sold   = med(v.sold);
    if (!active && !sold) continue;
    const price = active || sold;
    let change = '';
    if (active && sold) {
      const delta = ((active - sold) / sold) * 100;
      change = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
    }
    out.push({ town: city, price: fmtUSD(price), change, _priority: focus.has(city.toLowerCase()) ? 1 : 0 });
  }
  return out.sort((a, b) => b._priority - a._priority).slice(0, 6).map(({ _priority, ...rest }) => rest);
}

function pickLot(mustHaves = []) {
  const lot = (mustHaves || []).find((m) => /acre|lot/i.test(m));
  return lot || '—';
}

function pickNiceToHaves(mustHaves = []) {
  if (!mustHaves || !mustHaves.length) return '—';
  return mustHaves.slice(4, 8).join(', ') || '—';
}

function buildAlerts(lead) {
  const out = [];
  if (lead.price_max) {
    out.push({
      title:   'Price drops on saved homes',
      rule:    `Notify when a saved home drops below ${fmtUSD(lead.price_max)}.`,
      enabled: true
    });
  }
  if ((lead.areas || []).length) {
    out.push({
      title:   'New listings in your towns',
      rule:    `Email me when a new home posts in ${lead.areas.join(', ')}.`,
      enabled: true
    });
  }
  out.push({
    title:   'Tour reminders',
    rule:    'Text me 2 hours before each scheduled tour.',
    enabled: true
  });
  return out;
}

async function draftDigest(lead, matched) {
  const SYSTEM = `You are writing a single short paragraph for Sara Cooper, Broker-Owner of Legacy Properties.
Voice: warm, direct, never salesy. Like a friend who happens to be a broker.
Short sentences. No exclamation points. No filler. No em-dashes. No markdown. No greeting fluff.
Hard rules:
1. Sara's phone is 209-559-4966. Never use a placeholder like [phone] or {{phone}}.
2. Do not repeat the same phrase, sentence, or idea twice.
3. If the recipient's first name is "Sara" (matches Sara's own name), open with "Hi," instead of "Hey Sara".
4. Output 3-4 short sentences. No salutation, no signoff. Plain prose.`;

  const matchLines = matched.length
    ? matched.map(({ p, pct }) => `  • ${p.address || 'Listing'} in ${p.city || '—'} — ${fmtUSD(p.price)} — ${pct}% match`).join('\n')
    : '  (none today)';

  const prompt = `Write the buyer's daily digest letter from Sara.
Recipient: ${lead.first_name || 'the buyer'} (lead type: ${lead.lead_type || 'buyer'}, journey: ${lead.journey_stage || 'unspecified'}).
Today's top matches I picked for them:
${matchLines}
The note should reference that you (Sara) handpicked these, invite one specific reply (yes / no / not sure), and stay under 90 words.`;

  const { text } = await anthropicMessage({
    system:      SYSTEM,
    messages:    [{ role: 'user', content: prompt }],
    max_tokens:  300,
    temperature: 0.65
  });
  return text.trim();
}
