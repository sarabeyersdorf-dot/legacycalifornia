// api/_lib/handlers/crm-calendar.js
// /api/crm/calendar   (agent-only)
//   GET  ?week=<offset>  → one week of tours (public.tours) MERGED with agent
//        events (public.appointments). Returns full-day events (no 9-5 clamp)
//        with everything the Agenda list, the scrollable week grid, and the
//        detail/edit modals need. All day/time math is Pacific time.
//   POST                  → create; or { action:'invite', id, source } to email
//        the client a calendar (.ics) invite for an existing event.
//   PATCH { id, source, ...}  → edit an event (reschedule / change fields).
//   DELETE { id, source }     → cancel a tour (status) / delete an appointment.
//
// Event `source` is 'tour' | 'appointment'. Times are returned as Pacific
// wall-clock parts (hour/minute) so the client positions them on any grid.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { sendEmail, resendConfigured } from '../resend.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TZ = 'America/Los_Angeles';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const APPT_KINDS = ['call', 'block', 'open', 'meeting'];
const KIND_CLS = { call: 'call', block: 'block', open: 'open', meeting: 'call' };
const ORGANIZER_EMAIL = process.env.RESEND_REPLY_TO || 'SaraSellsCalifornia@gmail.com';
const ORGANIZER_NAME = 'Sara Cooper · Legacy Properties';

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
const dkey = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;

// Pacific wall-clock (Y-M-D H:M) → the matching UTC Date.
function laToUTC(y, m, d, hh, mm) {
  const asUTC = Date.UTC(y, m - 1, d, hh, mm);
  const p = laParts(new Date(asUTC));
  const wallAsUTC = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return new Date(asUTC - (wallAsUTC - asUTC));
}
function timeLabel(hour, minute) {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}
function parseDateTime(date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!dm || !tm) return null;
  const dt = laToUTC(+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]);
  return isNaN(dt) ? null : dt;
}

