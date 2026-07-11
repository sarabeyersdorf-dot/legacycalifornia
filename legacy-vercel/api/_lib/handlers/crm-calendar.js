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
const APPT_KINDS = ['call', 'block', 'open', 'meeting', 'listing_appt', 'showing', 'follow_up', 'inspection'];
// Map each kind to one of the four calendar colour classes (tour/call/block/open).
const KIND_CLS = {
  call: 'call', block: 'block', open: 'open', meeting: 'call',
  listing_appt: 'open', showing: 'tour', follow_up: 'call', inspection: 'block'
};
// Short human label per kind (the little tag on each event).
const KIND_LABEL = {
  call: 'Call', block: 'Block', open: 'Open house', meeting: 'Meeting',
  listing_appt: 'Listing appt', showing: 'Showing', follow_up: 'Follow-up', inspection: 'Inspection'
};
// A sensible default title when the agent doesn't type one — inspections fold in
// their sub-type ("Home inspection"), everything else uses its kind label.
function defaultTitle(kind, subKind) {
  if (kind === 'inspection') return subKind ? `${subKind} inspection` : 'Inspection';
  return KIND_LABEL[kind] || 'Event';
}
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
function buildICS({ uid, start, end, summary, description, location, attendeeEmail, attendeeName, attendees = [], stamp }) {
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const att = [];
  if (attendeeEmail) att.push({ email: attendeeEmail, name: attendeeName });
  for (const a of attendees) if (a && a.email && !att.some((x) => x.email === a.email)) att.push(a);
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
    ...att.map((a) => `ATTENDEE;CN=${esc(a.name || a.email)};RSVP=TRUE:mailto:${a.email}`),
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
  // span: how many weeks in one payload (month grid asks for 5).
  const span = Math.min(Math.max(parseInt(req.query?.span, 10) || 1, 1), 6);
  const now = new Date();
  const today = laParts(now);
  const dowIdx = Math.max(0, DOW.indexOf(today.dow));
  const monday = ymdShift(today.y, today.m, today.d, -dowIdx + 7 * weekOffset);
  const todayKey = dkey(today);

  const days = [];
  for (let i = 0; i < span * 7; i++) {
    const dt = ymdShift(monday.y, monday.m, monday.d, i);
    days.push({ dow: DOW[i % 7], num: dt.d, month: dt.m, date: dkey(dt), is_today: dkey(dt) === todayKey });
  }
  const dayIndex = {};
  days.forEach((d, i) => { dayIndex[d.date] = i; });

  const first = ymdShift(monday.y, monday.m, monday.d, 0);
  const last = ymdShift(monday.y, monday.m, monday.d, span * 7 - 1);
  const range = first.m === last.m
    ? `${MONTHS[first.m - 1]} ${first.d} – ${last.d}, ${last.y}`
    : `${MONTHS[first.m - 1]} ${first.d} – ${MONTHS[last.m - 1]} ${last.d}, ${last.y}`;
  const weekLabel = `${range} · Week ${isoWeek(first.y, first.m, first.d)}`;

  const qStart = new Date(Date.UTC(first.y, first.m - 1, first.d, 12));
  qStart.setUTCDate(qStart.getUTCDate() - 1);
  const qEnd = new Date(Date.UTC(last.y, last.m - 1, last.d, 12));
  qEnd.setUTCDate(qEnd.getUTCDate() + 2);
  const startISO = qStart.toISOString(), endISO = qEnd.toISOString();

  const apptQuery = (cols) => supa.from('appointments').select(cols)
    .gte('starts_at', startISO).lt('starts_at', endISO)
    .order('starts_at', { ascending: true });
  const APPT_COLS    = 'id, lead_id, title, kind, sub_kind, starts_at, duration_minutes, notes, visibility, client_label, leads(first_name,last_name,email)';
  const APPT_COLS_FB = 'id, lead_id, title, kind, starts_at, duration_minutes, notes, visibility, client_label, leads(first_name,last_name,email)';

  let [toursRes, apptRes] = await Promise.all([
    supa.from('tours')
      .select('id, lead_id, scheduled_at, duration_minutes, tour_type, status, notes, visibility, client_label, leads(first_name,last_name,email), properties(address,city)')
      .gte('scheduled_at', startISO).lt('scheduled_at', endISO).neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true }),
    apptQuery(APPT_COLS)
  ]);
  if (toursRes.error) return fail(res, 500, `tours: ${toursRes.error.message}`);
  // Degrade gracefully if 027 (sub_kind) hasn't run yet — re-query without it.
  if (apptRes.error && /sub_kind/i.test(apptRes.error.message || '')) apptRes = await apptQuery(APPT_COLS_FB);
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
      lead_id: t.lead_id || null, shared: t.visibility === 'client', client_label: t.client_label || null,
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
    const label = KIND_LABEL[a.kind] || (a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : 'Event');
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
    events.push({
      id: a.id, source: 'appointment', cls: KIND_CLS[a.kind] || 'block', kind: a.kind || 'block',
      title: a.title || label,
      sub: a.notes || who || label,
      status: 'confirmed',
      date: dkey(p), day: dayIndex[dkey(p)], hour: p.hour, minute: p.minute, duration_minutes: dur,
      time_label: timeLabel(p.hour, p.minute), end_label: timeLabel(end.hour, end.minute),
      kind_label: label, sub_kind: a.sub_kind || null,
      client_email: lead.email || null, client_name: who,
      lead_id: a.lead_id || null, shared: a.visibility === 'client', client_label: a.client_label || null,
      location: null,
      edit: {
        source: 'appointment', kind: a.kind || 'block', title: a.title || '', sub_kind: a.sub_kind || null,
        date: dkey(p), time: `${pad2(p.hour)}:${pad2(p.minute)}`,
        duration_minutes: dur, email: lead.email || '', notes: a.notes || ''
      }
    });
  }

  // ---- Tie each event to its deal (for colour-coding + the by-deal filter) --
  // Events carry a lead_id; deal_parties maps that lead to a deal. Resolve in
  // two small batched queries, then stamp deal_key/deal_address on each event.
  const evLeadIds = [...new Set(events.map((e) => e.lead_id).filter(Boolean))];
  if (evLeadIds.length) {
    const { data: parties } = await supa.from('deal_parties').select('lead_id, deal_id').in('lead_id', evLeadIds);
    const dealIds = [...new Set((parties || []).map((p) => p.deal_id).filter(Boolean))];
    if (dealIds.length) {
      const { data: dRows } = await supa.from('deals').select('id, source_key, address, stage').in('id', dealIds);
      const dealById = new Map((dRows || []).map((d) => [d.id, d]));
      const leadToDeal = new Map();
      for (const p of (parties || [])) {
        const d = dealById.get(p.deal_id);
        if (d && d.source_key && !leadToDeal.has(p.lead_id)) leadToDeal.set(p.lead_id, d);
      }
      for (const e of events) {
        const d = e.lead_id ? leadToDeal.get(e.lead_id) : null;
        if (d) { e.deal_key = d.source_key; e.deal_address = d.address || null; e.deal_stage = d.stage || null; }
      }
    }
  }

  // The dropdown's deal list — the agent's live (non-closed) transactions, so a
  // deal can be picked even in a week where it has no events. In-escrow first so
  // those get the leading (most distinct) colours.
  const STAGE_ORDER = { pending: 0, offer: 1, listing: 2, preparing: 3 };
  let deals = [];
  const { data: dealList } = await supa.from('deals')
    .select('source_key, address, stage')
    .in('side', ['listing', 'seller', 'both', 'buyer'])
    .in('stage', ['pending', 'offer', 'listing', 'preparing']);
  deals = (dealList || [])
    .filter((d) => d.source_key)
    .map((d) => ({ key: d.source_key, address: d.address || d.source_key, stage: d.stage }))
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9) || String(a.address).localeCompare(String(b.address)));

  events.sort((x, y) => (x.day - y.day) || (x.hour * 60 + x.minute) - (y.hour * 60 + y.minute));
  return ok(res, { week_offset: weekOffset, week_label: weekLabel, days, events, deals });
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

  // Appointment (call / block / open / meeting / listing_appt / showing /
  // follow_up / inspection). A client email is optional — supplying one links
  // the event to that lead so it can be shared to their portal.
  if (kind !== 'tour') {
    if (!APPT_KINDS.includes(kind)) return fail(res, 400, `kind must be tour or one of: ${APPT_KINDS.join(', ')}`);
    const subKind = (kind === 'inspection' && typeof body?.sub_kind === 'string') ? (body.sub_kind.trim() || null) : null;
    let title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) title = defaultTitle(kind, subKind);   // structured types self-title
    let leadId = null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email && EMAIL_RE.test(email)) {
      const { data } = await supa.from('leads').select('id').eq('email', email).maybeSingle();
      leadId = data?.id || null;
    }
    const rowBase = { title, kind, starts_at: scheduled.toISOString(), duration_minutes: duration, agent, lead_id: leadId, notes };
    let ins = await supa.from('appointments').insert({ ...rowBase, sub_kind: subKind })
      .select('id, title, kind, starts_at, duration_minutes').single();
    // Degrade gracefully if 027 (sub_kind) hasn't been run yet — the sub-type is
    // still carried in the derived title, so nothing is lost.
    if (ins.error && /sub_kind/i.test(ins.error.message || '')) {
      ins = await supa.from('appointments').insert(rowBase).select('id, title, kind, starts_at, duration_minutes').single();
    }
    if (ins.error) return fail(res, 500, `appointment create: ${ins.error.message}`);
    let invite = null;
    if (body?.send_invite && leadId) {
      invite = await inviteForEvent(supa, 'appointment', ins.data.id, body?.invitees || []).catch((e) => ({ error: e.message }));
    }
    return ok(res, { appointment: ins.data, source: 'appointment', invite });
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
        source: 'manual', lead_type: 'buyer', deal_side: 'buyer', assigned_agent: agent, journey_stage: 'touring', pipeline_stage: 'active'
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
    invite = await inviteForEvent(supa, 'tour', tour.id, body?.invitees || []).catch((e) => ({ error: e.message }));
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
    if (body.sub_kind !== undefined) {
      patch.sub_kind = typeof body.sub_kind === 'string' && body.sub_kind.trim() ? body.sub_kind.trim() : null;
    }
  }
  if (!Object.keys(patch).length) return fail(res, 400, 'no updatable fields provided');

  const table = source === 'tour' ? 'tours' : 'appointments';
  let { data, error } = await supa.from(table).update(patch).eq('id', id).select('id').single();
  // Degrade gracefully if 027 (sub_kind) hasn't run yet.
  if (error && /sub_kind/i.test(error.message || '')) {
    const { sub_kind, ...safe } = patch;
    ({ data, error } = await supa.from(table).update(safe).eq('id', id).select('id').single());
  }
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

