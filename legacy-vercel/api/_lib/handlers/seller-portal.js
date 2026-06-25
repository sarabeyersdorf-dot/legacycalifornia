// api/_lib/handlers/seller-portal.js
// GET /api/seller/portal
//
// Returns the signed-in seller's portal payload in a fully paint-ready shape.
// Identity comes from the session cookie only — never from a client id.
//
// The payload mirrors the buyer dashboard contract (top-level scalars under
// dotted paths + named arrays for [data-list] sections):
//
//   Scalars: seller.*, listing.*, kpi.*, sara_note.*, pricing.*
//   Lists:   trend.bars[], offers[], showings[], comps[],
//            checklist[], documents[], activity[], sharing[]
//
// All money is pre-formatted ("$565K"); specs and dates are pre-formatted too.
//
// Manual entry stub for traffic: listing_stats rows keyed by property_id +
// brief_date. The IDX behavioural webhook (Phase 1I) will start writing
// directly to this table.

import { adminClient }      from '../supabase.js';
import { getCallerProfile, isAgent, isSeller } from '../auth.js';
import { anthropicMessage } from '../anthropic.js';
import { handleOptions, ok, fail } from '../cors.js';

// ---------------------------------------------------------------------------
// Formatters — keep payload "paint-ready"
// ---------------------------------------------------------------------------
const fmtUSD = (n) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  const v = Math.abs(+n);
  if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000)     return `$${Math.round(+n / 1_000)}K`;
  return `$${Math.round(+n)}`;
};

const fmtUSDFull = (n) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  return `$${Math.round(+n).toLocaleString('en-US')}`;
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const fmtMonthDay = (iso) => {
  if (!iso) return { dow: '', day: '' };
  const d = new Date(iso);
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
    day: String(d.getDate())
  };
};

const fmtTime = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

const fmtRelative = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 60000;
  if (d < 1)    return 'just now';
  if (d < 60)   return `${Math.round(d)} min ago`;
  if (d < 1440) return `${Math.round(d/60)} hr ago`;
  return `${Math.round(d/1440)} days ago`;
};

const initialsOf = (first, last, fallback = '') => {
  const a = (first || '').trim()[0] || '';
  const b = (last  || '').trim()[0] || '';
  return (a + b).toUpperCase() || fallback.trim()[0]?.toUpperCase() || '?';
};

const sanitize = (s) => (s || '').replace(/[<>]/g, '');

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const daysBetween = (a, b = new Date()) => {
  if (!a) return null;
  return Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
};

// ---------------------------------------------------------------------------
// Comp-set scoring — same city, sq_ft +/- 20%, status active/sold last 90 days
// ---------------------------------------------------------------------------
function buildComps(rows, listing) {
  const ninetyAgo = Date.now() - 90 * 86400000;
  const sqFt = listing.sq_ft || 0;
  const minSq = sqFt ? sqFt * 0.8 : 0;
  const maxSq = sqFt ? sqFt * 1.2 : Infinity;

  return rows
    .filter((p) => p.id !== listing.id)
    .filter((p) => (listing.city || '').toLowerCase() === (p.city || '').toLowerCase())
    .filter((p) => !sqFt || (p.sq_ft >= minSq && p.sq_ft <= maxSq))
    .filter((p) => {
      if (p.status === 'active') return true;
      if (p.status === 'pending') return true;
      if (p.status === 'sold') return new Date(p.updated_at || p.created_at).getTime() >= ninetyAgo;
      return false;
    })
    .slice(0, 8);
}

function statusPill(status, updatedIso) {
  if (status === 'active')  return { label: 'Active',  className: 'pill-status pill-new' };
  if (status === 'pending') return { label: 'Pending', className: 'pill-status pill-warm' };
  if (status === 'sold')    return { label: `Sold · ${fmtDate(updatedIso).split(' ')[0]}`, className: 'pill-status' };
  return { label: status || '—', className: 'pill-status' };
}

