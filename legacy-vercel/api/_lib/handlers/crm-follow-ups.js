// api/_lib/handlers/crm-follow-ups.js
// /api/crm/follow-ups   (agent-only)
//
//   GET  → the daily "Work the day" action list: a ranked, deduped set of items
//          that need a touch, drawn from three sources —
//            1. new inbound leads not yet worked (portal / website form),
//            2. follow-up reminders due or overdue (the Set-a-reminder ones),
//            3. contacts whose last message is theirs (unanswered).
//   POST { op } → act on one item without leaving the page:
//            { op:'reminder-done',   appointment_id }
//            { op:'reminder-snooze', appointment_id, days? }
//            { op:'dismiss-message', contact_id }
//          (a lead's "I reached out" reuses POST /api/crm/log-contact.)
//
// Deliberately EXCLUDES the cold sphere: the leads lane only pulls real inbound
// leads (source inbound_email/website_form/ihomefinder_idx) with no logged
// contact — never the thousands of imported 'manual' contacts, which would bury
// the list. Everything is capped so this stays a workable day, not a wall.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const DAY = 24 * 3600 * 1000;
const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');
const fullName = (l) => [l?.first_name, l?.last_name].filter(Boolean).join(' ').trim();
const digits = (p) => String(p || '').replace(/[^\d]/g, '');

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const past = ms >= 0;
  const m = Math.abs(ms) / 60000;
  let s;
  if (m < 1) s = 'just now';
  else if (m < 60) s = `${Math.round(m)}m`;
  else if (m < 1440) s = `${Math.round(m / 60)}h`;
  else s = `${Math.round(m / 1440)}d`;
  if (s === 'just now') return s;
  return past ? `${s} ago` : `in ${s}`;
}

