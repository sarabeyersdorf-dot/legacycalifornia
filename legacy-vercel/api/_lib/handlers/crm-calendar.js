// api/_lib/handlers/crm-calendar.js
// GET /api/crm/calendar?week=<offset>
//
// Agent-only. Returns one week of tours (from public.tours) laid out for the
// CRM Calendar grid. `week` is a signed integer offset from the current week
// (0 = this week, -1 = last, 1 = next). All day/time math is done in Pacific
// time (the office timezone) so events land on the right day and hour.
//
// The grid is a fixed 9 AM–5 PM x Mon–Sun board; each hour row is 56px tall.
// The server returns fully-positioned events ({ day, row, top, height, cls,
// time, title, sub }) so the painter only injects DOM.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const TZ = 'America/Los_Angeles';
const PX_PER_HOUR = 56;
const PX_PER_MIN = PX_PER_HOUR / 60;
const DAY_START_HOUR = 9;   // 9 AM
const DAY_END_HOUR = 18;    // exclusive — last row is the 5 PM hour
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Wall-clock parts of `date` in Pacific time.
function laParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  // hour '24' can appear at midnight in some engines — normalise to 0.
  if (p.hour === '24') p.hour = '00';
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, dow: p.weekday };
}

// Calendar-only day arithmetic (noon-UTC anchor avoids DST rollovers).
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

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const weekOffset = parseInt(req.query?.week, 10) || 0;

    const now = new Date();
    const today = laParts(now);
    const dowIdx = Math.max(0, DOW.indexOf(today.dow)); // Mon=0..Sun=6
    const monday = ymdShift(today.y, today.m, today.d, -dowIdx + 7 * weekOffset);

    // The 7 day columns (Mon..Sun) with LA calendar dates.
    const todayKey = key(today);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dt = ymdShift(monday.y, monday.m, monday.d, i);
      days.push({ dow: DOW[i], num: dt.d, is_today: key(dt) === todayKey, _key: key(dt) });
    }
    const dayIndex = {};
    days.forEach((d, i) => { dayIndex[d._key] = i; });

    // Week label, e.g. "May 11 – 17 · Week 20".
    const first = days[0], last = days[6];
    const firstDt = ymdShift(monday.y, monday.m, monday.d, 0);
    const lastDt = ymdShift(monday.y, monday.m, monday.d, 6);
    const range = firstDt.m === lastDt.m
      ? `${MONTHS[firstDt.m - 1]} ${firstDt.d} – ${lastDt.d}`
      : `${MONTHS[firstDt.m - 1]} ${firstDt.d} – ${MONTHS[lastDt.m - 1]} ${lastDt.d}`;
    const weekLabel = `${range} · Week ${isoWeek(firstDt.y, firstDt.m, firstDt.d)}`;

    // Query a padded UTC window (LA lags UTC) and match to LA dates in code.
    const qStart = new Date(Date.UTC(firstDt.y, firstDt.m - 1, firstDt.d, 12));
    qStart.setUTCDate(qStart.getUTCDate() - 1);
    const qEnd = new Date(Date.UTC(lastDt.y, lastDt.m - 1, lastDt.d, 12));
    qEnd.setUTCDate(qEnd.getUTCDate() + 2);

    const { data: tours, error } = await supaTours(qStart, qEnd);
    if (error) return fail(res, 500, `tours: ${error.message}`);

    const events = [];
    for (const t of tours || []) {
      if (!t.scheduled_at) continue;
      const p = laParts(new Date(t.scheduled_at));
      const di = dayIndex[key(p)];
      if (di == null) continue;                       // outside the visible week
      if (p.hour >= DAY_END_HOUR) continue;           // after 6 PM — off the board

      const clampedStartHour = Math.max(p.hour, DAY_START_HOUR);
      const row = clampedStartHour - DAY_START_HOUR;  // 0..8
      const topMin = p.hour < DAY_START_HOUR ? 0 : p.minute;
      const top = Math.round(topMin * PX_PER_MIN);

      // Height from duration, clamped so it doesn't overflow past 5 PM row.
      const dur = Number(t.duration_minutes) || 30;
      const minutesLeftInBoard = (DAY_END_HOUR - clampedStartHour) * 60 - topMin;
      const height = Math.max(24, Math.round(Math.min(dur, minutesLeftInBoard) * PX_PER_MIN));

      const lead = t.leads || {};
      const prop = t.properties || {};
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
      const title = prop.address ? String(prop.address).split(',')[0] : who;
      const h12 = ((p.hour + 11) % 12) + 1;
      const ampm = p.hour < 12 ? 'AM' : 'PM';
      const kind = t.tour_type === 'video' ? 'Video' : 'Tour';
      const statusTag = t.status && t.status !== 'confirmed' ? ` · ${t.status}` : '';

      events.push({
        day: di,
        row,
        top,
        height,
        cls: t.tour_type === 'video' ? 'call' : 'tour',
        time: `${h12}:${pad2(p.minute)} ${ampm} · ${kind}`,
        title,
        sub: `${who}${statusTag}`
      });
    }

    return ok(res, { week_offset: weekOffset, week_label: weekLabel, days, events });
  } catch (e) {
    return fail(res, 500, e.message);
  }

  async function supaTours(startDate, endDate) {
    const supa = adminClient();
    return supa
      .from('tours')
      .select('id, scheduled_at, duration_minutes, tour_type, status, agent, leads(first_name,last_name), properties(address,city)')
      .gte('scheduled_at', startDate.toISOString())
      .lt('scheduled_at', endDate.toISOString())
      .neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true });
  }
}