// ---------------------------------------------------------------------------
// AI note (Sara → seller). Fail-soft.
// ---------------------------------------------------------------------------
async function draftSellerNote(listing, ctx) {
  const SYSTEM = `You are writing a single short note from Sara Cooper, Broker-Owner of Legacy Properties, to her seller.
Voice: warm, direct, calm. Like a friend who happens to be a broker.
Short sentences. No exclamation points. No filler. No em-dashes. No markdown. No greeting fluff.
Hard rules:
1. Sara's phone is 209-559-4966. Never use a placeholder like [phone] or {{phone}}.
2. Do not repeat the same phrase, sentence, or idea twice.
3. If the recipient's first name is "Sara" (matches Sara's own name), open with "Hi," instead of "Hey Sara".
4. Output 3-5 short sentences. No salutation, no signoff. Plain prose.
5. Reference real numbers from the context only. Never invent showings, offers, or visitors.`;

  const prompt = `Write today's seller portal note from Sara.
Recipient: ${ctx.seller_first_name || 'the seller'}.
Listing: ${listing.address || 'their home'} in ${listing.city || ''}, listed at ${fmtUSDFull(listing.price)} (day ${ctx.day_on_market} on market).
Activity snapshot:
  - ${ctx.page_views} page views in the last 7 days
  - ${ctx.showings_total} total showings (${ctx.showings_upcoming} upcoming)
  - ${ctx.offers_count} written offer${ctx.offers_count === 1 ? '' : 's'} so far${ctx.leading_offer ? `; top offer at ${fmtUSDFull(ctx.leading_offer)}` : ''}
  - ${ctx.saves} saved by buyers
Keep it to 3-5 sentences. End with a concrete next step (e.g. an offer deadline, an open house, or a quick check-in).`;

  const { text } = await anthropicMessage({
    system:      SYSTEM,
    messages:    [{ role: 'user', content: prompt }],
    max_tokens:  320,
    temperature: 0.6
  });
  return text.trim();
}

