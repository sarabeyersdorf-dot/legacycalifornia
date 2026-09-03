// api/_lib/handlers/crm-idx-status.js
// GET /api/crm/idx-status
//
// A lightweight health check for the two SEPARATE iHomefinder integrations, so
// the CRM can say which is actually live. They are independent, and having the
// IDX search widget on the website gives you NEITHER of them:
//
//   1. behavioral — client browsing events POSTed to /api/idx/behavioral-webhook.
//      Fills "properties viewed" / "last visit". Reads lead_events with
//      source='ihomefinder_idx'.
//   2. listings   — the Client API pulled server-side by /api/idx/sync into
//      public.properties. This is the ONLY thing a standing saved search can
//      match against, because that search runs on a cron with no browser.
//
// The widget renders listings in the visitor's browser from iHomefinder's own
// servers; none of that data reaches this database. Reported separately here
// because "my IDX is working" is true of the widget and can be false of both
// of these — which is exactly how a saved search ends up matching nothing.
//
// Agent-only.

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

    // ---- listing feed: is anything actually importable? ------------------
    // properties rows created by the capture overlay carry only what the browser
    // could scrape; a row from the Client API always carries property_type
    // (normaliseListing defaults it). So a book with zero typed rows has never
    // received a single listing from the feed, whatever the config says.
    const [{ count: propsTotal }, { count: propsFromFeed }, { data: lastSync }] = await Promise.all([
      supa.from('properties').select('id', { count: 'exact', head: true }),
      supa.from('properties').select('id', { count: 'exact', head: true }).not('property_type', 'is', null),
      supa.from('sync_runs').select('status, detail, created_at')
        .eq('job', 'idx-sync').order('created_at', { ascending: false }).limit(1)
        .then((r) => r, () => ({ data: [] }))
    ]);
    const sync = (lastSync && lastSync[0]) || null;

    return ok(res, {
      listings: {
        // Never imported a listing → the standing-search feed is not live,
        // however healthy the website's search widget looks.
        live: (propsFromFeed || 0) > 0,
        properties_total: propsTotal || 0,
        properties_from_feed: propsFromFeed || 0,
        last_sync: sync ? { status: sync.status, at: sync.created_at, detail: sync.detail || null } : null,
        // No heartbeat at all means the sync predates run-logging, or has never
        // been invoked — either way nothing is known about it yet.
        note: sync ? null : 'No idx-sync run recorded yet.'
      },
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
