// api/_lib/handlers/crm-calendar.js
// /api/crm/calendar   (agent-only)
//   GET  ?week=<offset>  → one week of the calendar: client tours (public.tours)
//        MERGED with general agent events (public.appointments: calls, blocks,
//        open houses, meetings). All day/time math is done in Pacific time.
//   POST                  → create an event. Routed by `kind`:
//        kind 'tour' (default)  → a client tour in public.tours (needs a lead)
//        kind call|block|open|meeting → a row in public.appointments (no lead)
//
// The grid is a fixed 9 AM–5 PM x Mon–Sun board; each hour row is 56px tall.
// The server returns fully-positioned events ({ day, row, top, height, cls,
// time, title, sub }) so the painter only injects DOM.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TZ = 'America/Los_Angeles';
const PX_PER_HOUR = 56;
const PX_PER_MIN = PX_PER_HOUR / 60;
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 18; // exclusive — the 5 PM row is the last
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const APPT_KINDS = ['call', 'block', 'open', 'meeting'];
// appointment kind -> calendar css class
const KIND_CLS = { call: 'call', block: 'block', open: 'open', meeting: 'call' };

function laParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  if (p.hour === '24') p.hour = '00';
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, dow: p.weekday };
}
function ymdShift(y, m, d, delta) {
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + delta);
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}
function isoWeek(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
const pad2 = (n) => String(n).padStart(2, '0');
const key = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;

// Interpret Y-M-D H:M as Pacific wall-clock and return the matching UTC Date.
function laToUTC(y, m, d, hh, mm) {
  const asUTC = Date.UTC(y, m - 1, d, hh, mm);
  const p = laParts(new Date(asUTC));
  const wallAsUTC = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return new Date(asUTC - (wallAsUTC - asUTC));
}

// Position an instant onto the 9-5 board; null if off-day / after 6 PM.
function positionEvent(scheduledISO, durationMin, dayIndex) {
  if (!scheduledISO) return null;
  const p = laParts(new Date(scheduledISO));
  const di = dayIndex[key(p)];
  if (di == null) return null;
  if (p.hour >= DAY_END_HOUR) return null;
  const clampedStartHour = Math.max(p.hour, DAY_START_HOUR);
  const row = clampedStartHour - DAY_START_HOUR;
  const topMin = p.hour < DAY_START_HOUR ? 0 : p.minute;
  const top = Math.round(topMin * PX_PER_MIN);
  const dur = Number(durationMin) || 30;
  const minutesLeft = (DAY_END_HOUR - clampedStartHour) * 60 - topMin;
  const height = Math.max(24, Math.round(Math.min(dur, minutesLeft) * PX_PER_MIN));
  const h12 = ((p.hour + 11) % 12) + 1;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return { day: di, row, top, height, h12, minute: p.minute, ampm };
}

async function createEvent(req, res, profile) {
  const supa = adminClient();
  const body = await readJson(req);
  const agent = profile.role === 'agent_james' ? 'james' : 'sara';

  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  const time = typeof body?.time === 'string' ? body.time.trim() : '';
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm) return fail(res, 400, 'date is required (YYYY-MM-DD)');
  if (!tm) return fail(res, 400, 'time is required (HH:MM, 24-hour)');
  const scheduled = laToUTC(+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]);
  if (isNaN(scheduled)) return fail(res, 400, 'could not parse date/time');
  const duration = Math.max(15, Math.min(480, parseInt(body?.duration_minutes, 10) || 30));
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : null;

  const kind = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : 'tour';

  // ---- General appointment (call / block / open / meeting) ---------------
  if (kind !== 'tour') {
    if (!APPT_KINDS.includes(kind)) return fail(res, 400, `kind must be tour or one of: ${APPT_KINDS.join(', ')}`);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return fail(res, 400, 'title is required');

    // Optional soft link to an existing lead by email (never created here).
    let leadId = null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email && EMAIL_RE.test(email)) {
      const { data } = await supa.from('leads').select('id').eq('email', email).maybeSingle();
      leadId = data?.id || null;
    }

    const { data: appt, error } = await supa.from('appointments').insert({
      title, kind, starts_at: scheduled.toISOString(), duration_minutes: duration,
      agent, lead_id: leadId, location: typeof body?.location === 'string' ? body.location.trim() || null : null, notes
    }).select('id, title, kind, starts_at, duration_minutes').single();
    if (error) return fail(res, 500, `appointment create: ${error.message}`);
    return ok(res, { appointment: appt });
  }

  // ---- Client tour -------------------------------------------------------
  const leadIdIn = typeof body?.lead_id === 'string' ? body.lead_id.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const tourType = body?.tour_type === 'video' ? 'video' : 'in_person';
  const propertyId = typeof body?.property_id === 'string' && body.property_id.trim() ? body.property_id.trim() : null;
  if (!leadIdIn && !email) return fail(res, 400, 'lead_id or email is required for a tour');
  if (email && !leadIdIn && !EMAIL_RE.test(email)) return fail(res, 400, 'email is not a valid address');

  let lead = null;
  if (leadIdIn) {
    const { data } = await supa.from('leads').select('id, email').eq('id', leadIdIn).maybeSingle();
    lead = data || null;
    if (!lead) return fail(res, 404, 'lead_id not found');
  } else {
    const { data } = await supa.from('leads').select('id, email').eq('email', email).maybeSingle();
    lead = data || null;
    if (!lead) {
      const { data: created, error: insErr } = await supa.from('leads').insert({
        email, first_name: typeof body?.first_name === 'string' ? body.first_name.trim() : null,
        last_name: typeof body?.last_name === 'string' ? body.last_name.trim() : null,
        source: 'manual', lead_type: 'buyer', assigned_agent: agent,
        journey_stage: 'touring', pipeline_stage: 'touring'
      }).select('id, email').single();
      if (insErr) return fail(res, 500, `lead create: ${insErr.message}`);
      lead = created;
    }
  }

  const { data: tour, error } = await supa.from('tours').insert({
    lead_id: lead.id, property_id: propertyId, scheduled_at: scheduled.toISOString(),
    duration_minutes: duration, tour_type: tourType, status: 'confirmed', agent, notes
  }).select('id, scheduled_at, duration_minutes, tour_type, status').single();
  if (error) return fail(res, 500, `tour create: ${error.message}`);
  return ok(res, { tour, lead: { id: lead.id, email: lead.email } });
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  if (req.method === 'POST') return createEvent(req, res, profile);
  if (req.method !== 'GET')  return fail(res, 405, 'method_not_allowed');

  try {
    const supa = adminClient();
    const weekOffset = parseInt(req.query?.week, 10) || 0;

    const now = new Date();
    const today = laParts(now);
    const dowIdx = Math.max(0, DOW.indexOf(today.dow));
    const monday = ymdShift(today.y, today.m, today.d, -dowIdx + 7 * weekOffset);

    const todayKey = key(today);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dt = ymdShift(monday.y, monday.m, monday.d, i);
      days.push({ dow: DOW[i], num: dt.d, is_today: key(dt) === todayKey, _key: key(dt) });
    }
    const dayIndex = {};
    days.forEach((d, i) => { dayIndex[d._key] = i; });

    const firstDt = ymdShift(monday.y, monday.m, monday.d, 0);
    const lastDt = ymdShift(monday.y, monday.m, monday.d, 6);
    const range = firstDt.m === lastDt.m
      ? `${MONTHS[firstDt.m - 1]} ${firstDt.d} – ${lastDt.d}`
      : `${MONTHS[firstDt.m - 1]} ${firstDt.d} – ${MONTHS[lastDt.m - 1]} ${lastDt.d}`;
    const weekLabel = `${range} · Week ${isoWeek(firstDt.y, firstDt.m, firstDt.d)}`;

    const qStart = new Date(Date.UTC(firstDt.y, firstDt.m - 1, firstDt.d, 12));
    qStart.setUTCDate(qStart.getUTCDate() - 1);
    const qEnd = new Date(Date.UTC(lastDt.y, lastDt.m - 1, lastDt.d, 12));
    qEnd.setUTCDate(qEnd.getUTCDate() + 2);
    const startISO = qStart.toISOString(), endISO = qEnd.toISOString();

    const [toursRes, apptRes] = await Promise.all([
      supa.from('tours')
        .select('id, scheduled_at, duration_minutes, tour_type, status, leads(first_name,last_name), properties(address,city)')
        .gte('scheduled_at', startISO).lt('scheduled_at', endISO).neq('status', 'cancelled')
        .order('scheduled_at', { ascending: true }),
      supa.from('appointments')
        .select('id, title, kind, starts_at, duration_minutes, notes')
        .gte('starts_at', startISO).lt('starts_at', endISO)
        .order('starts_at', { ascending: true })
    ]);
    if (toursRes.error) return fail(res, 500, `tours: ${toursRes.error.message}`);
    if (apptRes.error && !/relation .*appointments.* does not exist/i.test(apptRes.error.message || '')) {
      return fail(res, 500, `appointments: ${apptRes.error.message}`);
    }

    const events = [];

    for (const t of toursRes.data || []) {
      const pos = positionEvent(t.scheduled_at, t.duration_minutes, dayIndex);
      if (!pos) continue;
      const lead = t.leads || {};
      const prop = t.properties || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
      const title = prop.address ? String(prop.address).split(',')[0] : who;
      const kind = t.tour_type === 'video' ? 'Video' : 'Tour';
      const statusTag = t.status && t.status !== 'confirmed' ? ` · ${t.status}` : '';
      events.push({
        day: pos.day, row: pos.row, top: pos.top, height: pos.height,
        cls: t.tour_type === 'video' ? 'call' : 'tour',
        time: `${pos.h12}:${pad2(pos.minute)} ${pos.ampm} · ${kind}`,
        title, sub: `${who}${statusTag}`, sort: t.scheduled_at
      });
    }

    for (const a of apptRes.data || []) {
      const pos = positionEvent(a.starts_at, a.duration_minutes, dayIndex);
      if (!pos) continue;
      const label = a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : 'Event';
      events.push({
        day: pos.day, row: pos.row, top: pos.top, height: pos.height,
        cls: KIND_CLS[a.kind] || 'block',
        time: `${pos.h12}:${pad2(pos.minute)} ${pos.ampm} · ${label}`,
        title: a.title || label, sub: a.notes || label, sort: a.starts_at
      });
    }

    events.sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));
    events.forEach((e) => { delete e.sort; });

    return ok(res, { week_offset: weekOffset, week_label: weekLabel, days: days.map(({ _key, ...d }) => d), events });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
