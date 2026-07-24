// api/cal/[token].js
// GET /api/cal/<token>.ics  →  a live iCalendar feed of one agent's CRM
// calendar (tours + appointments), for subscribing in Google/Apple Calendar.
//
// Unauthenticated by design — calendar apps fetch the URL with no session — so
// the URL itself is the secret: <token> is an HMAC only the server can produce
// (see _lib/cal-feed.js). The feed is read-only and per-agent.

import { adminClient } from '../_lib/supabase.js';
import { feedAgent } from '../_lib/cal-feed.js';

const pad = (n) => String(n).padStart(2, '0');
// A UTC timestamp → iCalendar UTC stamp (YYYYMMDDTHHMMSSZ).
function icsStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// Escape + fold a property line to keep long values RFC-5545 safe.
function line(name, value) {
  const esc = String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  let s = `${name}:${esc}`;
  if (s.length <= 74) return s;
  // fold at 74 octets, continuation lines start with a single space
  const out = [];
  while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); }
  out.push(s);
  return out.join('\r\n');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('method_not_allowed'); }

  const agent = feedAgent(req.query?.token);
  if (!agent) { res.statusCode = 404; return res.end('not found'); }

  try {
    const supa = adminClient();
    const now = Date.now();
    const startISO = new Date(now - 30 * 86400000).toISOString();  // 30 days back
    const endISO   = new Date(now + 180 * 86400000).toISOString(); // 6 months out

    const [toursRes, apptRes] = await Promise.all([
      supa.from('tours')
        .select('id, scheduled_at, duration_minutes, tour_type, status, notes, leads(first_name,last_name), properties(address,city)')
        .eq('agent', agent).neq('status', 'cancelled')
        .gte('scheduled_at', startISO).lt('scheduled_at', endISO),
      supa.from('appointments')
        .select('id, title, kind, sub_kind, starts_at, duration_minutes, notes, leads(first_name,last_name)')
        .eq('agent', agent).gte('starts_at', startISO).lt('starts_at', endISO)
        .then((r) => r, () => ({ data: [] }))
    ]);

    const stamp = icsStamp(new Date());
    const KIND_LABEL = { call: 'Call', block: 'Block', open: 'Open house', meeting: 'Meeting', listing_appt: 'Listing appt', showing: 'Showing', follow_up: 'Follow-up', inspection: 'Inspection' };
    const out = [];

    for (const t of (toursRes?.data || [])) {
      const start = new Date(t.scheduled_at); if (isNaN(start)) continue;
      const dur = Number(t.duration_minutes) || 30;
      const end = new Date(start.getTime() + dur * 60000);
      const lead = t.leads || {}, prop = t.properties || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
      const addr = prop.address ? [prop.address, prop.city].filter(Boolean).join(', ') : '';
      const summary = (t.tour_type === 'video' ? 'Video tour' : 'Tour') + ' · ' + (prop.address ? String(prop.address).split(',')[0] : who);
      out.push(
        'BEGIN:VEVENT',
        line('UID', `tour-${t.id}@legacycalifornia`),
        line('DTSTAMP', stamp), line('DTSTART', icsStamp(start)), line('DTEND', icsStamp(end)),
        line('SUMMARY', summary),
        addr ? line('LOCATION', addr) : null,
        line('DESCRIPTION', [`Client: ${who}`, t.notes ? `Notes: ${t.notes}` : '', 'Legacy CRM'].filter(Boolean).join('\n')),
        'STATUS:CONFIRMED', 'END:VEVENT'
      );
    }
    for (const a of (apptRes?.data || [])) {
      const start = new Date(a.starts_at); if (isNaN(start)) continue;
      const dur = Number(a.duration_minutes) || 30;
      const end = new Date(start.getTime() + dur * 60000);
      const lead = a.leads || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || '';
      const label = a.kind === 'inspection' ? (a.sub_kind ? `${a.sub_kind} inspection` : 'Inspection') : (KIND_LABEL[a.kind] || 'Event');
      const summary = a.title || label;
      out.push(
        'BEGIN:VEVENT',
        line('UID', `appt-${a.id}@legacycalifornia`),
        line('DTSTAMP', stamp), line('DTSTART', icsStamp(start)), line('DTEND', icsStamp(end)),
        line('SUMMARY', summary),
        line('DESCRIPTION', [label, who ? `With: ${who}` : '', a.notes ? `Notes: ${a.notes}` : '', 'Legacy CRM'].filter(Boolean).join('\n')),
        'STATUS:CONFIRMED', 'END:VEVENT'
      );
    }

    const cal = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Legacy Properties//CRM Calendar//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      line('X-WR-CALNAME', `Legacy CRM — ${agent === 'james' ? 'James' : 'Sara'}`),
      'X-WR-TIMEZONE:America/Los_Angeles',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
      ...out.filter(Boolean),
      'END:VCALENDAR'
    ].join('\r\n');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="legacy-${agent}.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.end(req.method === 'HEAD' ? undefined : cal);
  } catch (e) {
    res.statusCode = 500;
    return res.end('feed error');
  }
}
