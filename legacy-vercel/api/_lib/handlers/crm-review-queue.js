// api/_lib/handlers/crm-review-queue.js
// GET  /api/crm/review-queue         → list unmatched (pending_review) deal_messages
// POST /api/crm/review-queue         → triage one item
//        { id, action: 'lead' }      → create a lead, link + activate this contact
//        { id, action: 'dismiss' }   → dismiss (never shown again), no lead created
//
// This queue holds ONLY numbers/addresses that didn't match an existing
// contact at intake time (Twilio webhook, or the Phase 2D email-sync cron) —
// matched contacts go straight to 'active' and never appear here. Agent-only.
// Phase 2C (sms/call) + Phase 2D (email — rows with raw_email_address set and
// raw_phone_number null).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail, readJson } from '../cors.js';

function snippet(m) {
  if (m.channel === 'call') {
    const s = m.call_duration_seconds;
    return s == null ? 'Call' : `Call · ${Math.floor(s / 60)}m ${s % 60}s`;
  }
  // sms and email both use `content` (email's content is the Gmail snippet).
  return (m.content || '').slice(0, 140);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  const supa = adminClient();

  try {
    // ---- List pending_review items ---------------------------------------
    if (req.method === 'GET') {
      const { data, error } = await supa
        .from('deal_messages')
        .select('id, direction, channel, content, subject, call_duration_seconds, raw_phone_number, raw_email_address, created_at')
        .eq('status', 'pending_review')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return fail(res, 500, error.message);
      const items = (data || []).map((m) => ({
        id:         m.id,
        phone:      m.raw_phone_number,
        email:      m.raw_email_address,
        subject:    m.subject || null,
        channel:    m.channel,
        direction:  m.direction,
        snippet:    snippet(m),
        created_at: m.created_at
      }));
      return ok(res, { items, count: items.length });
    }

    // ---- Triage one item --------------------------------------------------
    if (req.method === 'POST') {
      const body = await readJson(req);
      const id     = String(body.id || '').trim();
      const action = String(body.action || '').trim();
      if (!id) return fail(res, 400, 'id required');

      const { data: row, error: rowErr } = await supa
        .from('deal_messages')
        .select('id, raw_phone_number, raw_email_address, status')
        .eq('id', id).maybeSingle();
      if (rowErr) return fail(res, 500, rowErr.message);
      if (!row) return fail(res, 404, 'item not found');
      if (row.status !== 'pending_review') return fail(res, 409, `item already ${row.status}`);

      if (action === 'dismiss') {
        // Dismiss just this row — never shown again. No lead created.
        const { error } = await supa.from('deal_messages')
          .update({ status: 'dismissed' }).eq('id', id);
        if (error) return fail(res, 500, error.message);
        return ok(res, { id, status: 'dismissed' });
      }

      if (action === 'lead') {
        // Phase 2D: this row may be a phone-based (sms/call) item or an
        // email-based item — never both, per the raw_phone_number is not
        // null or raw_email_address is not null constraint. Branch on which
        // one is set so the phone path (Phase 2C, unchanged) and the new
        // email path each create the right kind of minimal lead.
        const isEmailItem = !row.raw_phone_number && !!row.raw_email_address;

        if (isEmailItem) {
          const email = String(row.raw_email_address).trim().toLowerCase();
          // Create a minimal lead for this address, then activate + link
          // EVERY pending_review row from the same address (all their mail).
          const { data: lead, error: leadErr } = await supa
            .from('leads')
            .insert({ email, source: 'inbound_email', pipeline_stage: 'new', status: 'active' })
            .select('id, email')
            .single();
          if (leadErr) return fail(res, 500, `could not create lead: ${leadErr.message}`);

          const { data: linked, error: linkErr } = await supa
            .from('deal_messages')
            .update({ status: 'active', contact_id: lead.id })
            .eq('raw_email_address', row.raw_email_address)
            .eq('status', 'pending_review')
            .select('id');
          if (linkErr) return fail(res, 500, linkErr.message);

          return ok(res, { id, status: 'active', contact_id: lead.id, linked: (linked || []).length });
        }

        // Create a minimal lead for this number, then activate + link EVERY
        // pending_review row from the same number (all their texts/calls).
        const { data: lead, error: leadErr } = await supa
          .from('leads')
          .insert({ phone: row.raw_phone_number, source: 'inbound_text', pipeline_stage: 'new', status: 'active' })
          .select('id, phone')
          .single();
        if (leadErr) return fail(res, 500, `could not create lead: ${leadErr.message}`);

        const { data: linked, error: linkErr } = await supa
          .from('deal_messages')
          .update({ status: 'active', contact_id: lead.id })
          .eq('raw_phone_number', row.raw_phone_number)
          .eq('status', 'pending_review')
          .select('id');
        if (linkErr) return fail(res, 500, linkErr.message);

        return ok(res, { id, status: 'active', contact_id: lead.id, linked: (linked || []).length });
      }

      return fail(res, 400, "action must be 'lead' or 'dismiss'");
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
