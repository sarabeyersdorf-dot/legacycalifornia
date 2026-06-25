// api/_lib/handlers/crm-metrics.js
// GET /api/crm/metrics
//
// Aggregate panel data for the CRM Today / Pipeline / Reports views — every
// number is derived from live Supabase data so nothing is hard-coded any
// longer. Cheap to run (handful of count+select queries in parallel).
//
// Response shape:
//   {
//     day_list:    [{ title, sub, time }],
//     yesterday:   { emails_sent, drafts_total, drafts_approved, showings_led,
//                    new_leads, pipeline_added, inbox_pct },
//     pipeline:    { expected_month, closing_week, tour_to_offer_pct },
//     closed_by_month: [{ label, amount, current? }],
//     recent_closings: [{ date, address, side, price }],
//     rep_kpi:     { trailing_12_vol, total_closed, avg_sale_price }
//   }
//
// All currency values are returned as integers (USD cents → nope, plain $).
// The frontend handles formatting.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const COMMISSION_PCT = 0.025;

function midPrice(l) {
  const a = Number(l.price_min) || 0;
  const b = Number(l.price_max) || 0;
  if (a && b) return (a + b) / 2;
  return a || b || 0;
}

function isoStartOfDay(d) { return new Date(d.toISOString().slice(0,10) + 'T00:00:00Z').toISOString(); }

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    const now = new Date();
    const dayAgo   = new Date(now.getTime() - 24  * 3600 * 1000);
    const yStart   = isoStartOfDay(dayAgo);
    const yEnd     = isoStartOfDay(now);
    const weekFwd  = new Date(now.getTime() + 7   * 86400 * 1000).toISOString();
    const ninetyAgo = new Date(now.getTime() - 90 * 86400 * 1000).toISOString();
    const twelveMoAgo = new Date(now.getTime() - 365 * 86400 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

    const [
      pendingDrafts, radioSilence, toursToday, newToday,
      yEmailsSent, yDraftsCreated, yDraftsApproved, yShowings, yNewLeads, yPipelineLeads,
      yInbound, yInboundReplied,
      offerClose, closingThisWeek, tourLeads, offerLeads,
      closedLeads, closeStageLeads
    ] = await Promise.all([
      // Day-list inputs
      supa.from('messages')
          .select('id, lead_id, channel, created_at, leads(first_name,last_name)')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(5),
      supa.from('leads')
          .select('id, first_name, last_name, last_contact_at')
          .eq('status', 'active')
          .lt('last_contact_at', new Date(now.getTime() - 14 * 86400 * 1000).toISOString())
          .order('last_contact_at')
          .limit(5),
      supa.from('tours')
          .select('id, scheduled_at, leads(first_name,last_name), properties(address)')
          .gte('scheduled_at', isoStartOfDay(now))
          .lte('scheduled_at', isoStartOfDay(new Date(now.getTime() + 86400000)))
          .order('scheduled_at')
          .limit(5),
      supa.from('leads')
          .select('id, first_name, last_name, source, score, created_at')
          .gte('created_at', dayAgo.toISOString())
          .order('created_at', { ascending: false })
          .limit(5),

      // Yesterday stats
      supa.from('messages').select('id', { count: 'exact', head: true })
          .in('status', ['sent','delivered']).gte('created_at', yStart).lt('created_at', yEnd),
      supa.from('messages').select('id', { count: 'exact', head: true })
          .eq('status', 'pending_approval').gte('created_at', yStart).lt('created_at', yEnd),
      supa.from('messages').select('id', { count: 'exact', head: true })
          .in('status', ['approved','sent','delivered']).gte('created_at', yStart).lt('created_at', yEnd),
      supa.from('tours').select('id', { count: 'exact', head: true })
          .gte('scheduled_at', yStart).lt('scheduled_at', yEnd),
      supa.from('leads').select('id, price_min, price_max', { count: 'exact' })
          .gte('created_at', yStart).lt('created_at', yEnd),
      supa.from('leads').select('id, price_min, price_max')
          .gte('created_at', yStart).lt('created_at', yEnd),
      supa.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'inbound').gte('created_at', yStart).lt('created_at', yEnd),
      // proxy for "handled" = inbound msgs that have a same-lead outbound created within 24h after
      // (cheaper approximation: count of inbound messages whose lead also has any outbound since)
      supa.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outbound').gte('created_at', yStart),

      // Pipeline header — expected this month + closing this week
      supa.from('leads').select('id, pipeline_stage, price_min, price_max, updated_at')
          .eq('status', 'active').in('pipeline_stage', ['offer','close']),
      supa.from('leads').select('id', { count: 'exact', head: true })
          .eq('status', 'active').eq('pipeline_stage', 'close')
          .gte('updated_at', isoStartOfDay(now)).lte('updated_at', weekFwd),
      supa.from('leads').select('id', { count: 'exact', head: true })
          .in('pipeline_stage', ['touring','offer','close']),
      supa.from('leads').select('id', { count: 'exact', head: true })
          .in('pipeline_stage', ['offer','close']),

      // Reports — closed-by-month + recent closings (we use leads in pipeline_stage='close' as proxy)
      supa.from('leads')
          .select('id, first_name, last_name, price_min, price_max, updated_at, lead_type, pipeline_stage, status')
          .eq('pipeline_stage', 'close')
          .gte('updated_at', twelveMoAgo)
          .order('updated_at', { ascending: false }),
      supa.from('leads').select('id', { count: 'exact', head: true }).eq('pipeline_stage', 'close')
    ]);

    // ---------- Day list (max 6) ----------
    const day_list = [];
    (pendingDrafts.data || []).forEach((m) => {
      const name = [m.leads?.first_name, m.leads?.last_name].filter(Boolean).join(' ') || 'a lead';
      day_list.push({ title: `Approve ${name}'s ${m.channel} draft`, sub: 'ready in draft', time: '5 min' });
    });
    (radioSilence.data || []).slice(0, 6 - day_list.length).forEach((l) => {
      const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'lead';
      const days = l.last_contact_at ? Math.floor((Date.now() - new Date(l.last_contact_at).getTime()) / 86400000) : null;
      day_list.push({ title: `Send ${name} check-in`, sub: days ? `${days} days dark` : 'no contact yet', time: '8 min' });
    });
    (toursToday.data || []).slice(0, 6 - day_list.length).forEach((t) => {
      const name = [t.leads?.first_name, t.leads?.last_name].filter(Boolean).join(' ') || 'tour';
      const addr = t.properties?.address || '';
      day_list.push({ title: `Confirm ${name} tour`, sub: addr || 'today on calendar', time: '3 min' });
    });
    (newToday.data || []).slice(0, 6 - day_list.length).forEach((l) => {
      const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'lead';
      day_list.push({ title: `Welcome ${name}`, sub: `new lead${l.source ? ' · ' + l.source : ''}`, time: '8 min' });
    });
    const day_total_min = day_list.reduce((s, t) => s + (parseInt(t.time) || 0), 0);

    // ---------- Yesterday at a glance ----------
    const pipelineAdded = (yPipelineLeads.data || []).reduce((sum, l) => sum + midPrice(l), 0);
    const inboundCount = yInbound.count || 0;
    const outboundCount = yInboundReplied.count || 0;
    const inbox_pct = inboundCount === 0 ? 100 : Math.min(100, Math.round((outboundCount / inboundCount) * 100));
    const yesterday = {
      emails_sent:      yEmailsSent.count    || 0,
      drafts_total:     yDraftsCreated.count || 0,
      drafts_approved:  yDraftsApproved.count || 0,
      showings_led:     yShowings.count      || 0,
      new_leads:        yNewLeads.count      || 0,
      pipeline_added:   Math.round(pipelineAdded),
      inbox_pct
    };

    // ---------- Pipeline header ----------
    const expected_month = Math.round((offerClose.data || []).reduce((s, l) => s + midPrice(l) * COMMISSION_PCT, 0));
    const tour_to_offer_pct = (tourLeads.count || 0) === 0
      ? 0
      : Math.round(((offerLeads.count || 0) / (tourLeads.count || 1)) * 100);
    const pipeline = {
      expected_month,
      closing_week:      closingThisWeek.count || 0,
      tour_to_offer_pct
    };

    // ---------- Closed-by-month (last 5 calendar months incl current) ----------
    const months = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`,
        label: d.toLocaleString('en-US', { month: 'short' }),
        amount: 0,
        current: i === 0
      });
    }
    (closedLeads.data || []).forEach((l) => {
      if (!l.updated_at) return;
      const d = new Date(l.updated_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
      const m = months.find((x) => x.key === key);
      if (m) m.amount += midPrice(l);
    });
    const closed_by_month = months.map((m) => ({ label: m.label, amount: Math.round(m.amount), current: m.current }));

    // ---------- Recent closings (last 6 in close stage) ----------
    const recent_closings = (closedLeads.data || []).slice(0, 6).map((l) => {
      const date = l.updated_at ? new Date(l.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Lead';
      return {
        date,
        address: name,                                // we don't store the closed-on address; show lead name
        side:    l.lead_type === 'seller' ? 'Listing' : (l.lead_type === 'buyer' ? 'Buyer' : '—'),
        price:   Math.round(midPrice(l))
      };
    });

    // ---------- Rep KPIs ----------
    const closedTrailing12 = (closedLeads.data || []).filter((l) => new Date(l.updated_at) >= new Date(twelveMoAgo));
    const trailing_12_vol = closedTrailing12.reduce((s, l) => s + midPrice(l), 0);
    const avg_sale_price  = closedTrailing12.length ? trailing_12_vol / closedTrailing12.length : 0;
    const rep_kpi = {
      trailing_12_vol: Math.round(trailing_12_vol),
      trailing_12_count: closedTrailing12.length,
      total_closed:    closeStageLeads.count || 0,
      avg_sale_price:  Math.round(avg_sale_price)
    };

    return ok(res, {
      day_list,
      day_total_min,
      yesterday,
      pipeline,
      closed_by_month,
      recent_closings,
      rep_kpi
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