const PORTAL_FROM_NOTES = (notes) => {
  const m = /Hot lead from ([^—.]+?)(?:\s*—|\.)/i.exec(String(notes || ''));
  return m ? m[1].trim() : null;
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();
  try {
    if (req.method === 'POST') return await act(supa, req, res);
    if (req.method === 'GET')  return await list(supa, profile, res);
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function list(supa, profile, res) {
  const broker = profile.role === 'agent_sara' || profile.role === 'admin';
  const me = agentKey(profile);
  const sinceLeads = new Date(Date.now() - 45 * DAY).toISOString();
  const sinceMsgs  = new Date(Date.now() - 21 * DAY).toISOString();
  const dueBefore  = new Date(Date.now() + 1 * DAY).toISOString(); // overdue + due within ~today

  const byLead = new Map();   // lead_id → merged item
  const items = [];
  const add = (it) => {
    if (it.lead_id && byLead.has(it.lead_id)) {
      const ex = byLead.get(it.lead_id);
      ex.reasons.push(...it.reasons);
      ex.priority = Math.max(ex.priority, it.priority);
      if (it.appointment_id) ex.appointment_id = it.appointment_id;
      ex.actions = [...new Set([...ex.actions, ...it.actions])];
      return;
    }
    items.push(it);
    if (it.lead_id) byLead.set(it.lead_id, it);
  };

  // ── 1. New inbound leads not yet worked ────────────────────────────────────
  {
    let q = supa.from('leads')
      .select('id, first_name, last_name, email, phone, source, temperature, created_at, last_contact_at, notes, assigned_agent, deal_side')
      .eq('status', 'active')
      .in('source', ['inbound_email', 'website_form', 'ihomefinder_idx'])
      .is('last_contact_at', null)
      .gte('created_at', sinceLeads)
      .order('created_at', { ascending: false })
      .limit(30);
    if (!broker) q = q.eq('assigned_agent', me);
    const { data } = await q;
    for (const l of (data || [])) {
      const ageDays = (Date.now() - new Date(l.created_at).getTime()) / DAY;
      const portal = PORTAL_FROM_NOTES(l.notes) || ({ inbound_email: 'a portal', website_form: 'your website', ihomefinder_idx: 'your IDX search' })[l.source];
      add({
        key: `lead:${l.id}`, kind: 'new_lead', lead_id: l.id, appointment_id: null,
        name: fullName(l) || l.email || l.phone || 'New lead',
        subtitle: [portal ? `New lead · ${portal}` : 'New lead', l.email || (l.phone ? digits(l.phone) : '')].filter(Boolean).join(' · '),
        reasons: [`New lead from ${portal || 'a portal'} — no reply yet (${relTime(l.created_at)})`],
        when: l.created_at,
        priority: ageDays < 1 ? 92 : ageDays < 3 ? 78 : 60,
        phone: l.phone || null, email: l.email || null,
        actions: ['draft', 'call', 'text', 'email', 'open', 'contacted']
      });
    }
  }

  // ── 2. Follow-up reminders due or overdue ──────────────────────────────────
  {
    const COLS = 'id, lead_id, title, kind, starts_at, notes, completed_at, leads(first_name,last_name,email,phone)';
    const run = (cols) => {
      let q = supa.from('appointments').select(cols)
        .in('kind', ['follow_up', 'call'])
        .lte('starts_at', dueBefore)
        .order('starts_at', { ascending: true })
        .limit(40);
      return q;
    };
    let { data, error } = await run(COLS).is('completed_at', null);
    // Degrade gracefully if 075 (completed_at) hasn't migrated yet.
    if (error && /completed_at/i.test(error.message || '')) {
      ({ data } = await run('id, lead_id, title, kind, starts_at, notes, leads(first_name,last_name,email,phone)'));
    }
    for (const a of (data || [])) {
      const overdue = new Date(a.starts_at).getTime() < Date.now();
      const lead = a.leads || {};
      add({
        key: `appt:${a.id}`, kind: 'reminder', lead_id: a.lead_id || null, appointment_id: a.id,
        name: fullName(lead) || a.title || 'Reminder',
        subtitle: [(a.kind === 'call' ? 'Call' : 'Follow-up'), a.title].filter(Boolean).join(' · '),
        reasons: [`${a.kind === 'call' ? 'Call' : 'Follow-up'} ${overdue ? 'overdue' : 'due'} · ${relTime(a.starts_at)}${a.notes ? ' — ' + String(a.notes).slice(0, 80) : ''}`],
        when: a.starts_at,
        priority: overdue ? 96 : 72,
        phone: lead.phone || null, email: lead.email || null,
        actions: [...(a.lead_id ? ['draft', 'open'] : []), 'call', 'text', 'email', 'done', 'snooze']
      });
    }
  }

  // ── 3. Unanswered — the last message from this contact is theirs ────────────
  {
    const run = (cols) => supa.from('deal_messages').select(cols)
      .not('contact_id', 'is', null).neq('status', 'dismissed')
      .gte('created_at', sinceMsgs)
      .order('created_at', { ascending: false }).limit(400);
    let { data, error } = await run('id, contact_id, direction, channel, content, subject, created_at');
    if (error && /subject/i.test(error.message || '')) {
      ({ data } = await run('id, contact_id, direction, channel, content, created_at'));
    }
    const latestByContact = new Map();
    for (const m of (data || [])) {           // desc order → first seen is newest
      if (!latestByContact.has(m.contact_id)) latestByContact.set(m.contact_id, m);
    }
    const unanswered = [...latestByContact.values()].filter((m) => m.direction === 'inbound');
    const ids = unanswered.map((m) => m.contact_id);
    let leadsById = new Map();
    // The agent's REPLIES are split across TWO tables, and which one a reply
    // lands in depends only on WHERE she typed it:
    //   • lead-card composer  → `messages`      (crm-message-send.js)
    //   • deal/contact thread → `deal_messages` (crm-deal-messages.js)
    // Inbound texts and emails always land in `deal_messages`. So a reply typed
    // in the lead card is invisible to a latest-direction read of deal_messages
    // alone, and the contact stays flagged "you haven't replied" forever.
    //
    // This merge used to cover EMAIL ONLY (`.eq('channel','email')`), on the
    // assumption that "text/call clear off deal_messages". They don't: 21 of the
    // outbound SMS in the book sit in `messages`, and every one of them was a
    // real reply that could never clear its flag. Bev Woltjer, 9/3: she texted in
    // at 17:29, Sara texted back at 17:32 from the lead card, and the lane still
    // said "you haven't replied yet". Fixed by merging EVERY channel, and by
    // letting ANY newer non-blast outbound clear the flag regardless of channel —
    // texting back an emailer is a reply, and this lane's only question is
    // whether the ball is still in Sara's court.
    //
    // BUT a bulk send reaches these contacts too, and it is NOT a reply. Counting
    // any newer outbound as a reply let a 200-recipient Ledger blast silently
    // clear genuinely-open threads (Cowork 4th pass). We discriminate by FAN-OUT
    // on TIME: any ~2-min window that reached BULK_MIN_RECIPIENTS+ distinct
    // recipients is a blast and never counts as a reply. Keyed on time, NOT
    // subject — a mail-merge that personalises the subject per recipient evades a
    // subject key but is the same blast (Cowork 5th pass: 27 sends / 27 subjects
    // in 7s). The threshold is 3 because the largest GENUINE 1:1 reply burst in
    // the data is 2; a false clear loses work, a stuck flag only annoys, so we err
    // toward excluding. Fan-out is counted PER CHANNEL so a text burst and an
    // email blast can't pool into one bucket.
    const BULK_MIN_RECIPIENTS = 3;                                   // genuine 1:1 max is 2 (Cowork 5th pass)
    const bucketOf = (ts) => Math.floor(new Date(ts).getTime() / 120000); // 2-min bucket
    let latestOutByLead = new Map();                                // newest non-blast outbound touch, any channel
    if (ids.length) {
      let lq = supa.from('leads').select('id, first_name, last_name, email, phone, status, assigned_agent').in('id', ids).eq('status', 'active');
      if (!broker) lq = lq.eq('assigned_agent', me);
      const [{ data: ls }, { data: outs }] = await Promise.all([
        lq,
        supa.from('messages').select('lead_id, created_at, channel')
          .in('lead_id', ids).eq('direction', 'outbound')
          .order('created_at', { ascending: false })
      ]);
      leadsById = new Map((ls || []).map((l) => [l.id, l]));

      // Which of these candidate outbounds are blasts? Detect them by FAN-OUT on
      // TIME ALONE, NOT subject. A mail-merge that personalises the subject per
      // recipient ("What happened to <address>?" prospecting — 27 sends in 7s)
      // lands every send in its own subject bucket and evades a subject-keyed
      // rule, yet it's the same kind of blast as the Ledger (Cowork 5th pass).
      // Any 2-min window that reached >=N distinct recipients ON ONE CHANNEL is
      // bulk; a genuine 1:1 reply reaches one (largest true reply group is 2).
      // The outbound tables are small (a few thousand rows in the lane's window),
      // so count across all of them, not just our candidates.
      const bulkBuckets = new Set();                                // "<channel>|<bucket>" keys that are blasts
      const fanKey = (channel, ts) => `${channel || ''}|${bucketOf(ts)}`;
      {
        const safe = (p) => p.then((r) => r, () => ({ data: [] }));
        const [{ data: fanA }, { data: fanB }] = await Promise.all([
          safe(supa.from('messages').select('lead_id, created_at, channel')
            .eq('direction', 'outbound').gte('created_at', sinceMsgs).limit(5000)),
          safe(supa.from('deal_messages').select('contact_id, created_at, channel')
            .eq('direction', 'outbound').gte('created_at', sinceMsgs).limit(5000))
        ]);
        const recipsByBucket = new Map();
        const tally = (who, ts, channel) => {
          if (!who) return;
          const k = fanKey(channel, ts);
          let set = recipsByBucket.get(k); if (!set) { set = new Set(); recipsByBucket.set(k, set); }
          set.add(who);
        };
        for (const r of (fanA || [])) tally(r.lead_id, r.created_at, r.channel);
        for (const r of (fanB || [])) tally(r.contact_id, r.created_at, r.channel);
        for (const [k, set] of recipsByBucket) if (set.size >= BULK_MIN_RECIPIENTS) bulkBuckets.add(k);
      }
      const isBlast = (ts, channel) => bulkBuckets.has(fanKey(channel, ts));
      // Newest non-blast outbound per contact, across BOTH tables and ALL
      // channels. `outs` is already newest-first; the deal_messages side is
      // fetched here because a lead can have an outbound there that is newer
      // than its own newest inbound only in the merged view.
      const noteOut = (who, ts, channel) => {
        if (!who || isBlast(ts, channel)) return;                   // newsletter, not a reply
        const prev = latestOutByLead.get(who);
        if (!prev || new Date(ts).getTime() > new Date(prev).getTime()) latestOutByLead.set(who, ts);
      };
      for (const o of (outs || [])) noteOut(o.lead_id, o.created_at, o.channel);
      {
        const { data: dOuts } = await supa.from('deal_messages')
          .select('contact_id, created_at, channel')
          .in('contact_id', ids).eq('direction', 'outbound').neq('status', 'dismissed')
          .order('created_at', { ascending: false })
          .then((r) => r, () => ({ data: [] }));
        for (const o of (dOuts || [])) noteOut(o.contact_id, o.created_at, o.channel);
      }
    }
    // The only true noise is agents testing their own system — exclude their own
    // and test addresses. NOT bulk-send replies: a person on a 264-recipient
    // newsletter hitting reply is a hand-raise, the highest-value inbound a
    // listing agent gets (Cowork retraction, 8/26).
    const isTestContact = (l) => {
      const em = String(l.email || '').toLowerCase();
      if (/^sarasellscalifornia(\+[^@]*)?@gmail\.com$/.test(em)) return true;
      if (em === 'jlbeyersdorf@gmail.com') return true;
      const nm = `${l.first_name || ''} ${l.last_name || ''}`.toLowerCase();
      return /\btest\b/.test(nm) || nm.includes('cowork');
    };
    for (const m of unanswered) {
      const l = leadsById.get(m.contact_id);
      if (!l) continue; // archived/converted or not this agent's
      if (isTestContact(l)) continue; // agents testing their own system
      // Answered? ANY individual (non-blast) outbound newer than their inbound
      // clears the flag, whatever channel it went out on and whichever table it
      // landed in. Cross-channel counts on purpose: texting back someone who
      // emailed is a reply, and the lane's only question is whether the ball is
      // still in Sara's court.
      const outAt = latestOutByLead.get(m.contact_id);
      if (outAt && new Date(outAt).getTime() > new Date(m.created_at).getTime()) continue;
      const ageDays = (Date.now() - new Date(m.created_at).getTime()) / DAY;
      const ch   = m.channel === 'email' ? 'Email' : m.channel === 'call' ? 'Missed call' : 'Text';
      const verb = m.channel === 'email' ? 'emailed' : m.channel === 'call' ? 'called' : 'texted';
      const back = m.channel === 'call' ? "you haven't called back" : "you haven't replied";
      const who  = fullName(l) || l.email || l.phone || 'They';
      add({
        key: `msg:${m.contact_id}`, kind: 'unanswered', lead_id: l.id, appointment_id: null,
        name: fullName(l) || l.email || l.phone || 'Contact',
        subtitle: [`${ch} · awaiting your reply`, m.subject ? String(m.subject).slice(0, 60) : (m.content ? String(m.content).slice(0, 60) : '')].filter(Boolean).join(' · '),
        reasons: [`${who} ${verb} ${relTime(m.created_at)} — ${back} yet`],
        when: m.created_at,
        priority: ageDays < 1 ? 88 : ageDays < 3 ? 80 : 66,
        phone: l.phone || null, email: l.email || null,
        actions: ['draft', 'call', 'text', 'email', 'open', 'dismiss']
      });
    }
  }

  items.sort((a, b) => b.priority - a.priority || new Date(a.when) - new Date(b.when));
  const top = items.slice(0, 30).map((it) => ({ ...it, reason: it.reasons[0], sub_reasons: it.reasons.slice(1) }));

  const counts = {
    new_leads:  items.filter((i) => i.kind === 'new_lead').length,
    reminders:  items.filter((i) => i.kind === 'reminder').length,
    unanswered: items.filter((i) => i.kind === 'unanswered').length,
    total: items.length
  };
  return ok(res, { items: top, counts, generated_at: new Date().toISOString() });
}

async function act(supa, req, res) {
  const b = await readJson(req);
  const op = b?.op;

  if (op === 'reminder-done') {
    if (!b?.appointment_id) return fail(res, 400, 'appointment_id required');
    const { error } = await supa.from('appointments')
      .update({ completed_at: new Date().toISOString() }).eq('id', b.appointment_id);
    if (error) return fail(res, 500, error.message);
    return ok(res, { done: true });
  }

  if (op === 'reminder-snooze') {
    if (!b?.appointment_id) return fail(res, 400, 'appointment_id required');
    const days = Math.min(Math.max(parseInt(b?.days, 10) || 1, 1), 30);
    const when = new Date(Date.now() + days * DAY).toISOString();
    const { error } = await supa.from('appointments')
      .update({ starts_at: when }).eq('id', b.appointment_id);
    if (error) return fail(res, 500, error.message);
    return ok(res, { snoozed_to: when });
  }

  if (op === 'dismiss-message') {
    if (!b?.contact_id) return fail(res, 400, 'contact_id required');
    const { error } = await supa.from('deal_messages')
      .update({ status: 'dismissed' })
      .eq('contact_id', b.contact_id).eq('direction', 'inbound').neq('status', 'dismissed');
    if (error) return fail(res, 500, error.message);
    return ok(res, { dismissed: true });
  }

  return fail(res, 400, `unknown op: ${op}`);
}