// ---------------------------------------------------------------------------
// Empty payload (no property linked yet) — frontend painter handles this.
// ---------------------------------------------------------------------------
function emptyPortal(user, profile) {
  const first = (profile?.display_name || user?.email || '').split(' ')[0] || 'there';
  return {
    seller: {
      initials: initialsOf(profile?.display_name?.split(' ')[0] || '', profile?.display_name?.split(' ')[1] || '', user?.email),
      name:     profile?.display_name || user?.email || 'Seller',
      meta:     'Seller · listing not yet linked'
    },
    listing: {
      photo:          null,
      badge:          'Not yet listed',
      address_line1:  '—',
      address_line2:  '—',
      headline:       `Welcome, ${first}.`,
      headline_em:    'Your listing is being set up.',
      eyebrow:        'Seller portal · not yet live',
      beds:           '—',
      baths:          '—',
      sq_ft:          '—',
      lot_acres:      '—',
      year_built:     '—',
      status_label:   'Listed at',
      list_price:     '—',
      listed_since:   'Sara will publish your listing once paperwork clears.'
    },
    kpi: {
      page_views:     '0', page_views_change:     '—',
      unique_viewers: '0', unique_viewers_change: '—',
      saves:          '0', saves_change:          '—',
      showings:       '0', showings_change:       '—',
      offers:         '0', offers_change:         '—'
    },
    trend: { bars: [], axis_dates: [], legend_delta: '' },
    sara_note: {
      head: 'A note from Sara',
      body: 'Your listing portal will populate as soon as we go live on the MLS. In the meantime, you can reach me at (209) 559-4966.',
      sign: '— Sara · (209) 559-4966'
    },
    pricing: { your_psf: '—', avg_psf: '—', comp_count: '0' },
    offers: [],
    showings: [],
    comps: [],
    checklist: [],
    documents: [],
    activity: [],
    sharing: []
  };
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

    // Sellers and agents may read this endpoint.
    // (Agents see the portal for any seller they look up; for now this resolves
    // the agent's own session to no listing and returns empty.)
    if (!isSeller(profile) && !isAgent(profile)) {
      return fail(res, 403, 'sellers or agents only');
    }

    const supa = adminClient();

    // 1. Resolve the seller's lead
    let lead = null;
    if (profile?.lead_id) {
      const { data } = await supa.from('leads').select('*').eq('id', profile.lead_id).maybeSingle();
      lead = data || null;
    }
    if (!lead && user.email) {
      const { data } = await supa.from('leads')
        .select('*')
        .eq('email', user.email.toLowerCase())
        .maybeSingle();
      lead = data || null;
    }

    if (!lead) {
      return ok(res, { portal: emptyPortal(user, profile) });
    }

    // Backfill profile.lead_id so subsequent requests skip the email lookup.
    if (profile && !profile.lead_id) {
      await supa.from('users').update({ lead_id: lead.id }).eq('id', user.id);
    }

    // 2. Find the seller's listing (most recently created active/pending one)
    const { data: listings } = await supa
      .from('properties')
      .select('*')
      .eq('seller_lead_id', lead.id)
      .in('status', ['active', 'pending', 'sold'])
      .order('created_at', { ascending: false })
      .limit(1);

    const listing = (listings && listings[0]) || null;
    if (!listing) {
      return ok(res, { portal: emptyPortal(user, profile) });
    }

    // 3. Pull everything else in parallel
    const sevenAgo  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10);
    const twentyOne = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);

    const [statsRes, offersRes, toursRes, checklistRes, compsRes, activityRes] =
      await Promise.all([
        supa.from('listing_stats')
            .select('brief_date, page_views, unique_viewers, saves')
            .eq('property_id', listing.id)
            .gte('brief_date', twentyOne)
            .order('brief_date'),
        supa.from('offers')
            .select('id, created_at, amount, down_payment_pct, close_days, contingencies, status, lender, pre_approved, notes, buyer_lead_id, leads(first_name,last_name)')
            .eq('property_id', listing.id)
            .order('amount', { ascending: false, nullsFirst: false }),
        supa.from('tours')
            .select('id, scheduled_at, duration_minutes, tour_type, status, notes, leads(first_name,last_name)')
            .eq('property_id', listing.id)
            .order('scheduled_at', { ascending: false })
            .limit(20),
        supa.from('listing_checklist')
            .select('id, sort_order, label, due_label, completed_at')
            .eq('property_id', listing.id)
            .order('sort_order'),
        supa.from('properties')
            .select('id, address, city, price, sq_ft, lot_acres, year_built, status, created_at, updated_at, features')
            .or('status.eq.active,status.eq.pending,status.eq.sold'),
        supa.from('lead_events')
            .select('id, created_at, event_type, event_data')
            .eq('lead_id', lead.id)
            .order('created_at', { ascending: false })
            .limit(8)
      ]);

    const statsRows    = statsRes.data    || [];
    const offers       = offersRes.data   || [];
    const tours        = toursRes.data    || [];
    const checklist    = checklistRes.data || [];
    const compsAll     = compsRes.data    || [];
    const activityRows = activityRes.data || [];

    // 4. Documents from Supabase Storage (best-effort)
    let documents = [];
    try {
      const { data: files } = await supa.storage
        .from('seller-docs')
        .list(listing.id, { limit: 50, sortBy: { column: 'created_at', order: 'desc' } });
      if (files && files.length) {
        documents = await Promise.all(files.map(async (f) => {
          let url = null;
          try {
            const signed = await supa.storage
              .from('seller-docs')
              .createSignedUrl(`${listing.id}/${f.name}`, 60 * 60);
            url = signed?.data?.signedUrl || null;
          } catch (_) { /* ignore */ }
          const ext = (f.name.split('.').pop() || '').toUpperCase().slice(0, 4) || 'DOC';
          return {
            icon: ext,
            name: f.name.replace(/\.[^.]+$/, ''),
            sub:  f.created_at ? `Uploaded ${fmtDate(f.created_at)}` : '',
            url:  url || '#'
          };
        }));
      }
    } catch (_) { /* storage bucket may not exist yet */ }

    // 5. KPI rollups (page views = last 7 days sum; baseline = preceding 7 days)
    const today = new Date();
    const lastWeek  = statsRows.filter((r) => new Date(r.brief_date) >= new Date(today.getTime() -  7 * 86400000));
    const prevWeek  = statsRows.filter((r) => {
      const d = new Date(r.brief_date).getTime();
      return d >= today.getTime() - 14 * 86400000 && d < today.getTime() - 7 * 86400000;
    });
    const sum    = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const pv7    = sum(lastWeek, 'page_views');
    const pvPrev = sum(prevWeek, 'page_views');
    const uv7    = sum(lastWeek, 'unique_viewers');
    const uvPrev = sum(prevWeek, 'unique_viewers');
    const sv7    = sum(lastWeek, 'saves');
    const svPrev = sum(prevWeek, 'saves');
    const pctChange = (now, prev) => {
      if (!prev) return now ? '↑ new' : '—';
      const d = ((now - prev) / prev) * 100;
      const arrow = d >= 0 ? '↑' : '↓';
      return `${arrow} ${Math.abs(d).toFixed(0)}% vs prior week`;
    };

    const showingsTotal    = tours.length;
    const showingsUpcoming = tours.filter((t) => t.scheduled_at && new Date(t.scheduled_at) > today).length;
    const offerCount       = offers.length;
    const offerLead        = offers[0] || null;

    // 6. Trend bars — last 21 days, bars normalized to the max view count
    const dayMap = new Map(statsRows.map((r) => [r.brief_date, r.page_views || 0]));
    const bars = [];
    const axisDates = [];
    for (let i = 20; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      bars.push({ views: dayMap.get(key) || 0, _date: key });
    }
    const maxViews = Math.max(1, ...bars.map((b) => b.views));
    bars.forEach((b, idx) => {
      const pct = Math.round((b.views / maxViews) * 100);
      b.height = `${Math.max(2, pct)}%`;
      b.brass  = idx >= bars.length - 5 ? 'brass' : '';
      delete b._date;
    });
    const axisStep = 3;
    for (let i = 0; i < bars.length; i += axisStep) {
      const d = new Date(today.getTime() - (bars.length - 1 - i) * 86400000);
      axisDates.push(fmtDate(d.toISOString()));
    }
    const wow = pvPrev ? Math.round(((pv7 - pvPrev) / pvPrev) * 100) : null;
    const legendDelta = wow == null ? 'New listing — building baseline' : `${wow >= 0 ? '+' : ''}${wow}% week-over-week`;

    // 7. Offers list
    const topAmount = offerLead?.amount || 0;
    const offersArr = offers.slice(0, 6).map((o, idx) => {
      const buyer = [o.leads?.first_name, o.leads?.last_name].filter(Boolean).join(' ') || 'Anonymous · via listing agent';
      const contingencies = Array.isArray(o.contingencies) ? o.contingencies.join(' · ') : '';
      const detailBits = [];
      if (o.down_payment_pct) detailBits.push(`${o.down_payment_pct}% down`);
      if (o.close_days)       detailBits.push(`${o.close_days} day close`);
      if (o.lender)           detailBits.push(`Pre-approved ${o.lender}`);
      if (contingencies)      detailBits.push(contingencies);
      return {
        amount:       fmtUSDFull(o.amount),
        amount_short: fmtUSD(o.amount),
        buyer:        sanitize(buyer),
        detail:       sanitize(detailBits.join(' · ') || '—'),
        eyebrow:      `${idx === 0 ? 'Highest offer' : `Offer ${idx + 1}`} · ${fmtRelative(o.created_at)}`,
        status_label: o.status === 'received' && idx === 0 && o.amount === topAmount ? 'Strongest'
                    : o.status === 'received' ? 'At asking'
                    : (o.status || '—').replace(/^./, (c) => c.toUpperCase()),
        is_leading:   idx === 0
      };
    });

    // 8. Showings (next 8 by date desc, surfacing upcoming first)
    const showingsArr = tours
      .slice()
      .sort((a, b) => new Date(b.scheduled_at) - new Date(a.scheduled_at))
      .slice(0, 8)
      .map((t) => {
        const md = fmtMonthDay(t.scheduled_at);
        const buyerName = [t.leads?.first_name, t.leads?.last_name].filter(Boolean).join(' ');
        const isUpcoming = t.scheduled_at && new Date(t.scheduled_at) > today;
        return {
          dow:      md.dow,
          day:      md.day,
          time:     `${fmtTime(t.scheduled_at)} · ${t.duration_minutes || 30} min`,
          buyer:    sanitize(buyerName || (t.tour_type === 'video' ? 'Video tour · agent + buyer' : 'Buyer agent + 1')),
          agent:    sanitize(t.notes || (t.tour_type === 'video' ? 'Video showing' : 'In-person showing')),
          status:   isUpcoming ? 'Upcoming' : (t.status || 'Completed').replace(/^./, (c) => c.toUpperCase())
        };
      });

    // 9. Comp set
    const comps = buildComps(compsAll, listing);
    const compsArr = comps.map((p) => {
      const psf = p.sq_ft ? Math.round((p.price || 0) / p.sq_ft) : null;
      const sub = [p.year_built ? `Built ${p.year_built}` : null, p.lot_acres ? `${p.lot_acres} ac` : null].filter(Boolean).join(' · ');
      const sp  = statusPill(p.status, p.updated_at);
      return {
        address:        sanitize(p.address || '—'),
        sub:            sub || '—',
        price:          fmtUSDFull(p.price),
        sq_ft:          p.sq_ft ? p.sq_ft.toLocaleString() : '—',
        psf:            psf ? `$${psf}` : '—',
        days_on_market: String(daysBetween(p.created_at) ?? '—'),
        status_label:   sp.label,
        status_class:   sp.className
      };
    });

    const compPsfs   = comps.map((p) => p.sq_ft ? (p.price || 0) / p.sq_ft : null).filter(Boolean);
    const avgPsf     = compPsfs.length ? Math.round(compPsfs.reduce((s, x) => s + x, 0) / compPsfs.length) : null;
    const yourPsf    = listing.sq_ft ? Math.round((listing.price || 0) / listing.sq_ft) : null;

    // 10. Checklist
    const checklistArr = checklist.map((c) => ({
      label: c.label,
      when:  c.completed_at ? fmtDate(c.completed_at) : (c.due_label || 'Today'),
      done:  !!c.completed_at,
      done_class: c.completed_at ? 'done' : ''
    }));
    const doneCount = checklistArr.filter((c) => c.done).length;

    // 11. Activity (from lead_events + recent offer/tour rows)
    const activityArr = [];
    if (offerLead) {
      activityArr.push({
        dot_class: '',
        text_html: `<strong>Offer received</strong> — ${sanitize([offerLead.leads?.first_name, offerLead.leads?.last_name].filter(Boolean).join(' ') || 'buyer')} · ${fmtUSDFull(offerLead.amount)}`,
        when:      fmtRelative(offerLead.created_at)
      });
    }
    tours.slice(0, 2).forEach((t) => {
      activityArr.push({
        dot_class: 'ink',
        text_html: `${t.scheduled_at && new Date(t.scheduled_at) > today ? 'Showing scheduled' : 'Showing held'} — ${sanitize([t.leads?.first_name, t.leads?.last_name].filter(Boolean).join(' ') || 'buyer agent')}`,
        when:      fmtDate(t.scheduled_at)
      });
    });
    activityRows.slice(0, 4).forEach((e) => {
      activityArr.push({
        dot_class: 'faint',
        text_html: sanitize(`${(e.event_type || '').replace(/_/g, ' ')}${e.event_data?.note ? ` — ${e.event_data.note}` : ''}`),
        when:      fmtRelative(e.created_at)
      });
    });

    // 12. Sharing (owner + agent; expand later)
    const sellerName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || user.email;
    const sharing = [
      { name: sellerName, role: 'Primary · You', access: 'Owner' },
      { name: 'Sara Cooper', role: 'Your agent', access: 'Edit' }
    ];

    // 13. Listing hero strings
    const dayOnMarket = daysBetween(listing.created_at) || 0;
    const photo = (listing.photos && listing.photos[0]) || null;
    const headline    = `${listing.address || 'Your home'}.`;
    const headline_em = dayOnMarket > 0 && pv7 > 0
      ? 'Doing better than expected.'
      : dayOnMarket === 0 ? 'Live on the market.' : 'Holding steady.';

    // 14. AI seller note (fail-soft)
    let saraNote = `Your portal updates as activity comes in. Reach me at (209) 559-4966 any time.`;
    try {
      saraNote = await draftSellerNote(listing, {
        seller_first_name: lead.first_name,
        day_on_market:     dayOnMarket,
        page_views:        pv7,
        showings_total:    showingsTotal,
        showings_upcoming: showingsUpcoming,
        offers_count:      offerCount,
        leading_offer:     topAmount,
        saves:             sv7
      });
    } catch (_) { /* keep fallback */ }

    const portal = {
      seller: {
        initials: initialsOf(lead.first_name, lead.last_name, user.email),
        name:     sellerName,
        meta:     `SELLER · LIVE ${dayOnMarket} D`
      },
      listing: {
        photo:          photo,
        badge:          listing.status === 'active'  ? 'Active · Listed'
                       : listing.status === 'pending' ? 'Pending'
                       : listing.status === 'sold'    ? 'Sold' : '—',
        address_line1:  sanitize(listing.address || '—'),
        address_line2:  sanitize(`${listing.address || ''} · ${listing.city || ''}, ${listing.state || 'CA'} ${listing.zip || ''}${listing.mls_number ? ` · MLS #${listing.mls_number}` : ''}`),
        headline:       sanitize(headline),
        headline_em:    sanitize(headline_em),
        eyebrow:        `Your listing · Day ${dayOnMarket} on market`,
        beds:           listing.bedrooms != null  ? String(listing.bedrooms)  : '—',
        baths:          listing.bathrooms != null ? String(listing.bathrooms) : '—',
        sq_ft:          listing.sq_ft  ? listing.sq_ft.toLocaleString()      : '—',
        lot_acres:      listing.lot_acres != null ? String(listing.lot_acres) : '—',
        year_built:     listing.year_built != null ? String(listing.year_built) : '—',
        status_label:   'Listed at',
        list_price:     fmtUSDFull(listing.price),
        listed_since:   `Listed ${fmtDate(listing.created_at)} · ${(listing.price_history || []).length ? `${(listing.price_history || []).length} price update(s)` : 'No price drops yet'}`
      },
      kpi: {
        page_views:            String(pv7),
        page_views_change:     pctChange(pv7, pvPrev),
        unique_viewers:        String(uv7),
        unique_viewers_change: pctChange(uv7, uvPrev),
        saves:                 String(sv7),
        saves_change:          pctChange(sv7, svPrev),
        showings:              String(showingsTotal),
        showings_change:       `${showingsUpcoming} upcoming`,
        offers:                String(offerCount),
        offers_change:         topAmount ? `Best at ${fmtUSD(topAmount)}` : '—'
      },
      trend: {
        bars,
        axis_dates: axisDates,
        legend_delta: legendDelta
      },
      sara_note: {
        head: `A note from Sara · Sent ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        body: saraNote,
        sign: '— Sara · (209) 559-4966'
      },
      pricing: {
        your_psf:   yourPsf ? `$${yourPsf}` : '—',
        avg_psf:    avgPsf  ? `$${avgPsf}`  : '—',
        comp_count: String(comps.length),
        summary:    avgPsf && yourPsf
          ? `Avg sold $psf in segment: $${avgPsf}. You are priced at $${yourPsf}.`
          : 'Comp set is still building.'
      },
      offers:    offersArr,
      showings:  showingsArr,
      comps:     compsArr,
      checklist: checklistArr,
      checklist_summary: `Pre-listing · ${doneCount} of ${checklistArr.length || '—'}`,
      documents,
      activity:  activityArr,
      sharing
    };

    return ok(res, { portal });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