async function inviteForEvent(supa, source, id, extraInvitees = []) {
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
  // Both agents ride along as attendees so the .ics lands on their external
  // calendars too; extra invitees (TCs, lenders, co-op agents) are attendees
  // AND receive the invite email.
  let agentAttendees = [];
  try {
    const { data: ags } = await supa.from('agents').select('name, email').in('agent_key', ['sara', 'james']);
    agentAttendees = (ags || []).filter((a) => a.email).map((a) => ({ email: a.email, name: a.name }));
  } catch (_) {}
  const invitees = (extraInvitees || [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e) && e !== (email || '').toLowerCase())
    .slice(0, 8)
    .map((e) => ({ email: e }));
  const ics = buildICS({
    uid: `${source}-${id}@legacycalifornia`, start, end, stamp,
    summary, description, location, attendeeEmail: email, attendeeName: name,
    attendees: [...invitees, ...agentAttendees]
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
  const attachment = [{ filename: 'invite.ics', content: Buffer.from(ics, 'utf8').toString('base64') }];
  const emailRes = await sendEmail({
    to: email, toName: name, subject: `Invite: ${summary} — ${whenText}`,
    html, attachments: attachment
  });
  // Extra invitees get the same invite (fail-soft per recipient).
  for (const inv of invitees) {
    try { await sendEmail({ to: inv.email, subject: `Invite: ${summary} — ${whenText}`, html, attachments: attachment }); } catch (_) {}
  }
  return { invited: !emailRes.skipped, to: email, also_invited: invitees.map((i) => i.email), when: whenText, email: emailRes };
}
