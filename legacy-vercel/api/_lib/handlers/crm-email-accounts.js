// api/_lib/handlers/crm-email-accounts.js
// GET /api/crm/email-accounts
//
// Phase 2D — status for the Settings "Connect Email" card: for each owner
// (sara, james) reports whether a mailbox is connected, which address, and
// when it last synced. Agent-only. NEVER selects refresh_token — that secret
// must never reach any client, agent UI included.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const OWNERS = ['sara', 'james'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  try {
    const supa = adminClient();
    const { data, error } = await supa
      .from('email_accounts')
      // Explicitly NEVER select refresh_token here.
      .select('owner, email_address, last_synced_at, connected_at, active, needs_reconnect, last_sync_error, last_error_at');
    if (error) return fail(res, 500, error.message);

    const byOwner = new Map((data || []).map((r) => [r.owner, r]));
    const accounts = OWNERS.map((owner) => {
      const row = byOwner.get(owner);
      return {
        owner,
        connected:       !!(row && row.active),
        email_address:   row ? row.email_address : null,
        last_synced_at:  row ? row.last_synced_at : null,
        connected_at:    row ? row.connected_at : null,
        needs_reconnect: !!(row && row.needs_reconnect),
        last_sync_error: row ? (row.last_sync_error || null) : null,
        last_error_at:   row ? (row.last_error_at || null) : null
      };
    });

    return ok(res, { accounts });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
