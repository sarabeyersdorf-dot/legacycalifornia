// api/_lib/handlers/crm-message-delete.js
// POST /api/crm/message-delete   (agent-only)
// Body: { id, source }
//
// Removes a single message from the unified inbox / a contact's conversation.
// Two backing tables, two strategies:
//   • deal_messages (texts & calls) — soft-delete via status='dismissed'. Every
//     reader already hides that status, so it disappears everywhere but stays
//     recoverable, and the CHECK constraint allows the value.
//   • messages (portal / email)     — its status CHECK has no "deleted" value,
//     so the row is removed outright.
//
// `id` accepts the raw table id or the composite ids the UI uses:
//   'dm-<uuid>' or 'd:<uuid>' → deal_messages ;  'm:<uuid>' → messages.
// An explicit `source` ('deal_messages' | 'messages') always wins.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const b = await readJson(req).catch(() => ({}));
  let id = (b?.id != null ? String(b.id) : '').trim();
  let source = (b?.source ? String(b.source) : '').trim();

  // Unwrap the composite ids the UI carries so a caller can just pass what it has.
  if (/^dm-/.test(id)) { source = 'deal_messages'; id = id.slice(3); }
  else if (/^d:/.test(id)) { source = 'deal_messages'; id = id.slice(2); }
  else if (/^m:/.test(id)) { source = 'messages'; id = id.slice(2); }

  if (!id) return fail(res, 400, 'message id required');
  if (source !== 'deal_messages' && source !== 'messages') {
    // Texts/calls are the overwhelming majority of deletes; default there.
    source = 'deal_messages';
  }

  const supa = adminClient();
  try {
    if (source === 'deal_messages') {
      const { error } = await supa.from('deal_messages').update({ status: 'dismissed' }).eq('id', id);
      if (error) return fail(res, 500, error.message);
    } else {
      const { error } = await supa.from('messages').delete().eq('id', id);
      if (error) return fail(res, 500, error.message);
    }
    return ok(res, { deleted: true, source, id });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
