// api/_lib/handlers/crm-briefing-bundle.js
// GET /api/crm/briefing-bundle?key=<SYNC_SECRET>&days=7&reconcile=true
//
// SPEC_briefing_bundle_and_drift_check.md, Part 1. The morning briefing used to
// make SEVEN separate GETs (feedback, calendar, morning-brief, timeline
// proposals/all, timeline reconcile, timeline all-deals, drift). Each could fail
// independently and quietly degrade the briefing. This is one call, one failure
// surface, one explicit status per section.
//
// Rules honored:
//   1. A failing section NEVER fails the bundle — its status is 'error', it's
//      listed in failed_sections, degraded=true, and the bundle is still 200
//      with every other section intact. Partial data beats no data.
//   2. Never a 200 with an empty body — the documented shape always returns.
//   3. Every section carries generated_at + cache_age_seconds when the
//      underlying handler provides them.
//   4. drift is a summary only (counts by severity); full detail lives at
//      /api/crm/drift-check.
//   5. The seven underlying endpoints keep working as a fallback.
//
// Sections run the real handlers in-process (a capturing res), so there's no
// self-HTTP hop and no base-URL guessing from within the function.

import feedback     from './crm-briefing-feedback.js';
import calendar     from './crm-briefing-calendar.js';
import morningBrief from './crm-morning-brief.js';
import timeline     from './crm-timeline.js';
import driftCheck   from './crm-drift-check.js';
import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';

// Invoke a handler with a synthetic GET request and a res that captures the
// response instead of writing it to the wire. Resolves { status, body }.
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
  if (handleOptions(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');

  const key = req.query?.key;

  // ── compact=1 — a small, self-contained per-deal export (~one row per deal
  // with agent / stage / alerts[] / docs{}). The full bundle and the raw
  // deals.json are both too large for James's Cowork fetch tool (dies ~128 KiB;
  // deals.json is 266 KB, this bundle ~90 KB). This projection stays well under
  // 100 KB and unblocks both. Read-only; no side effects.
  if (['1', 'true', 'yes'].includes(String(req.query?.compact || '').toLowerCase())) {
    return compactBundle(res, key);
  }
  const days = req.query?.days || 7;
  const doReconcile = String(req.query?.reconcile || 'false') === 'true';

  const sections = {};
  const failed = [];
  const nowIso = new Date().toISOString();

  // Run one section; never throws. `pick` selects the section's data shape.
  async function section(name, fn, query, pick) {
    try {
      const { status, body } = await invoke(fn, query);
      const okBody = status >= 200 && status < 300 && body && body.success !== false;
      if (okBody) {
        sections[name] = {
          status: 'ok',
          generated_at: body.generated_at || nowIso,
          cache_age_seconds: body.cache_age_seconds ?? 0,
          data: pick ? pick(body) : stripEnvelope(body)
        };
      } else {
        sections[name] = { status: 'error', error: (body && body.error) || `http ${status}`, data: null };
        failed.push(name);
      }
    } catch (e) {
      sections[name] = { status: 'error', error: e.message || String(e), data: null };
      failed.push(name);
    }
  }

  await Promise.all([
    section('feedback',  feedback,     { key }),
    section('calendar',  calendar,     { key, days }),
    // The heavy morning-brief carries the nudges/approvals the briefing needs —
    // lift just those, not the whole AI narrative + rosters.
    section('nudges',    morningBrief, { key }, (b) => ({
      collection_nudges:  b.collection_nudges  || [],
      timeline_approvals: b.timeline_approvals || [],
      data_gaps:          b.data_gaps          || [],
      party_reconcile:    b.party_reconcile    || []
    })),
    section('proposals', timeline,     { key, proposals: 'all' }, (b) => ({ proposals: b.proposals || [] })),
    section('timeline',  timeline,     { key, deal: '__all__' },  (b) => ({ deals: b.deals || [] })),
    // drift is a SUMMARY only — counts by severity (full detail at /drift-check).
    section('drift',     driftCheck,   { key, severity: 'all' },  (b) => (b.counts || { critical: 0, warn: 0, info: 0 }))
  ]);

  // reconcile has side effects (it files proposals) — opt-in only, so a read
  // never surprises anyone.
  if (doReconcile) {
    await section('reconcile', timeline, { key, op: 'reconcile' });
  } else {
    sections.reconcile = { status: 'skipped', reason: 'reconcile=false', data: null };
  }

  return ok(res, {
    generated_at: nowIso,
    sections,
    degraded: failed.length > 0,
    failed_sections: failed
  });
}

// compact=1 export — one small row per deal, sourced with lean direct queries
// (never the heavy timeline). Shape per deal:
//   { key, address, agent, stage, coe_date, alerts: [...], docs: { name: status } }
// alerts[] are the drift-check findings for that deal (best-effort — a drift
// failure just leaves alerts empty, never fails the export).
async function compactBundle(res, key) {
  const supa = adminClient();
  const nowIso = new Date().toISOString();

  const { data: deals, error: dErr } = await supa.from('deals')
    .select('id, source_key, address, agent, stage, coe_date');
  if (dErr) return fail(res, 500, `deals: ${dErr.message}`);

  const byId = new Map();
  const bySrc = new Map();
  for (const d of (deals || [])) {
    const row = {
      key: d.source_key, address: d.address || null,
      agent: d.agent || null, stage: d.stage || null,
      coe_date: d.coe_date || null, alerts: [], docs: {}
    };
    byId.set(d.id, row);
    if (d.source_key) bySrc.set(d.source_key, row);
  }

  // docs{} — one entry per document: name → status.
  const { data: docs } = await supa.from('deal_documents').select('deal_id, name, status');
  for (const doc of (docs || [])) {
    const row = byId.get(doc.deal_id);
    if (row && doc.name) row.docs[doc.name] = doc.status || 'unknown';
  }

  // alerts[] — group drift-check findings by deal source_key. Best-effort.
  try {
    const { status, body } = await invoke(driftCheck, { key, severity: 'all' });
    if (status >= 200 && status < 300 && body && Array.isArray(body.findings)) {
      for (const f of body.findings) {
        const row = f.deal && bySrc.get(f.deal);
        if (!row) continue;
        const { deal, severity, check, ...extra } = f;
        row.alerts.push({ sev: severity, check, ...extra });
      }
    }
  } catch (_) { /* alerts stay empty rather than fail the export */ }

  const out = [...byId.values()].sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
  return ok(res, { generated_at: nowIso, compact: true, deal_count: out.length, deals: out });
}

// Drop the success flag + the fields lifted to the section wrapper.
function stripEnvelope(body) {
  if (!body || typeof body !== 'object') return body;
  const { success, ...rest } = body;
  return rest;
}
