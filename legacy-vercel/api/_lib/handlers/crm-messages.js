// api/_lib/handlers/crm-messages.js
// GET /api/crm/messages   (agent-only)
//
// The unified "who reached out" feed. Inbound client communications live in two
// separate tables and never shared a view before this:
//   • messages       — portal / curated-list questions, inbound email (lead_id set)
//   • deal_messages  — inbound texts & calls from the Twilio number
//                      (contact_id set when the number matched a lead, else null)
// This handler unions the INBOUND rows from both, newest-first, so a text, a
// curated-list question, or an email all land in one list an agent actually
// checks — matched to a lead where possible, or flagged as an unknown number
// that needs triage.
//
// Query: ?limit=<n>  ?since=<ISO>  (since → only rows strictly newer, for polling)

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const CHANNEL_LABEL = { portal: 'Curated list', sms: 'Text', call: 'Call', email: 'Email' };

function preview(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function durLabel(sec) {
  const s = parseInt(sec, 10);
  if (!s || isNaN(s)) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 120, 1), 300);
  const since = typeof req.query?.since === 'string' && req.query.since.trim() ? req.query.since.trim() : null;

  try {
    // 1. Inbound rows from `messages` (portal / email) ----------------------
    let mq = supa.from('messages')
      .select('id, lead_id, direction, channel, body, subject, created_at, leads(first_name, last_name, phone)')
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false }).limit(limit);
    if (since) mq = mq.gt('created_at', since);
    const mRes = await mq;
    if (mRes.error) return fail(res, 500, `messages: ${mRes.error.message}`);

    // 2. Inbound rows from `deal_messages` (texts / calls) ------------------
    let dq = supa.from('deal_messages')
      .select('id, contact_id, direction, channel, content, raw_phone_number, status, call_duration_seconds, created_at')
      .eq('direction', 'inbound').neq('status', 'dismissed')
      .order('created_at', { ascending: false }).limit(limit);
    if (since) dq = dq.gt('created_at', since);
    const dRes = await dq;
    // deal_messages may not exist on very old schemas — degrade to empty.
    const dealRows = dRes.error ? [] : (dRes.data || []);

    // Resolve names for matched deal_messages in one batch.
    const contactIds = [...new Set(dealRows.map((r) => r.contact_id).filter(Boolean))];
    const nameById = new Map();
    if (contactIds.length) {
      const { data: leadRows } = await supa.from('leads').select('id, first_name, last_name, phone').in('id', contactIds);
      for (const l of (leadRows || [])) nameById.set(l.id, { name: [l.first_name, l.last_name].filter(Boolean).join(' '), phone: l.phone });
    }

    const feed = [];

    for (const m of (mRes.data || [])) {
      const lead = m.leads || {};
      const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
      const ch = m.channel === 'email' ? 'email' : (m.channel === 'sms' ? 'sms' : 'portal');
      feed.push({
        key: 'm:' + m.id,
        source: 'messages',
        channel: ch,
        channel_label: CHANNEL_LABEL[ch] || ch,
        lead_id: m.lead_id || null,
        name: name || (lead.phone || null),
        phone: lead.phone || null,
        preview: preview(m.subject ? `${m.subject} — ${m.body}` : m.body, 160),
        created_at: m.created_at,
        status: 'active',
        matched: true,           // messages always carry a lead_id (NOT NULL)
        needs_review: false
      });
    }

    for (const d of dealRows) {
      const info = d.contact_id ? nameById.get(d.contact_id) : null;
      const ch = d.channel === 'call' ? 'call' : 'sms';
      const body = ch === 'call'
        ? ('Inbound call' + (durLabel(d.call_duration_seconds) ? ' · ' + durLabel(d.call_duration_seconds) : ''))
        : (d.content || '');
      feed.push({
        key: 'd:' + d.id,
        source: 'deal_messages',
        channel: ch,
        channel_label: CHANNEL_LABEL[ch] || ch,
        lead_id: d.contact_id || null,
        name: (info && info.name) || d.raw_phone_number || null,
        phone: (info && info.phone) || d.raw_phone_number || null,
        preview: preview(body, 160),
        created_at: d.created_at,
        status: d.status || 'active',
        matched: !!d.contact_id,
        needs_review: d.status === 'pending_review'
      });
    }

    feed.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    const rows = feed.slice(0, limit);
    const unmatched = rows.filter((r) => r.needs_review).length;

    return ok(res, {
      messages: rows,
      count: rows.length,
      unmatched,
      latest: rows.length ? rows[0].created_at : null,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