// ---- iCalendar invite ------------------------------------------------------
function icsStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}
function buildICS({ uid, start, end, summary, description, location, attendeeEmail, attendeeName, stamp }) {
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Legacy Properties//Calendar//EN', 'METHOD:REQUEST', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(stamp)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location ? `LOCATION:${esc(location)}` : null,
    `ORGANIZER;CN=${esc(ORGANIZER_NAME)}:mailto:${ORGANIZER_EMAIL}`,
    attendeeEmail ? `ATTENDEE;CN=${esc(attendeeName || attendeeEmail)};RSVP=TRUE:mailto:${attendeeEmail}` : null,
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();
  const agent = profile.role === 'agent_james' ? 'james' : 'sara';

  try {
    if (req.method === 'GET')    return await listWeek(req, res, supa);
    if (req.method === 'POST')   return await createOrInvite(req, res, supa, agent);
    if (req.method === 'PATCH')  return await editEvent(req, res, supa);
    if (req.method === 'DELETE') return await deleteEvent(req, res, supa);
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---------------------------------------------------------------------------
// GET — one week, all hours
// ---------------------------------------------------------------------------
async function listWeek(req, res, supa) {
  const weekOffset = parseInt(req.query?.week, 10) || 0;
  const now = new Date();
  const today = laParts(now);
  const dowIdx = Math.max(0, DOW.indexOf(today.dow));
  const monday = ymdShift(today.y, today.m, today.d, -dowIdx + 7 * weekOffset);
  const todayKey = dkey(today);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = ymdShift(monday.y, monday.m, monday.d, i);
    days.push({ dow: DOW[i], num: dt.d, date: dkey(dt), is_today: dkey(dt) === todayKey });
  }
  const dayIndex = {};
  days.forEach((d, i) => { dayIndex[d.date] = i; });

  const first = ymdShift(monday.y, monday.m, monday.d, 0);
  const last = ymdShift(monday.y, monday.m, monday.d, 6);
  const range = first.m === last.m
    ? `${MONTHS[first.m - 1]} ${first.d} – ${last.d}, ${last.y}`
    : `${MONTHS[first.m - 1]} ${first.d} – ${MONTHS[last.m - 1]} ${last.d}, ${last.y}`;
  const weekLabel = `${range} · Week ${isoWeek(first.y, first.m, first.d)}`;

  const qStart = new Date(Date.UTC(first.y, first.m - 1, first.d, 12));
  qStart.setUTCDate(qStart.getUTCDate() - 1);
  const qEnd = new Date(Date.UTC(last.y, last.m - 1, last.d, 12));
  qEnd.setUTCDate(qEnd.getUTCDate() + 2);
  const startISO = qStart.toISOString(), endISO = qEnd.toISOString();

  const [toursRes, apptRes] = await Promise.all([
    supa.from('tours')
      .select('id, scheduled_at, duration_minutes, tour_type, status, notes, leads(first_name,last_name,email), properties(address,city)')
      .gte('scheduled_at', startISO).lt('scheduled_at', endISO).neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true }),
    supa.from('appointments')
      .select('id, title, kind, starts_at, duration_minutes, notes, leads(first_name,last_name,email)')
      .gte('starts_at', startISO).lt('starts_at', endISO)
      .order('starts_at', { ascending: true })
  ]);
  if (toursRes.error) return fail(res, 500, `tours: ${toursRes.error.message}`);
  const apptMissing = apptRes.error && /relation .*appointments.* does not exist/i.test(apptRes.error.message || '');
  if (apptRes.error && !apptMissing) return fail(res, 500, `appointments: ${apptRes.error.message}`);

  const events = [];

  for (const t of toursRes.data || []) {
    const start = new Date(t.scheduled_at);
    const p = laParts(start);
    if (dayIndex[dkey(p)] == null) continue;
    const dur = Number(t.duration_minutes) || 30;
    const end = laParts(new Date(start.getTime() + dur * 60000));
    const lead = t.leads || {};
    const prop = t.properties || {};
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Client';
    const kindLabel = t.tour_type === 'video' ? 'Video tour' : 'Tour';
    events.push({
      id: t.id, source: 'tour', cls: t.tour_type === 'video' ? 'call' : 'tour', kind: 'tour',
      title: prop.address ? String(prop.address).split(',')[0] : who,
      sub: `${who}${prop.city ? ' · ' + prop.city : ''}`,
      status: t.status || 'confirmed',
      date: dkey(p), day: dayIndex[dkey(p)], hour: p.hour, minute: p.minute, duration_minutes: dur,
      time_label: timeLabel(p.hour, p.minute), end_label: timeLabel(end.hour, end.minute),
      kind_label: kindLabel,
      client_email: lead.email || null, client_name: who,
      location: prop.address || null,
      edit: {
        source: 'tour', date: dkey(p), time: `${pad2(p.hour)}:${pad2(p.minute)}`,
        duration_minutes: dur, tour_type: t.tour_type || 'in_person',
        email: lead.email || '', notes: t.notes || ''
      }
    });
  }

  for (const a of apptRes.data || []) {
    const start = new Date(a.starts_at);
    const p = laParts(start);
    if (dayIndex[dkey(p)] == null) continue;
    const dur = Number(a.duration_minutes) || 30;
    const end = laParts(new Date(start.getTime() + dur * 60000));
    const lead = a.leads || {};
    const label = a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : 'Event';
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
    events.push({
      id: a.id, source: 'appointment', cls: KIND_CLS[a.kind] || 'block', kind: a.kind || 'block',
      title: a.title || label,
      sub: a.notes || who || label,
      status: 'confirmed',
      date: dkey(p), day: dayIndex[dkey(p)], hour: p.hour, minute: p.minute, duration_minutes: dur,
      time_label: timeLabel(p.hour, p.minute), end_label: timeLabel(end.hour, end.minute),
      kind_label: label,
      client_email: lead.email || null, client_name: who,
      location: null,
      edit: {
        source: 'appointment', kind: a.kind || 'block', title: a.title || '',
        date: dkey(p), time: `${pad2(p.hour)}:${pad2(p.minute)}`,
        duration_minutes: dur, email: lead.email || '', notes: a.notes || ''
      }
    });
  }

  events.sort((x, y) => (x.day - y.day) || (x.hour * 60 + x.minute) - (y.hour * 60 + y.minute));
  return ok(res, { week_offset: weekOffset, week_label: weekLabel, days, events });
}

