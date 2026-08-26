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
    // The agent's REPLIES live in `messages` (outbound), keyed by lead_id — the
    // SAME leads.id as deal_messages.contact_id. deal_messages is inbound-only
    // for email, so without merging these an email flag could NEVER clear: a
    // reply lands in `messages`, which this lane never read (Cowork, 8/26). Pull
    // each contact's latest outbound so a contact whose inbound predates a logged
    // reply drops off — the merge is what makes the lane capable of clearing.
    let latestOutByLead = new Map();
    if (ids.length) {
      let lq = supa.from('leads').select('id, first_name, last_name, email, phone, status, assigned_agent').in('id', ids).eq('status', 'active');
      if (!broker) lq = lq.eq('assigned_agent', me);
      const [{ data: ls }, { data: outs }] = await Promise.all([
        lq,
        supa.from('messages').select('lead_id, created_at')
          .in('lead_id', ids).eq('direction', 'outbound')
          .order('created_at', { ascending: false })
      ]);
      leadsById = new Map((ls || []).map((l) => [l.id, l]));
      for (const o of (outs || [])) {
        if (o.lead_id && !latestOutByLead.has(o.lead_id)) latestOutByLead.set(o.lead_id, o.created_at);
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
      // Answered? A logged outbound reply newer than their inbound clears it.
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
