// api/cron/agent-day-reminders.js — GET /api/cron/agent-day-reminders?key=<PUBLISH_SECRET>
//
// Every morning, text each agent (Sara + James) a one-message digest of THEIR
// calendar for the day — appointments (showings, inspections, listing appts,
// meetings…) and client tours, in time order. Nothing is sent to an agent with
// no events today. Runs ~7am Pacific (see vercel.json: 0 14 * * *, i.e. 14:00
// UTC = 7am PDT / 6am PST).
//
// SMS goes through Twilio; without TWILIO_* env vars the job no-ops cleanly and
// reports that SMS isn't configured (nothing breaks).

import { adminClient } from '../_lib/supabase.js';
import { sendSMS } from '../_lib/twilio.js';
import { verifyCron } from '../_lib/cron-auth.js';

const TZ = 'America/Los_Angeles';
const dateFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt   = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const prettyFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });

const AGENTS = ['sara', 'james'];
const FALLBACK_PHONE = { sara: '209-559-4966', james: '209-770-7523' };
const MAX_SMS = 600;   // a few segments — trimmed below if a day is very full

export default async function handler(req, res) {
  if (!verifyCron(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const supa = adminClient();
  try {
    const now = new Date();
    const todayStr = dateFmt.format(now);
    // Wide UTC window around "today Pacific"; each row is then filtered by its
    // Pacific calendar date so DST never mis-buckets an event.
    const lo = new Date(now.getTime() - 12 * 3600e3).toISOString();
    const hi = new Date(now.getTime() + 36 * 3600e3).toISOString();

    const [apptRes, tourRes] = await Promise.all([
      supa.from('appointments')
        .select('title, kind, sub_kind, client_label, starts_at, all_day, agent')
        .gte('starts_at', lo).lt('starts_at', hi),
      supa.from('tours')
        .select('scheduled_at, tour_type, status, agent, properties(address)')
        .gte('scheduled_at', lo).lt('scheduled_at', hi).neq('status', 'cancelled')
    ]);
    if (apptRes.error) return res.status(500).json({ success: false, error: apptRes.error.message });

    const events = [];
    for (const a of (apptRes.data || [])) {
      const at = new Date(a.starts_at);
      if (dateFmt.format(at) !== todayStr) continue;
      // Client-facing-safe label first; never lean on a raw title that may hold a name.
      const label = a.client_label
        || (a.kind === 'inspection' ? (a.sub_kind ? `${a.sub_kind} inspection` : 'Inspection') : (a.title || a.kind || 'Event'));
      events.push({ agent: (a.agent || 'sara'), at, allDay: !!a.all_day, label });
    }
    for (const t of (tourRes.data || [])) {
      const at = new Date(t.scheduled_at);
      if (dateFmt.format(at) !== todayStr) continue;
      const addr = t.properties?.address ? String(t.properties.address).split(',')[0].trim() : '';
      events.push({ agent: (t.agent || 'sara'), at, allDay: false, label: (t.tour_type === 'video' ? 'Video tour' : 'Tour') + (addr ? ` · ${addr}` : '') });
    }

    // Agent phones (fall back to the known numbers if the table is thin).
    const { data: ags } = await supa.from('agents').select('agent_key, phone').in('agent_key', AGENTS);
    const phoneByKey = {};
    for (const a of (ags || [])) if (a.phone) phoneByKey[a.agent_key] = a.phone;

    const prettyDay = prettyFmt.format(now);
    let sent = 0;
    const results = [];
    for (const key of AGENTS) {
      const mine = events.filter((e) => e.agent === key).sort((a, b) => a.at - b.at);
      if (!mine.length) { results.push({ agent: key, skipped: 'no events today' }); continue; }
      const phone = phoneByKey[key] || FALLBACK_PHONE[key];
      if (!phone) { results.push({ agent: key, skipped: 'no phone on file' }); continue; }
      const lines = mine.map((e) => `${e.allDay ? 'All day' : timeFmt.format(e.at)} ${e.label}`);
      let body = `Legacy — your schedule for ${prettyDay}:\n${lines.join('\n')}`;
      if (body.length > MAX_SMS) body = body.slice(0, MAX_SMS - 1) + '…';
      try {
        const r = await sendSMS({ to: phone, body });
        if (r && r.skipped) results.push({ agent: key, skipped: r.reason || 'SMS not configured (Twilio)' });
        else if (r && r.error) results.push({ agent: key, error: String(r.error) });
        else { sent++; results.push({ agent: key, events: mine.length }); }
      } catch (e) {
        results.push({ agent: key, error: e.message || String(e) });
      }
    }

    return res.status(200).json({ success: true, date: todayStr, sent, results });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