// ---------------------------------------------------------------------------
// POST — create an event, or send an invite for an existing one
// ---------------------------------------------------------------------------
async function createOrInvite(req, res, supa, agent) {
  const body = await readJson(req);
  if (body?.action === 'invite') return await sendInvite(req, res, supa, body);

  const scheduled = parseDateTime(body?.date, body?.time);
  if (!scheduled) return fail(res, 400, 'valid date (YYYY-MM-DD) and time (HH:MM) are required');
  const duration = Math.max(15, Math.min(480, parseInt(body?.duration_minutes, 10) || 30));
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : null;
  const kind = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : 'tour';

  // Appointment (call / block / open / meeting)
  if (kind !== 'tour') {
    if (!APPT_KINDS.includes(kind)) return fail(res, 400, `kind must be tour or one of: ${APPT_KINDS.join(', ')}`);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return fail(res, 400, 'title is required');
    let leadId = null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email && EMAIL_RE.test(email)) {
      const { data } = await supa.from('leads').select('id').eq('email', email).maybeSingle();
      leadId = data?.id || null;
    }
    const { data: appt, error } = await supa.from('appointments').insert({
      title, kind, starts_at: scheduled.toISOString(), duration_minutes: duration, agent, lead_id: leadId, notes
    }).select('id, title, kind, starts_at, duration_minutes').single();
    if (error) return fail(res, 500, `appointment create: ${error.message}`);
    return ok(res, { appointment: appt, source: 'appointment' });
  }

  // Client tour
  const leadIdIn = typeof body?.lead_id === 'string' ? body.lead_id.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const tourType = body?.tour_type === 'video' ? 'video' : 'in_person';
  if (!leadIdIn && !email) return fail(res, 400, 'lead_id or email is required for a tour');
  if (email && !leadIdIn && !EMAIL_RE.test(email)) return fail(res, 400, 'email is not a valid address');

  let lead = null;
  if (leadIdIn) {
    const { data } = await supa.from('leads').select('id, email').eq('id', leadIdIn).maybeSingle();
    if (!data) return fail(res, 404, 'lead_id not found');
    lead = data;
  } else {
    const { data } = await supa.from('leads').select('id, email').eq('email', email).maybeSingle();
    lead = data || null;
    if (!lead) {
      const { data: created, error: insErr } = await supa.from('leads').insert({
        email, first_name: typeof body?.first_name === 'string' ? body.first_name.trim() : null,
        last_name: typeof body?.last_name === 'string' ? body.last_name.trim() : null,
        source: 'manual', lead_type: 'buyer', assigned_agent: agent, journey_stage: 'touring', pipeline_stage: 'touring'
      }).select('id, email').single();
      if (insErr) return fail(res, 500, `lead create: ${insErr.message}`);
      lead = created;
    }
  }

  const { data: tour, error } = await supa.from('tours').insert({
    lead_id: lead.id, scheduled_at: scheduled.toISOString(), duration_minutes: duration,
    tour_type: tourType, status: 'confirmed', agent, notes
  }).select('id, scheduled_at, duration_minutes, tour_type, status').single();
  if (error) return fail(res, 500, `tour create: ${error.message}`);

  let invite = null;
  if (body?.send_invite && lead.email) {
    invite = await inviteForEvent(supa, 'tour', tour.id).catch((e) => ({ error: e.message }));
  }
  return ok(res, { tour, source: 'tour', lead: { id: lead.id, email: lead.email }, invite });
}

// ---------------------------------------------------------------------------
// PATCH — edit / reschedule
// ---------------------------------------------------------------------------
async function editEvent(req, res, supa) {
  const body = await readJson(req);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const source = body?.source === 'appointment' ? 'appointment' : 'tour';
  if (!id) return fail(res, 400, 'id is required');

  const patch = {};
  if (body.date !== undefined || body.time !== undefined) {
    const scheduled = parseDateTime(body.date, body.time);
    if (!scheduled) return fail(res, 400, 'valid date and time are required');
    patch[source === 'tour' ? 'scheduled_at' : 'starts_at'] = scheduled.toISOString();
  }
  if (body.duration_minutes !== undefined) patch.duration_minutes = Math.max(15, Math.min(480, parseInt(body.duration_minutes, 10) || 30));
  if (typeof body.notes === 'string') patch.notes = body.notes.trim() || null;

  if (source === 'tour') {
    if (body.tour_type !== undefined) patch.tour_type = body.tour_type === 'video' ? 'video' : 'in_person';
    if (body.status !== undefined && ['requested', 'confirmed', 'completed', 'cancelled'].includes(body.status)) patch.status = body.status;
  } else {
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (body.kind !== undefined) {
      if (!APPT_KINDS.includes(String(body.kind))) return fail(res, 400, `kind must be one of: ${APPT_KINDS.join(', ')}`);
      patch.kind = String(body.kind);
    }
  }
  if (!Object.keys(patch).length) return fail(res, 400, 'no updatable fields provided');

  const table = source === 'tour' ? 'tours' : 'appointments';
  const { data, error } = await supa.from(table).update(patch).eq('id', id).select('id').single();
  if (error) return fail(res, 500, `${table} update: ${error.message}`);
  if (!data) return fail(res, 404, 'event not found');
  return ok(res, { updated: true, id, source });
}

