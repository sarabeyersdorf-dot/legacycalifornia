// api/_lib/handlers/sequences-pending-first.js
// GET /api/sequences/pending-first
//
// Lists the pending Email 1 drafts for cold (auto_after_first) sequences — the
// ones awaiting the agent's approval before the rest auto-send. Powers the
// "Approve & send all pending Email 1s" button: the browser fetches this list
// and then approves each through the existing, tested /api/crm/approve (one
// request per message keeps every send inside Vercel's function timeout).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    const { data: rows, error } = await supa
      .from('messages')
      .select('id, subject, created_at, lead_id, sequence_id, leads(first_name,last_name,email,property_address), sequences(send_mode, name)')
      .eq('status', 'pending_approval')
      .eq('direction', 'outbound')
      .eq('channel', 'email')
      .not('sequence_id', 'is', null)
      .order('created_at', { ascending: true });
    if (error) return fail(res, 500, error.message);

    // Only cold sequences hold Email 1 for approval; for those, any pending
    // draft IS Email 1 (steps 2..n auto-send, they never sit as drafts).
    const items = (rows || [])
      .filter((m) => m.sequences && m.sequences.send_mode === 'auto_after_first')
      .map((m) => {
        const l = m.leads || {};
        const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'A lead';
        return { message_id: m.id, lead_id: m.lead_id, name, address: l.property_address || '', subject: m.subject || '' };
      });

    return ok(res, { count: items.length, items });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
