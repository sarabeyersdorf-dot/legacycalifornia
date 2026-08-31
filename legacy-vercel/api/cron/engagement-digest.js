// api/cron/engagement-digest.js
// GET /api/cron/engagement-digest   (Vercel cron daily, or ?key=<SYNC_SECRET>)
//
// The CRM logs site engagement (property views, saves, collection opens, form
// submissions) in lead_events, but only form submissions and IDX browsing fired
// a real-time alert — so day-to-day browsing reached nobody. This once-a-day
// digest closes that gap without alert-spam: it rolls up the last 24h of
// engagement and emails BOTH agents a "who's active" summary, with a one-line SMS
// headline. Sends nothing on a quiet day. Read-only; writes no data.
//
// Real-time alerts already cover the highest-intent events (form submit → alertAgents,
// a cold-sequence lead replying → alertAgents), so those still ping instantly; this
// is the ambient "someone's poking around" layer on top.

import { adminClient } from '../_lib/supabase.js';
import { alertAgents, deskUrl } from '../_lib/agent-alert.js';
import { checkSyncKey } from '../_lib/sync-key.js';

// Engagement we roll up. message_sent (our own outbound) and score_change
// (internal) are deliberately excluded.
const ENGAGEMENT = ['property_viewed', 'property_saved', 'collection_opened', 'collection_reaction', 'form_submitted', 'portal_message'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// A human label + best-effort detail (address / property / collection) pulled
// from the event's event_data, which varies by source.
function actionLabel(ev) {
  const d = (ev.event_data && typeof ev.event_data === 'object') ? ev.event_data : {};
  const what = d.address || d.property || d.title || d.listing_address || d.collection_title || d.property_address || (d.listing_id ? `listing ${d.listing_id}` : '') || '';
  const suffix = what ? ` — ${what}` : '';
  switch (ev.event_type) {
    case 'property_viewed':     return `viewed a listing${suffix}`;
    case 'property_saved':      return `saved a listing${suffix}`;
    case 'collection_opened':   return `opened their collection${suffix}`;
    case 'collection_reaction': return `reacted to a property${suffix}`;
    case 'form_submitted':      return `submitted a form${suffix}`;
    case 'portal_message':      return `sent a portal message${suffix}`;
    default:                    return `${ev.event_type}${suffix}`;
  }
}

function json(res, body, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const okCron = !!req.headers['x-vercel-cron'];
  const okKey  = checkSyncKey(req.query?.key).ok;
  if (!okCron && !okKey) return json(res, { error: 'unauthorized' }, 401);

  try {
    const supa = adminClient();
    const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
    const since = new Date(Date.now() - hours * 3600e3).toISOString();

    const { data: events, error } = await supa.from('lead_events')
      .select('lead_id, event_type, event_data, source, created_at')
      .in('event_type', ENGAGEMENT).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(1000);
    if (error) return json(res, { error: error.message }, 500);

    const rows = events || [];
    if (!rows.length) return json(res, { sent: false, reason: 'no engagement in window', window_hours: hours });

    // Resolve the people behind the events.
    const ids = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
    const byId = new Map();
    if (ids.length) {
      const { data: leads } = await supa.from('leads')
        .select('id, first_name, last_name, email, phone, assigned_agent, pipeline_stage').in('id', ids);
      for (const l of (leads || [])) byId.set(l.id, l);
    }

    // Group events per person; anonymous (no lead_id) events are counted.
    const groups = new Map();
    let anonCount = 0;
    for (const ev of rows) {
      if (!ev.lead_id) { anonCount += 1; continue; }
      if (!groups.has(ev.lead_id)) groups.set(ev.lead_id, []);
      groups.get(ev.lead_id).push(ev);
    }

    if (!groups.size && !anonCount) return json(res, { sent: false, reason: 'nothing to report' });

    // Build the digest, most-active person first.
    const people = [...groups.entries()].map(([id, evs]) => ({ lead: byId.get(id) || null, id, evs }))
      .sort((a, b) => b.evs.length - a.evs.length);

    const nameOf = (l) => (l ? ([l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || 'A contact') : 'A contact');

    const htmlRows = people.map((p) => {
      const l = p.lead;
      const who = esc(nameOf(l));
      const contact = l ? [l.email, l.phone].filter(Boolean).map(esc).join(' · ') : '';
      const acts = p.evs.slice(0, 6).map((e) => `<li style="margin:2px 0;color:#3A332B;">${esc(actionLabel(e))}</li>`).join('');
      const more = p.evs.length > 6 ? `<li style="color:#7C6A4D;">+${p.evs.length - 6} more</li>` : '';
      const link = l ? `<a href="${esc(deskUrl(l.id))}" style="color:#5A4C7C;">open in CRM →</a>` : '';
      return `<tr><td style="padding:12px 0;border-top:1px solid #E7DFC9;">
        <div style="font-size:15px;font-weight:600;color:#1A1714;">${who}${l && l.assigned_agent ? ` <span style="font-weight:400;color:#7C6A4D;font-size:12px;">(${esc(l.assigned_agent)})</span>` : ''}</div>
        ${contact ? `<div style="font-size:12px;color:#7C6A4D;margin:2px 0 4px;">${contact}</div>` : ''}
        <ul style="margin:4px 0 0;padding-left:18px;font-size:13.5px;">${acts}${more}</ul>
        ${link ? `<div style="margin-top:4px;font-size:12px;">${link}</div>` : ''}
      </td></tr>`;
    }).join('');

    const anonLine = anonCount ? `<p style="font-size:13px;color:#7C6A4D;margin:14px 0 0;">Plus ${anonCount} action${anonCount === 1 ? '' : 's'} from visitors not yet identified.</p>` : '';

    const html = `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:28px 24px;background:#FAF6EC;color:#1A1714;">
      <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:8px;">Legacy Properties · Daily engagement</div>
      <h1 style="font-size:20px;margin:0 0 4px;">${people.length} ${people.length === 1 ? 'person' : 'people'} active on your site</h1>
      <p style="font-size:13px;color:#7C6A4D;margin:0 0 12px;">Last ${hours} hours · ${rows.length} action${rows.length === 1 ? '' : 's'} total.</p>
      <table style="width:100%;border-collapse:collapse;">${htmlRows}</table>
      ${anonLine}
      <p style="margin-top:20px;"><a href="${esc(deskUrl())}" style="color:#5A4C7C;font-size:14px;">Open the CRM →</a></p>
    </div>`;

    const textLines = people.map((p) => {
      const acts = p.evs.slice(0, 4).map((e) => '  - ' + actionLabel(e)).join('\n');
      const l = p.lead;
      const contact = l ? [l.email, l.phone].filter(Boolean).join(' · ') : '';
      return `${nameOf(l)}${contact ? ' (' + contact + ')' : ''}:\n${acts}`;
    }).join('\n\n');
    const text = `${people.length} people active on your site in the last ${hours}h (${rows.length} actions).\n\n${textLines}${anonCount ? `\n\nPlus ${anonCount} action(s) from unidentified visitors.` : ''}\n\nOpen the CRM: ${deskUrl()}`;

    const namesForSms = people.slice(0, 3).map((p) => nameOf(p.lead)).join(', ');
    const sms = `🏠 ${people.length} ${people.length === 1 ? 'person' : 'people'} active on your site (${rows.length} action${rows.length === 1 ? '' : 's'})${namesForSms ? `: ${namesForSms}${people.length > 3 ? '…' : ''}` : ''}. Details in your email / the CRM.`;

    const alert = await alertAgents(supa, { subject: `Site activity — ${people.length} active, ${rows.length} action${rows.length === 1 ? '' : 's'}`, sms, text, html });

    return json(res, { sent: true, window_hours: hours, events: rows.length, people: people.length, anonymous: anonCount, alert });
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
}