// ---------------------------------------------------------------------------
// DELETE — cancel a tour / remove an appointment
// ---------------------------------------------------------------------------
async function deleteEvent(req, res, supa) {
  let body = await readJson(req).catch(() => ({}));
  const id = (typeof body?.id === 'string' && body.id.trim()) || (req.query?.id || '');
  const source = (body?.source || req.query?.source) === 'appointment' ? 'appointment' : 'tour';
  if (!id) return fail(res, 400, 'id is required');

  if (source === 'tour') {
    const { error } = await supa.from('tours').update({ status: 'cancelled' }).eq('id', id);
    if (error) return fail(res, 500, `tour cancel: ${error.message}`);
  } else {
    const { error } = await supa.from('appointments').delete().eq('id', id);
    if (error) return fail(res, 500, `appointment delete: ${error.message}`);
  }
  return ok(res, { deleted: true, id, source });
}

// ---------------------------------------------------------------------------
// Invite emailing
// ---------------------------------------------------------------------------
async function sendInvite(req, res, supa, body) {
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const source = body?.source === 'appointment' ? 'appointment' : 'tour';
  if (!id) return fail(res, 400, 'id is required');
  const result = await inviteForEvent(supa, source, id);
  if (result?.error) return fail(res, 400, result.error);
  return ok(res, result);
}

async function inviteForEvent(supa, source, id) {
  const stamp = new Date();
  let start, dur, summary, location = null, email, name, description;

  if (source === 'tour') {
    const { data: t } = await supa.from('tours')
      .select('scheduled_at, duration_minutes, tour_type, leads(first_name,last_name,email), properties(address,city)')
      .eq('id', id).maybeSingle();
    if (!t) return { error: 'tour not found' };
    const lead = t.leads || {}, prop = t.properties || {};
    email = lead.email; name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'there';
    if (!email) return { error: 'this tour has no client email — add one to the lead first' };
    start = new Date(t.scheduled_at); dur = Number(t.duration_minutes) || 30;
    location = prop.address ? [prop.address, prop.city].filter(Boolean).join(', ') : null;
    summary = t.tour_type === 'video' ? 'Video tour with Sara Cooper · Legacy Properties' : `Home tour · ${prop.address ? String(prop.address).split(',')[0] : 'Legacy Properties'}`;
    description = `Your ${t.tour_type === 'video' ? 'video ' : ''}tour with Sara Cooper, Legacy Properties.${location ? ' Location: ' + location + '.' : ''} Questions? Call (209) 559-4966.`;
  } else {
    const { data: a } = await supa.from('appointments')
      .select('title, kind, starts_at, duration_minutes, leads(first_name,last_name,email)').eq('id', id).maybeSingle();
    if (!a) return { error: 'appointment not found' };
    const lead = a.leads || {};
    email = lead.email; name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'there';
    if (!email) return { error: 'this event has no client email to invite — link a lead with an email' };
    start = new Date(a.starts_at); dur = Number(a.duration_minutes) || 30;
    summary = a.title || 'Appointment with Legacy Properties';
    description = `${a.title || 'Appointment'} with Sara Cooper, Legacy Properties. Questions? Call (209) 559-4966.`;
  }

  const end = new Date(start.getTime() + dur * 60000);
  const p = laParts(start);
  const whenText = `${DOW[(new Date(start).getUTCDay() + 6) % 7]}, ${MONTHS[p.m - 1]} ${p.d} at ${timeLabel(p.hour, p.minute)} (Pacific)`;
  const ics = buildICS({
    uid: `${source}-${id}@legacycalifornia`, start, end, stamp,
    summary, description, location, attendeeEmail: email, attendeeName: name
  });

  if (!resendConfigured()) {
    return { invited: false, skipped: true, reason: 'email is not configured yet (RESEND_API_KEY)', to: email };
  }
  const html = `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#1A1714;">
    <p>Hi ${name},</p>
    <p>You're confirmed for <strong>${summary}</strong>.</p>
    <p><strong>When:</strong> ${whenText}<br>${location ? `<strong>Where:</strong> ${location}<br>` : ''}</p>
    <p>The calendar invite is attached — open it to add this to your calendar. If anything changes, just reply or call me at (209) 559-4966.</p>
    <p>— Sara Cooper<br>Legacy Properties</p>
  </div>`;
  const emailRes = await sendEmail({
    to: email, toName: name, subject: `Invite: ${summary} — ${whenText}`,
    html, attachments: [{ filename: 'invite.ics', content: Buffer.from(ics, 'utf8').toString('base64') }]
  });
  return { invited: !emailRes.skipped, to: email, when: whenText, email: emailRes };
}
