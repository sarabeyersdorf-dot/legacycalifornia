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

const SARA_SYSTEM = `You are writing a one-paragraph morning brief for Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA.
Voice: warm, direct, conversational. Like a smart assistant who reads her data.
Short sentences. No exclamation points. No filler. Lead with the most important signal.
Never invent details — only reference numbers and names provided.
Output plain prose only, 3-5 sentences, no markdown.`;

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
      'form_submitted','email_opened','sms_replied','score_change'
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
      supa.from('leads')     .select('id', { count: 'exact', head: true }).eq('status', 'archived'),
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

    // Real deals in motion — the escrow/listing deals from deals.json (the
    // deals table), NOT leads. These are Sara's actual transactions.
    const { data: dealsInMotion } = await supa
      .from('deals')
      .select('source_key, address, city, stage, side, agent, list_price, sale_price, coe_date')
      .in('stage', ['pending', 'listing'])
      .order('coe_date', { ascending: true, nullsFirst: false })
      .limit(8);

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

    // Look for today's cached brief first. Refresh narrative if older than 4h.
    const agent = profile.role === 'agent_james' ? 'james' : 'sara';
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
      const ctx = {
        draft_count:        result.drafts.length,
        tours_today_count:  result.tours_today.length,
        radio_silence_count: result.radio_silence.length,
        new_today_count:    result.new_today.length,
        open_offer_count:   result.open_offers.length,
        sample_new_lead:    result.new_today[0]?.first_name || null,
        sample_radio_lead:  result.radio_silence[0]?.first_name || null
      };
      const userPrompt = `Today is ${now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}.
Snapshot for ${agent === 'sara' ? 'Sara' : 'James'}:
  ${ctx.draft_count} draft message(s) awaiting your approval
  ${ctx.tours_today_count} tour(s) on today's calendar
  ${ctx.new_today_count} new lead(s) in the past 24 hours${ctx.sample_new_lead ? ' (latest: ' + ctx.sample_new_lead + ')' : ''}
  ${ctx.radio_silence_count} lead(s) with no contact in 14+ days${ctx.sample_radio_lead ? ' (e.g. ' + ctx.sample_radio_lead + ')' : ''}
  ${ctx.open_offer_count} open offer(s) in negotiation
Write the brief paragraph now. Lead with the most important signal.`;
      const { text } = await anthropicMessage({
        system: SARA_SYSTEM,
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
  score_change:    'Score change'
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

// Real transactions from the deals table (fed by deals.json). Shows Sara's
// actual listings + escrows on the Today view, with side (buy/sell/dual),
// price, and where each is on the road to closing.
function shapeDealsInMotion(deals) {
  const TRACK = ['Listed', 'Offer', 'Escrow', 'Inspection', 'Appraisal', 'Close'];
  const sideLabel = (s) => (s === 'both' ? 'Dual agency' : (s === 'buyer' ? 'Buy-side' : 'Sell-side'));
  return deals.map((d) => {
    const inEscrow = d.stage === 'pending';
    const trackIdx = inEscrow ? 2 : 0;
    const price = d.sale_price || d.list_price || null;
    const coe = d.coe_date ? new Date(d.coe_date) : null;
    const daysToCoe = coe ? Math.round((coe.getTime() - Date.now()) / 86400000) : null;
    const stageLabel = inEscrow
      ? (daysToCoe == null ? 'In escrow'
          : daysToCoe >= 0 ? `In escrow · ${daysToCoe} day${daysToCoe === 1 ? '' : 's'} to close`
          : 'Closing overdue')
      : 'On market';
    const agentName = d.agent === 'james' ? 'James' : 'Sara';
    return {
      lead_id:     d.source_key,
      lead_name:   `${sideLabel(d.side)} · ${agentName}`,
      stage_label: stageLabel,
      amount:      price,
      address:     d.address || null,
      city:        d.city || null,
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
      past:     isPast,
      brass:    !isPast && new Date(t.scheduled_at).toDateString() === now.toDateString()
    };
  });
}

function formatClock(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
