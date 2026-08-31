// api/_lib/browsing-alert.js
// Real-time "your lead is on the site RIGHT NOW — go greet them" alert.
//
// Fires the moment an IDENTIFIED lead does something high-intent on the site:
//   • opens the curated collection you sent them        → reason 'opened their collection'
//   • views 2+ listings in a browsing session (30 min)  → reason 'viewing the listings you sent'
// Only identified visitors trigger it (anonymous traffic has no one to greet),
// and only the lead's ASSIGNED agent is pinged (text + email), so it's not noise
// for the other agent. Debounced to ONE alert per lead per 30 minutes so a single
// session is one ping, not twenty.
//
// Best-effort and fire-and-forget by design: callers invoke it without awaiting so
// it never delays the client's page. A failure here must never affect the visitor.

import { alertAgent, deskUrl } from './agent-alert.js';

const WINDOW_MS = 30 * 60 * 1000;

export async function maybeBrowsingAlert(supa, { leadId, reason, gateOnViews = false } = {}) {
  if (!leadId || !reason) return { sent: false, reason: 'missing lead or reason' };
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    // Debounce: skip if we already pinged for this lead inside the window.
    const { data: recent } = await supa.from('lead_events')
      .select('id').eq('lead_id', leadId).eq('event_type', 'browsing_alert_sent')
      .gte('created_at', since).limit(1);
    if (recent && recent.length) return { sent: false, reason: 'debounced' };

    // High-intent gate for property views: require a real session (2+ views in
    // the window), not a single glance. The current view is logged fire-and-forget
    // by the caller, so this counts what has already landed — it fires once the
    // session is clearly underway.
    if (gateOnViews) {
      const { count } = await supa.from('lead_events')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', leadId).eq('event_type', 'property_viewed').gte('created_at', since);
      if ((count || 0) < 2) return { sent: false, reason: 'below view threshold' };
    }

    const { data: lead } = await supa.from('leads')
      .select('id, first_name, last_name, phone, email, assigned_agent, property_address')
      .eq('id', leadId).maybeSingle();
    if (!lead) return { sent: false, reason: 'lead not found' };

    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || 'A lead';
    const where = lead.property_address ? ` (re: ${lead.property_address})` : '';
    const contact = [lead.phone, lead.email].filter(Boolean).join(' · ');
    const link = deskUrl(lead.id);

    const sms = `👀 ${name} is on your site right now — ${reason}${where}.${lead.phone ? ` Call/text ${lead.phone}` : ''} while they're looking.`;
    const text = `${name} is browsing your site right now — ${reason}${where}.\n\n${contact ? `Reach them: ${contact}\n` : ''}Open in the CRM: ${link}`;
    const subject = `🔔 ${name} is browsing now — ${reason}`;

    const alert = await alertAgent(supa, lead.assigned_agent === 'james' ? 'james' : 'sara', { subject, sms, text });

    // Record the ping so the debounce window holds.
    await supa.from('lead_events')
      .insert({ lead_id: leadId, event_type: 'browsing_alert_sent', source: 'system', event_data: { reason } })
      .then(() => {}, () => {});

    return { sent: true, alert };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}
