// api/cron/drift-check.js
// GET /api/cron/drift-check   (Vercel Cron, hourly)  |  ?key=<SYNC_SECRET> (manual)
//
// Runs the READ-ONLY /api/crm/drift-check in-process and makes its critical
// findings LOUD: both agents (Sara + James) get one SMS + email the moment a
// NEW critical drift appears — a client could be looking at something false
// (stage/coe/price mismatch, an orphaned COE, a proposal on a dead deal).
//
// Change-detected via db/051 drift_runs: it pages on the way IN (a key not seen
// in the previous run) and stays quiet while the same drift persists, so it
// never re-pages hourly. Every run is logged for the audit trail regardless.
//
// The drift check itself never writes; this wrapper only reads it + logs a run
// row + (maybe) sends an alert.

import { adminClient } from '../_lib/supabase.js';
import driftCheck from '../_lib/handlers/crm-drift-check.js';
import { alertAgents, deskUrl } from '../_lib/agent-alert.js';
import { ok, fail } from '../_lib/cors.js';
import { checkSyncKey } from '../_lib/sync-key.js';

// Invoke the drift-check handler with a capturing res (same pattern as the
// briefing bundle) so there's no self-HTTP hop.
function invoke(handler, query) {
  return new Promise((resolve) => {
    const req = { method: 'GET', query, headers: { host: 'internal' }, url: '/' };
    const res = {
      _status: 200,
      setHeader() {},
      status(c) { this._status = c; return this; },
      send(body) { let p = body; try { p = typeof body === 'string' ? JSON.parse(body) : body; } catch (_) {} resolve({ status: this._status, body: p }); },
      end(body) { this.send(body); },
      json(body) { resolve({ status: this._status, body }); }
    };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { success: false, error: e.message || String(e) } }));
  });
}

export default async function handler(req, res) {
  // Auth: Vercel Cron (x-vercel-cron header) or a manual ?key=<SYNC_SECRET>.
  const secret     = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const bearer     = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okManual   = checkSyncKey(req.query?.key).ok;
  const okCron     = !!req.headers['x-vercel-cron'] || (cronSecret && bearer === cronSecret);
  if (!okManual && !okCron) return fail(res, 401, 'bad key');

  try {
    const { body } = await invoke(driftCheck, { key: secret, severity: 'all' });
    if (!body || body.success === false) {
      return fail(res, 502, `drift-check failed: ${body?.error || 'unknown'}`);
    }
    const findings = Array.isArray(body.findings) ? body.findings : [];
    const counts = body.counts || { critical: 0, warn: 0, info: 0 };

    const keyOf = (f) => `${f.check}:${f.deal || '-'}`;
    const critical = findings.filter((f) => f.severity === 'critical');
    const critKeys = [...new Set(critical.map(keyOf))].sort();
    const clientVisible = critical.filter((f) => f.client_visible);

    const supa = adminClient();

    // Previous run's critical keys → what's NEW this hour. If the drift_runs
    // table isn't there yet (db/051 not run), we have no throttle state, so we
    // must NOT alert — otherwise every hour re-pages the same drift. Alerting
    // resumes automatically once the migration lands.
    let prevKeys = [], haveState = true;
    try {
      const { data: prev, error } = await supa.from('drift_runs')
        .select('crit_keys').order('ran_at', { ascending: false }).limit(1);
      if (error) haveState = false;
      else prevKeys = (prev && prev[0] && Array.isArray(prev[0].crit_keys)) ? prev[0].crit_keys : [];
    } catch (_) { haveState = false; }
    const prevSet = new Set(prevKeys);
    const newKeys = critKeys.filter((k) => !prevSet.has(k));

    // Alert only when a NEW critical key appears (loud on the way in, quiet while
    // unchanged). Fail-soft: an alert failure never fails the run.
    let alerted = false, alert_result = null;
    if (haveState && newKeys.length) {
      try {
        const lines = critical
          .filter((f) => newKeys.includes(keyOf(f)))
          .map((f) => `• ${f.check} — ${f.address || f.deal}${f.client_visible ? ' (client-visible)' : ''}: ${f.detail || ''}`);
        const cvCount = clientVisible.length;
        const subject = `CRM drift: ${newKeys.length} new critical${cvCount ? ` (${cvCount} client-visible)` : ''}`;
        const desk = deskUrl();
        const sms = `CRM drift-check: ${newKeys.length} new critical finding${newKeys.length === 1 ? '' : 's'}${cvCount ? `, ${cvCount} client-visible` : ''}. ${critical.map((f) => f.deal).filter(Boolean).slice(0, 3).join(', ')}. Open CRM: ${desk}`;
        const text = `Drift-check found new critical drift between the CRM and the master deals.json.\n\n`
          + lines.join('\n')
          + `\n\nTotals — critical: ${counts.critical}, warn: ${counts.warn}, info: ${counts.info}.\n`
          + `Full detail: /api/crm/drift-check?key=…\nOpen the CRM: ${desk}`;
        alert_result = await alertAgents(supa, { subject, sms, text });
        alerted = true;
      } catch (e) { alert_result = { error: e.message }; }
    }

    // Log the run (audit trail + throttle state). Fail-soft.
    try {
      await supa.from('drift_runs').insert({
        critical: counts.critical || 0, warn: counts.warn || 0, info: counts.info || 0,
        crit_keys: critKeys, alerted
      });
    } catch (_) { /* db/051 not run yet — the check still ran, just not logged */ }

    return ok(res, {
      ran_at: new Date().toISOString(),
      counts,
      critical_keys: critKeys,
      new_critical_keys: newKeys,
      client_visible_critical: clientVisible.length,
      alerted,
      alert_result
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
