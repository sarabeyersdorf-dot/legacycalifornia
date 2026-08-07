// api/_lib/handlers/crm-idx-status.js
// GET /api/crm/idx-status
//
// A lightweight health check for the iHomefinder (IDX) behavioral feed, so the
// CRM can show a "last IDX event received" indicator on the Today page. Until
// iHomefinder is pointed at /api/idx/behavioral-webhook, this returns
// received:false and the indicator reads "waiting" — an at-a-glance way to tell
// whether the passive-browsing feed is actually live yet.
//
// Reads only lead_events with source='ihomefinder_idx'. Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  try {
    const supa = adminClient();

    // Most recent IDX event, with the lead it belongs to (for a friendly label).
    const { data: rows, error } = await supa
      .from('lead_events')
      .select('created_at, event_type, lead_id, leads(first_name, last_name, email)')
      .eq('source', 'ihomefinder_idx')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return fail(res, 500, error.message);

    const last = (rows && rows[0]) || null;

    // Totals: all-time and last 24h, so the indicator can show momentum.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [{ count: total }, { count: last24h }] = await Promise.all([
      supa.from('lead_events').select('id', { count: 'exact', head: true }).eq('source', 'ihomefinder_idx'),
      supa.from('lead_events').select('id', { count: 'exact', head: true }).eq('source', 'ihomefinder_idx').gte('created_at', since)
    ]);

    let name = null;
    if (last && last.leads) {
      name = [last.leads.first_name, last.leads.last_name].filter(Boolean).join(' ') || last.leads.email || null;
    }

    return ok(res, {
      received:   !!last,
      last_event: last ? {
        created_at: last.created_at,
        event_type: last.event_type,
        lead_id:    last.lead_id,
        lead_name:  name
      } : null,
      count_total: total || 0,
      count_24h:   last24h || 0
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
