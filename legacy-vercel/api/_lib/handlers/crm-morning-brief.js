// api/_lib/handlers/crm-morning-brief.js
// GET /api/crm/morning-brief
//
// Returns Sara's daily snapshot:
//   - drafts:        messages with status='pending_approval' (the "Five quiet asks")
//   - tours_today:   tours scheduled in the next 24 hours
//   - radio_silence: leads with last_contact_at older than 14 days
//   - new_today:     leads created in the last 24 hours
//   - active_deals:  open offers grouped by status
//   - narrative:     AI-generated brief paragraph in Sara's voice
//
// Agents only. The auth gate is enforced at the route level; this handler
// still defends with getCallerProfile() so it's safe even if mis-mounted.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { anthropicMessage } from '../anthropic.js';
import { handleOptions, ok, fail } from '../cors.js';

// Agent-aware brief voice — the narrative addresses whoever is signed in, in
// their own second person, never a hardcoded name. James must never read a
// brief written as Sara.
function briefSystem(agentKey) {
  const who = agentKey === 'james'
    ? 'James Beyersdorf, an agent at Legacy Properties in Angels Camp, CA'
    : 'Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA';
  return `You are writing a one-paragraph morning brief for ${who}.
Write in the second person ("you") — this is their own brief. Never sign it or refer to them in the third person; never mention the other agent by name.
Voice: warm, direct, conversational. Like a smart assistant who reads their data.
Short sentences. No exclamation points. No filler. Lead with the most important signal.
Never invent details — only reference numbers and names provided.
Output plain prose only, 3-5 sentences, no markdown.`;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    const now  = new Date();
    const dayAgo  = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const twoWk   = new Date(now.getTime() - 14 * 86400 * 1000).toISOString();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const weekAhead = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();
    const ninetyAgo = new Date(now.getTime() - 90 * 86400 * 1000).toISOString();
    const endOfDay  = new Date(now.toISOString().slice(0, 10) + 'T23:59:59Z').toISOString();
    const startOfDay = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();

    const SIGNAL_EVENT_TYPES = [
      'property_saved','property_viewed','search_run',
      'form_submitted','email_opened','sms_replied','score_change','portal_message'
    ];

    const [drafts, toursToday, radioSilence, newToday, openOffers,
           leadsTotal, clientsCount, pastClientsCount, activeListings, calendarWeek,
           overnightEvents, activeDealsLeads, hoursTours,
           funnelNew, funnelEngaged, funnelToured, funnelOffered, funnelClosed] = await Promise.all([
      supa.from('messages')
          .select('id, lead_id, channel, subject, body, ai_draft_reasoning, created_at, leads(first_name,last_name,email,temperature,score)')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(10),
      supa.from('tours')
          .select('id, scheduled_at, tour_type, status, leads(first_name,last_name), properties(address,city)')
          .gte('scheduled_at', now.toISOString())
          .lte('scheduled_at', tomorrow)
          .order('scheduled_at'),
      supa.from('leads')
          .select('id, first_name, last_name, email, temperature, score, last_contact_at')
          .eq('status', 'active')
          .lt('last_contact_at', twoWk)
          .order('last_contact_at')
          .limit(10),
      supa.from('leads')
          .select('id, first_name, last_name, email, source, journey_stage, score, temperature, created_at')
          .gte('created_at', dayAgo)
          .order('created_at', { ascending: false }),
      supa.from('offers')
          .select('id, status, amount, property_id, properties(address,city), buyer_lead_id, leads(first_name,last_name), created_at')
          .in('status', ['received','countered']),
      // Roster counts
      supa.from('leads')     .select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supa.from('leads')     .select('id', { count: 'exact', head: true }).eq('status', 'active').in('pipeline_stage', ['closed','close']),
      supa.from('leads')     .select('id', { count: 'exact', head: true }).eq('status', 'archived').in('pipeline_stage', ['closed','close']),
      supa.from('properties').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supa.from('tours')     .select('id', { count: 'exact', head: true }).gte('scheduled_at', now.toISOString()).lte('scheduled_at', weekAhead),
      // Overnight signals — last 24h of high-signal events
      supa.from('lead_events')
          .select('id, event_type, event_data, created_at, leads(id,first_name,last_name)')
          .in('event_type', SIGNAL_EVENT_TYPES)
          .gte('created_at', dayAgo)
          .order('created_at', { ascending: false })
          .limit(20),
      // Active deals — leads currently touring / under offer / about to close
      supa.from('leads')
          .select('id, first_name, last_name, pipeline_stage, price_min, price_max, score, temperature, updated_at')
          .eq('status', 'active')
          .in('pipeline_stage', ['touring', 'offer', 'close'])
          .order('updated_at', { ascending: false })
          .limit(6),
      // Today's hours — all tours scheduled today, regardless of status
      supa.from('tours')
          .select('id, scheduled_at, duration_minutes, tour_type, status, notes, leads(first_name,last_name), properties(address,city)')
          .gte('scheduled_at', startOfDay)
          .lte('scheduled_at', endOfDay)
          .order('scheduled_at'),
      // 90-day funnel
      supa.from('leads')      .select('id', { count: 'exact', head: true }).gte('created_at',  ninetyAgo),
      supa.from('lead_events').select('lead_id', { count: 'exact', head: true }).gte('created_at',  ninetyAgo).in('event_type', ['email_opened','sms_replied','property_viewed','property_saved']),
      supa.from('tours')      .select('lead_id', { count: 'exact', head: true }).gte('scheduled_at', ninetyAgo),
      supa.from('offers')     .select('buyer_lead_id', { count: 'exact', head: true }).gte('created_at', ninetyAgo),
      supa.from('leads')      .select('id', { count: 'exact', head: true }).in('pipeline_stage', ['closed','close']).gte('updated_at', ninetyAgo)
    ]);

    // "Deals in motion" = live transactions only: open OFFERS + in-escrow
    // (PENDING). On-market listings are NOT deals in motion — they live in the
    // Deals & Offers view. Scoped per agent: James sees his deals; the
    // broker-owner (Sara / admin) sees the whole brokerage.
    let dealsQ = supa
      .from('deals')
      .select('source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, listing_meta')
      .in('stage', ['offer', 'pending'])
      .order('coe_date', { ascending: true, nullsFirst: false })
      .limit(8);
    if (profile.role === 'agent_james') dealsQ = dealsQ.eq('agent', 'james');
    const { data: dealsInMotion } = await dealsQ;

    const result = {
      drafts:        drafts.data        || [],
      tours_today:   toursToday.data    || [],
      radio_silence: radioSilence.data  || [],
      new_today:     newToday.data      || [],
      open_offers:   openOffers.data    || [],
      roster: {
        leads_total:     leadsTotal.count     || 0,
        clients:         clientsCount.count   || 0,
        past_clients:    pastClientsCount.count || 0,
        active_listings: activeListings.count || 0,
        today_count:     (drafts.data || []).length + (toursToday.data || []).length,
        inbox_count:     (drafts.data || []).length,
        calendar_week:   calendarWeek.count   || 0,
        pipeline_count:  leadsTotal.count     || 0
      },
      signals:      shapeSignals(overnightEvents.data || []),
      active_deals: shapeDealsInMotion(dealsInMotion || []),
      hours:        shapeHours(hoursTours.data || [], now),
      funnel: {
        new_leads: funnelNew.count     || 0,
        engaged:   funnelEngaged.count || 0,
        toured:    funnelToured.count  || 0,
        offered:   funnelOffered.count || 0,
        closed:    funnelClosed.count  || 0
      }
    };

    // Phase 2C — Recent Communications (Twilio deal inbox). Active messages from
    // the last 24h, grouped by contact, plus a count of items still awaiting
    // triage. Kept OUTSIDE the main Promise.all and fail-soft so the brief still
    // loads if deal_messages hasn't been migrated yet or is empty.
    // Curated follow-ups — active client collections pushed 3+ days ago with
    // no reaction since. Surfaced both as data and as an overnight signal so
    // the Today view shows them without any extra front-end plumbing.
    // Fail-soft: the brief must load even if the curate tables are missing.
    result.collection_nudges = [];
    try {
      const { data: colls } = await supa
        .from('curated_collections')
        .select('id, title, share_token, client_lead_id, updated_at, leads(first_name,last_name)')
        .eq('status', 'active')
        .not('client_lead_id', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(8);
      for (const c of (colls || [])) {
        const { data: pushRows } = await supa.from('messages')
          .select('created_at')
          .eq('lead_id', c.client_lead_id).eq('direction', 'outbound')
          .ilike('body', `%${c.share_token}%`)
          .order('created_at', { ascending: false }).limit(1);
        const pushedAt = pushRows && pushRows[0] ? pushRows[0].created_at : null;
        if (!pushedAt) continue;
        const days = Math.floor((Date.now() - new Date(pushedAt).getTime()) / 86400000);
        if (days < 3) continue;
        const { count: rx } = await supa.from('collection_reactions')
          .select('id', { count: 'exact', head: true })
          .eq('collection_id', c.id).gte('created_at', pushedAt);
        if ((rx || 0) > 0) continue;
        const { count: opensSince } = await supa.from('collection_events')
          .select('id', { count: 'exact', head: true })
          .eq('collection_id', c.id).eq('event_type', 'open').gte('created_at', pushedAt);
        const clientName = c.leads ? [c.leads.first_name, c.leads.last_name].filter(Boolean).join(' ') : 'Your client';
        const nudge = {
          collection_id: c.id, title: c.title || 'collection',
          client_name: clientName, days_since_push: days,
          opens_since_push: opensSince || 0, pushed_at: pushedAt
        };
        result.collection_nudges.push(nudge);
        result.signals.unshift({
          id: `nudge:${c.id}`, lead_id: c.client_lead_id,
          time_iso: pushedAt, time: `${days}d ago`,
          body: `${clientName} hasn't reacted to “${nudge.title}” — pushed ${days} days ago${(opensSince || 0) ? ` (opened ${opensSince}× since)` : ' (not opened yet)'} . Worth a nudge.`,
          tag: 'Follow up'
        });
      }
    } catch (_) { /* nudges are a bonus, never a blocker */ }

    // Your own notes from the last 24h join the live feed, so a thought jotted
    // on a lead is visible on Today immediately. Fail-soft.
    try {
      const { data: notes } = await supa.from('lead_notes')
        .select('id, body, created_at, is_internal, leads(first_name,last_name)')
        .gte('created_at', dayAgo)
        .order('created_at', { ascending: false })
        .limit(8);
      for (const n of (notes || [])) {
        const who = n.leads ? [n.leads.first_name, n.leads.last_name].filter(Boolean).join(' ') : 'a lead';
        result.signals.unshift({
          id: `note:${n.id}`, lead_id: null,
          time_iso: n.created_at, time: formatClock(n.created_at),
          body: `You noted on ${who}: “${(n.body || '').slice(0, 110)}${(n.body || '').length > 110 ? '…' : ''}”`,
          tag: n.is_internal ? 'Internal note' : 'Your note'
        });
      }
      result.signals.sort((a, b) => String(b.time_iso || '').localeCompare(String(a.time_iso || '')));
    } catch (_) { /* notes are a bonus */ }

    // Timeline updates awaiting approval — filed by the daily scan / Cowork,
    // applied to the seller-facing timeline ONLY when the agent approves.
    result.timeline_approvals = [];
    try {
      const { data: props } = await supa
        .from('deal_timeline_proposals')
        .select('id, deal_id, item_key, address, change, reason, source, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(12);
      result.timeline_approvals = props || [];
    } catch (_) { /* table may not exist yet — brief must load */ }

    result.recent_comms = [];
    result.review_pending_count = 0;
    try {
      const dayAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [{ data: comms }, { count: pending }] = await Promise.all([
        supa.from('deal_messages')
          .select('id, contact_id, direction, channel, content, call_duration_seconds, created_at, leads(first_name,last_name)')
          .eq('status', 'active')
          .gte('created_at', dayAgoIso)
          .order('created_at', { ascending: false }),
        supa.from('deal_messages')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending_review')
      ]);
      result.recent_comms = shapeRecentComms(comms || []);
      result.review_pending_count = pending || 0;
    } catch (_) { /* table absent / transient — leave empty, never break the brief */ }

    // Phase 2D follow-up — surface mailboxes whose Gmail connection needs to be
    // redone (testing-mode OAuth app => refresh tokens for test users expire
    // periodically). The Settings card shows this too, but the morning brief is
    // the channel the owner actually reads daily, so this is the more reliable
    // place to catch it. Kept OUTSIDE the main Promise.all and fail-soft, same
    // pattern as recent_comms above — the brief must load even if this lookup
    // errors or the columns aren't there yet.
    let reconnectOwners = [];
    try {
      const { data: flagged } = await supa
        .from('email_accounts')
        .select('owner')
        .eq('needs_reconnect', true);
      reconnectOwners = (flagged || []).map((r) => r.owner);
    } catch (_) { /* never break the brief over an email-status lookup */ }

    // Look for today's cached brief first. Refresh narrative if older than 4h.
    const agent = profile.role === 'agent_james' ? 'james' : 'sara';

    // Scope the outward-facing field to the calling agent's own mailbox only —
    // never leak the other agent's owner name in the API response, mirroring
    // the "never surface James's status in Sara's brief or vice versa" rule
    // used for the narrative below.
    result.email_reconnect_needed = reconnectOwners.includes(agent) ? [agent] : [];
    const today = new Date().toISOString().slice(0, 10);
    const { data: cached } = await supa
      .from('briefs')
      .select('*')
      .eq('agent', agent)
      .eq('brief_date', today)
      .maybeSingle();

    const cacheFresh = cached && cached.narrative &&
      (Date.now() - new Date(cached.updated_at).getTime()) < 4 * 3600 * 1000;

    if (cacheFresh) {
      result.narrative      = cached.narrative;
      result.narrative_from = 'cache';
      return ok(res, result);
    }

    // Generate the narrative — fail soft so the panel still works if Anthropic is down.
    try {
      // Only mention a reconnect if it's the reading agent's OWN mailbox —
      // never surface James's connection status in Sara's brief or vice versa.
      const emailReconnectSelf = result.email_reconnect_needed.includes(agent);
      const ctx = {
        draft_count:        result.drafts.length,
        tours_today_count:  result.tours_today.length,
        radio_silence_count: result.radio_silence.length,
        new_today_count:    result.new_today.length,
        open_offer_count:   result.open_offers.length,
        sample_new_lead:    result.new_today[0]?.first_name || null,
        sample_radio_lead:  result.radio_silence[0]?.first_name || null,
        email_reconnect_needed: emailReconnectSelf
      };
      const userPrompt = `Today is ${now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}.
Snapshot for ${agent === 'sara' ? 'Sara' : 'James'}:
  ${ctx.draft_count} draft message(s) awaiting your approval
  ${ctx.tours_today_count} tour(s) on today's calendar
  ${ctx.new_today_count} new lead(s) in the past 24 hours${ctx.sample_new_lead ? ' (latest: ' + ctx.sample_new_lead + ')' : ''}
  ${ctx.radio_silence_count} lead(s) with no contact in 14+ days${ctx.sample_radio_lead ? ' (e.g. ' + ctx.sample_radio_lead + ')' : ''}
  ${ctx.open_offer_count} open offer(s) in negotiation${emailReconnectSelf ? '\n  Your Gmail connection has expired — email sync is paused until you reconnect it from Settings' : ''}
Write the brief paragraph now. Lead with the most important signal${emailReconnectSelf ? ' — the expired Gmail connection is important and should be mentioned' : ''}.`;
      const { text } = await anthropicMessage({
        system: briefSystem(agent),
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 400,
        temperature: 0.6
      });
      result.narrative      = text.trim();
      result.narrative_from = 'fresh';

      // Persist (upsert) so subsequent reloads hit the cache
      await supa.from('briefs').upsert({
        agent,
        brief_date: today,
        narrative:  result.narrative,
        snapshot:   ctx,
        updated_at: new Date().toISOString()
      }, { onConflict: 'agent,brief_date' });
    } catch (e) {
      result.narrative = cached?.narrative || null;
      result.narrative_error = e.message;
      result.narrative_from = cached?.narrative ? 'stale_cache' : 'none';
    }

    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}


// ---------------------------------------------------------------------------
// Shape helpers — convert raw rows into paint-ready payloads
// ---------------------------------------------------------------------------

const EVENT_TAG = {
  property_saved:  'Buyer signal',
  property_viewed: 'Buyer signal',
  search_run:      'Search activity',
  form_submitted:  'New form',
  email_opened:    'Engagement',
  sms_replied:     'Engagement',
  score_change:    'Score change',
  portal_message:  'Client message'
};

function eventBody(event, leadName) {
  const d = event.event_data || {};
  const prop = d.property || {};
  const addr = prop.address || prop.mls_number || '';
  switch (event.event_type) {
    case 'property_saved':  return `${leadName} saved ${addr || 'a property'}.`;
    case 'property_viewed': return `${leadName} viewed ${addr || 'a property'}.`;
    case 'search_run':      return `${leadName} ran a new search${d.search?.city ? ` in ${d.search.city}` : ''}.`;
    case 'form_submitted':  return `${leadName} submitted a form${d.source ? ` (${d.source})` : ''}.`;
    case 'email_opened':    return `${leadName} opened your last email${d.opens > 1 ? ` (${d.opens} times)` : ''}.`;
    case 'sms_replied':     return `${leadName} replied to your text.`;
    case 'portal_message':  return `${leadName} messaged you from their page: “${(d.preview || '').slice(0, 90)}”`;
    case 'score_change': {
      if (d.change === 'stage_change') return `${leadName} moved to ${d.to}${d.from ? ` from ${d.from}` : ''}.`;
      if (d.change === 'reassigned')   return `${leadName} reassigned to ${d.to}${d.from ? ` (was ${d.from})` : ''}.`;
      if (d.sequence_enroll)           return `${leadName} enrolled in sequence "${d.sequence_name}".`;
      if (d.sequence_paused)           return `${leadName} sequence auto-paused (replied).`;
      return `${leadName} score updated.`;
    }
    default: return `${leadName} · ${event.event_type.replace(/_/g, ' ')}`;
  }
}

function shapeSignals(rows) {
  return rows.map((e) => {
    const lead = e.leads || {};
    const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'A lead';
    return {
      id:        e.id,
      lead_id:   lead.id || null,
      time_iso:  e.created_at,
      time:      formatClock(e.created_at),
      body:      eventBody(e, leadName),
      tag:       EVENT_TAG[e.event_type] || 'Signal'
    };
  });
}

// Phase 2C/2D — group active Twilio + email messages/calls by contact for the
// brief's "Recent Communications" section. Grouping key is contact_id (rows
// with no contact never reach here — they're 'pending_review', not 'active'
// — but anon: fallback keys still separate them defensively). Mixed sms/
// call/email rows for the SAME contact_id land in the SAME group, so a
// contact who both texted and emailed today shows as one card with both
// counts. Most-recent activity first.
function shapeRecentComms(rows) {
  const groups = new Map();
  for (const m of rows) {
    const key = m.contact_id || `anon:${m.id}`;
    let g = groups.get(key);
    if (!g) {
      const nm = [m.leads?.first_name, m.leads?.last_name].filter(Boolean).join(' ').trim();
      g = { contact_id: m.contact_id || null, name: nm || 'Unknown contact',
            count: 0, texts: 0, calls: 0, emails: 0, last_at: m.created_at };
      groups.set(key, g);
    }
    g.count += 1;
    if (m.channel === 'call') g.calls += 1;
    else if (m.channel === 'email') g.emails += 1;
    else g.texts += 1;
    if (new Date(m.created_at) > new Date(g.last_at)) g.last_at = m.created_at;
  }
  return [...groups.values()].sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
}

// Real transactions from the deals table (fed by deals.json). Shows Sara's
// actual listings + escrows on the Today view, with side (buy/sell/dual),
// price, and where each is on the road to closing.
function shapeDealsInMotion(deals) {
  const TRACK = ['Listed', 'Offer', 'Escrow', 'Inspection', 'Appraisal', 'Close'];
  const sideLabel = (s) => (s === 'both' ? 'Dual agency' : (s === 'buyer' ? 'Buy-side' : 'Sell-side'));
  return deals.map((d) => {
    const inEscrow = d.stage === 'pending';
    const isOffer  = d.stage === 'offer';
    // Offer = step 1 on the track, escrow = step 2.
    const trackIdx = inEscrow ? 2 : (isOffer ? 1 : 0);
    const price = d.sale_price || d.list_price || null;
    const coe = d.coe_date ? new Date(d.coe_date) : null;
    const daysToCoe = coe ? Math.round((coe.getTime() - Date.now()) / 86400000) : null;
    const stageLabel = inEscrow
      ? (daysToCoe == null ? 'In escrow'
          : daysToCoe >= 0 ? `In escrow · ${daysToCoe} day${daysToCoe === 1 ? '' : 's'} to close`
          : 'Closing overdue')
      : (isOffer ? (d.side === 'buyer' ? 'Offer out' : 'Offer in') : 'On market');
    const agentName = d.agent === 'james' ? 'James' : 'Sara';
    // Commission (internal): percent from listing_meta against the live price.
    const commRaw = d.listing_meta && d.listing_meta.commission;
    const commPct = commRaw != null ? parseFloat(String(commRaw)) : null;
    const commUsd = (price && commPct != null && Number.isFinite(commPct)) ? Math.round(price * commPct / 100) : null;
    return {
      lead_id:     d.source_key,
      lead_name:   `${sideLabel(d.side)} · ${agentName}`,
      stage_label: stageLabel,
      amount:      price,
      address:     d.address || null,
      city:        d.city || null,
      coe_date:    d.coe_date || null,
      days_to_coe: daysToCoe,
      in_escrow:   inEscrow,
      commission_pct: (commPct != null && Number.isFinite(commPct)) ? commPct : null,
      commission_usd: commUsd,
      agent:       d.agent || null,
      track:       TRACK.map((label, i) => ({ label, done: i < trackIdx, on: i === trackIdx }))
    };
  });
}

function shapeActiveDeals(leads, offers) {
  const STAGE_LABELS = {
    touring: { label: 'Touring',         track_idx: 2 },
    offer:   { label: 'Under contract',  track_idx: 4 },
    close:   { label: 'Closing soon',    track_idx: 5 }
  };
  const TRACK = ['Offer', 'Acceptance', 'Inspection', 'Appraisal', 'Financing', 'Close'];

  // Index offers by buyer_lead_id so we can attach property + amount per deal.
  const offersByLead = new Map();
  (offers || []).forEach((o) => {
    if (o.buyer_lead_id && !offersByLead.has(o.buyer_lead_id)) offersByLead.set(o.buyer_lead_id, o);
  });

  return leads.map((l) => {
    const stage = STAGE_LABELS[l.pipeline_stage] || { label: l.pipeline_stage, track_idx: 0 };
    const offer = offersByLead.get(l.id) || null;
    const property = offer?.properties || null;
    const amount = offer?.amount || (l.price_min && l.price_max ? (l.price_min + l.price_max) / 2 : l.price_min || l.price_max);
    const daysInStage = l.updated_at
      ? Math.max(0, Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 86400000))
      : 0;
    return {
      lead_id:    l.id,
      lead_name:  [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Lead',
      stage_label:`${stage.label} · day ${daysInStage}`,
      amount:     amount || null,
      address:    property?.address || null,
      city:       property?.city    || null,
      track:      TRACK.map((label, i) => ({
        label,
        done: i <  stage.track_idx,
        on:   i === stage.track_idx
      }))
    };
  });
}

function shapeHours(tours, now) {
  return tours.map((t) => {
    const lead = t.leads || {};
    const prop = t.properties || {};
    const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Buyer';
    const addr = prop.address ? `${prop.address}${prop.city ? ' · ' + prop.city : ''}` : '';
    const isPast = new Date(t.scheduled_at) < now;
    return {
      time:     formatClock(t.scheduled_at),
      time_iso: t.scheduled_at,
      kind:     'Showing',
      title:    addr ? `${leadName} — ${addr}` : `${leadName} tour`,
      sub:      `${t.duration_minutes || 45} min · ${t.tour_type || 'in_person'}${t.status ? ' · ' + t.status : ''}`,
      client:   [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
      past:     isPast,
      brass:    !isPast && new Date(t.scheduled_at).toDateString() === now.toDateString()
    };
  });
}

function formatClock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
