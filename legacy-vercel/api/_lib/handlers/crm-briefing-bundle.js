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
import dbTruth      from './crm-reconcile.js';
import dealMessages from './crm-deal-messages.js';
import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { checkSyncKey } from '../sync-key.js';

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

  if (!checkSyncKey(req.query?.key).ok) return fail(res, 401, 'bad key');

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

  // ── Readability controls (Cowork's fetch tool dies on the ~60KB single-line
  // bundle). Two composable escape hatches, either of which makes it readable:
  //   ?sections=db_truth[,proposals,…]  — run/return ONLY the named sections, so
  //       a run that just wants db_truth (expected_dates + agent_overlays +
  //       client_visible_agent_tasks) fetches a few KB instead of 60. This is
  //       what makes the item-6 "new capabilities show up as new db_truth fields"
  //       promise actually reachable. `?only=` is an alias.
  //   ?pretty=1 — indented JSON. The single-line payload defeats line-based
  //       Read/Grep slicing; pretty-printing turns it into thousands of short
  //       lines the consumer can page through. Fixes the whole size class.
  const onlyRaw = String(req.query?.sections ?? req.query?.only ?? '').trim();
  const wantSet = onlyRaw ? new Set(onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const want = (name) => !wantSet || wantSet.has(name);
  const isPretty = ['1', 'true', 'yes'].includes(String(req.query?.pretty || '').toLowerCase());

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
    want('feedback') && section('feedback',  feedback,     { key }),
    want('calendar') && section('calendar',  calendar,     { key, days }),
    // The heavy morning-brief carries the nudges/approvals the briefing needs —
    // lift just those, not the whole AI narrative + rosters.
    want('nudges') && section('nudges',    morningBrief, { key }, (b) => ({
      collection_nudges:  b.collection_nudges  || [],
      timeline_approvals: b.timeline_approvals || [],
      data_gaps:          b.data_gaps          || [],
      party_reconcile:    b.party_reconcile    || []
    })),
    want('proposals') && section('proposals', timeline,     { key, proposals: 'all' }, (b) => ({ proposals: b.proposals || [] })),
    want('timeline') && section('timeline',  timeline,     { key, deal: '__all__' },  (b) => ({ deals: b.deals || [] })),
    // drift is a SUMMARY only — counts by severity (full detail at /drift-check).
    want('drift') && section('drift',     driftCheck,   { key, severity: 'all' },  (b) => (b.counts || { critical: 0, warn: 0, info: 0 })),
    // db_truth — the live-DB ground-truth feed (crm-reconcile): sync freshness,
    // escrow stages, dangerous pending docs, agent_updates read-back, email
    // health, timeline drift. Already compact by design; the verbose `about`
    // prose is dropped (its meaning is summarised in this bundle's manifest).
    want('db_truth') && section('db_truth',  dbTruth,      { key }, (b) => { const { about, generated_at, ...rest } = b; return rest; }),
    // deal_messages — deal correspondence (item 3). Folded in as a bounded
    // SUMMARY only: counts + the most recent subjects, no bodies, so the bundle
    // stays small. Full bodies live at the standalone /deal-messages path.
    want('deal_messages') && section('deal_messages', dealMessages, { key, since: '48h' }, (b) => ({
      since:   b.since || null,
      counts:  b.counts || { matched: 0, unmatched: 0, unmatched_signature_notices: 0, dropped_bulk: 0 },
      deny_list_size: { senders: (b.deny_list?.senders || []).length, domains: (b.deny_list?.domains || []).length },
      // sent_at is the REAL send time or null — never substitute `at` (ingest time),
      // or the briefing would quote ingest times as send times. sent_at_known says
      // which it is.
      recent:  (b.messages || []).slice(0, 15).map((m) => ({
        sent_at: m.sent_at || null, sent_at_known: !!m.sent_at, owner: m.owner || null,
        from: m.from || null, subject: m.subject || null, deal: m.deal || null, address: m.address || null
      })),
      unmatched_recent: (b.unmatched || []).slice(0, 10).map((m) => ({
        sent_at: m.sent_at || null, sent_at_known: !!m.sent_at, owner: m.owner || null,
        from: m.from || null, subject: m.subject || null
      })),
      // Signed/updated documents we couldn't tie to a deal — "go look", not noise.
      unmatched_signature_notices: (b.unmatched_signature_notices || []).slice(0, 10).map((m) => ({
        sent_at: m.sent_at || null, sent_at_known: !!m.sent_at, owner: m.owner || null,
        from: m.from || null, subject: m.subject || null
      }))
    }))
  ].filter(Boolean));   // `false` entries = sections not requested via ?sections=

  // reconcile has side effects (it files proposals) — opt-in only, so a read
  // never surprises anyone. Skipped unless ?reconcile=true AND requested.
  if (want('reconcile')) {
    if (doReconcile) {
      await section('reconcile', timeline, { key, op: 'reconcile' });
    } else {
      sections.reconcile = { status: 'skipped', reason: 'reconcile=false', data: null };
    }
  }

  const payload = {
    generated_at: nowIso,
    // Self-describing surface — this is the "endpoint discovery" answer (item 6).
    // A discovery endpoint that returned a LIST OF URLS is unworkable: Cowork can
    // only fetch a URL that appears literally in its scheduled-task prompt, so a
    // URL learned from a response body is not fetchable — the same wall that
    // rejects SOP-listed URLs. So instead of URLs, this ONE endpoint returns the
    // DATA of every Cowork-facing feed, aggregated server-side. New endpoints are
    // folded in here as new `sections` — so a new capability never needs a prompt
    // edit. Fetch THIS url each run; do not try to hop to the paths below.
    manifest: {
      is_stable_surface: true,
      note: 'One URL, in your prompt permanently. Every Cowork-facing CRM feed is inlined below under `sections`. When Claude Code ships a new endpoint it appears here as a new section — you do NOT need Sara to add its URL to your prompt. The standalone_paths list is reference only; a path discovered here is not fetchable from your environment, and its data is already inlined, so never fetch them.',
      readability: 'If the full bundle is too large for your fetch tool, add ?sections=db_truth (comma-separate for more, e.g. ?sections=db_truth,proposals) to return ONLY those sections, and/or ?pretty=1 for indented, line-sliceable JSON. ?sections=db_truth is the small read for expected_dates + agent_overlays + client_visible_agent_tasks.',
      sections: {
        feedback:      'briefing-feedback: agent replies/attention on briefing tasks + unread agent_updates (marked read on read).',
        calendar:      'briefing-calendar: appointments/tours window.',
        nudges:        'morning-brief (lifted): collection_nudges, timeline_approvals, data_gaps, party_reconcile.',
        proposals:     'timeline proposals=all: pending timeline proposals.',
        timeline:      'timeline deal=__all__: every active deal timeline.',
        drift:         'drift-check summary: counts by severity (full detail at /api/crm/drift-check).',
        db_truth:      'reconcile: live-DB ground truth Cowork cannot see from deals.json — sync freshness, escrow stages, dangerous pending docs, agent_updates read-back, email health, timeline drift, sync_key. ALSO carries expected_dates (SPEC §3: agent-believed coe/acceptance dates with no executed doc yet — agenda-only, never client-facing; labelled by/at/note) and agent_overlays (Phase 2: per-deal list of fields an agent has TAKEN OVER in the CRM — good_to_know, road, client_tasks, client_note, stage, created_in_crm, expected_dates — where the DB overlay WINS and you should STOP authoring that field in deals.json) and client_visible_agent_tasks (§4.1: OPEN agent-authored tasks a client sees on the portal, individually tracked, CRM-owned — do not re-author in deals.json). This is the reachable home for all of them; no separate URL needed.',
        deal_messages: 'deal-messages summary: deal correspondence in the last 48h — counts + recent subjects (no bodies; full bodies at /api/crm/deal-messages). sent_at is the real send time or null (sent_at_known says which) — never ingest time. Includes unmatched_signature_notices: signed/updated e-sign documents we could NOT match to a deal — treat as "go confirm which file", not noise.',
        reconcile:     'timeline reconcile op (side-effecting) — only present when ?reconcile=true.'
      },
      // Reference only — do NOT fetch these; their data is inlined above.
      standalone_paths: {
        db_truth:      '/api/crm/reconcile?key=…',
        deal_messages: '/api/crm/deal-messages?key=…&since=48h',
        drift_full:    '/api/crm/drift-check?key=…&severity=all'
      }
    },
    sections,
    degraded: failed.length > 0,
    failed_sections: failed
  };

  if (wantSet) payload.sections_returned = [...wantSet];   // echo the filter applied

  // ?pretty=1 → indented JSON so a one-line-averse fetch tool can slice it.
  // Same no-store contract as ok(); we just control the serialisation.
  if (isPretty) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    return res.status(200).send(JSON.stringify({ success: true, ...payload }, null, 2));
  }
  return ok(res, payload);
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
