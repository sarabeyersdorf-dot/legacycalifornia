// api/_lib/handlers/crm-reconcile.js
// GET /api/crm/reconcile?key=<SYNC_SECRET>
//
// A read-only "ground truth" feed for Cowork. Cowork lives in Dropbox and
// reasons from deals.json; it cannot see the repo or the database, so it is
// routinely wrong about DB-backed behavior (governance, the doc pipeline, sync
// freshness, the agent_updates read-back). This endpoint reports the live DB
// state of exactly those things in one small payload Cowork can fetch each run —
// the same key-gated, no-store contract as briefing-feedback — so it stops
// guessing from deals.json about data it can't see.
//
// It writes NOTHING. Every section is independently fail-soft: if a column or
// table isn't present the section returns { _error } instead of failing the
// whole call, so a schema drift degrades one field rather than blinding Cowork.
//
// Field meanings are carried inline in `about` so Cowork, which reads this cold
// with no shared memory, doesn't have to guess what a number means.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { checkSyncKey } from '../sync-key.js';

const iso    = (d) => (d ? new Date(d).toISOString() : null);
const ageSec = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000)) : null);

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  // The dispatcher already sets no-store for the whole CRM surface; set it again
  // defensively so this can never be served stale to a briefing run.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  // Key-gated, headless — same contract as briefing-feedback / agent-updates feed.
  // During a SYNC_SECRET rotation both keys (SYNC_SECRET + SYNC_SECRET_NEXT) are
  // accepted; `keyCheck.which` names which one served this request so the
  // rotation is *observable to Cowork* (it can't read server logs). This is the
  // confirmation channel: Cowork changes its stored key, then reads
  // reconcile.sync_key.key_used here to confirm the new key is serving before
  // Sara retires the old one.
  const keyCheck = checkSyncKey(req.query?.key);
  if (!keyCheck.ok) return fail(res, 401, 'bad key');
  // Server-side breadcrumb (Vercel logs) — names which key served, so a rotation
  // is observable in logs, not just in the payload below.
  if (process.env.SYNC_SECRET_NEXT) console.log(`[reconcile] sync key served: ${keyCheck.which}`);

  const supa = adminClient();

  // Fetch the deal roster once (optional columns fall back), reused across
  // sections so each one doesn't re-query deals.
  let dealRows = [];
  try {
    const r = await supa.from('deals').select('id, source_key, address, stage, coe_date, sale_price');
    if (r.error) throw r.error;
    dealRows = r.data || [];
  } catch (_) {
    try {
      const r2 = await supa.from('deals').select('id, source_key, address, stage');
      dealRows = r2.data || [];
    } catch (_2) { dealRows = []; }
  }
  const dealsById = new Map(dealRows.map((d) => [d.id, d]));

  const out = {
    generated_at: new Date().toISOString(),
    // Which SYNC_SECRET served this request. During a rotation both keys are
    // valid; key_used is 'primary' (SYNC_SECRET) or 'next' (SYNC_SECRET_NEXT).
    // rotation_in_progress is true when both env vars are set — the window in
    // which either key works. See about.sync_key.
    sync_key: { key_used: keyCheck.which, rotation_in_progress: !!process.env.SYNC_SECRET_NEXT },
    about: {
      purpose: 'Live DB truth for Cowork on the things it cannot see from deals.json. Read-only. Newest wins over deals.json where they disagree on DB-backed state.',
      sync_key: 'key_used names which key served this call (primary=SYNC_SECRET, next=SYNC_SECRET_NEXT). Confirmation channel for a key rotation: after Cowork switches to the new key, key_used should read the new key here before Sara retires the old one. rotation_in_progress:true means both keys are currently accepted.',
      sync: 'Freshness of the hourly sync-deals pipeline. last_deal_upsert should be < ~1h old when the cron is healthy.',
      escrow: 'What the DB considers live escrow (stage offer/pending) vs listing/closed. If deals.json says a deal is dead but it shows here as pending, the CRM stage_override or sync is behind.',
      documents: 'pending_client_safe is the dangerous class: a pending doc a client can see. Should be ~0. Anything here is a doc nagging a client (or Sara) to sign something not actually owed.',
      agent_updates: 'Read-back health for the notes-to-Claude log. unread should drain toward 0 and last_marked_read should be recent once briefing-feedback runs.',
      engagement: 'source_of_truth is lead_events (attributable, carries lead_id). collection_events is raw telemetry with no viewer — never quote its open counts as client behavior.',
      email: 'Per-mailbox connection health. needs_reconnect:false with a recent last_synced_at means email sync is fine — do NOT tell Sara to reconnect.',
      timeline_drift: 'Deals whose escrow FELL THROUGH (back to listing/preparing) but still carry client-visible timeline items — a dead escrow showing a client live deadlines. Should be empty. CLOSED deals are excluded on purpose: a completed sale legitimately keeps its finished (done) closing history for the client.',
      expected_dates: 'Agent-believed dates (coe_date/acceptance_date) with no executed document yet (SPEC §3). These are AGENDA-ONLY — they NEVER reach a client portal. Quote them labelled with by/at/note ("COE 9/12 — expected, James 8/27, lender verbal"). state: pending = no confirmed value yet; discrepancy = a confirmed value exists and DISAGREES (put on the agenda, do not overwrite). A promoted expected (confirmed caught up) is cleared by sync-deals and drops off this list.',
      agent_overlays: 'Which deal fields an agent has TAKEN OVER in the CRM (Phase 2). For each field listed, the DB overlay WINS and your deals.json value is ignored on the portal until the agent clears it — so STOP authoring that field for that deal. fields: good_to_know (agent_good_to_know), road (agent_milestones), client_note (agent_note origin:crm), stage (stage_override), created_in_crm (a CRM-authored deal, no deals.json entry), expected_dates. Keep authoring these fields for every deal NOT listed here.'
    }
  };

  // 1. SYNC FRESHNESS — is the hourly pipeline actually running?
  out.sync = await (async () => {
    try {
      const [lastDeal, lastTask, briefTot] = await Promise.all([
        supa.from('deals').select('updated_at').order('updated_at', { ascending: false }).limit(1),
        supa.from('agent_tasks').select('created_at').eq('source', 'briefing').order('created_at', { ascending: false }).limit(1),
        supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source', 'briefing')
      ]);
      const lastDealAt = lastDeal.data?.[0]?.updated_at || null;
      const lastTaskAt = lastTask.data?.[0]?.created_at || null;
      return {
        last_deal_upsert: iso(lastDealAt), last_deal_upsert_age_sec: ageSec(lastDealAt),
        last_briefing_task: iso(lastTaskAt), last_briefing_task_age_sec: ageSec(lastTaskAt),
        briefing_tasks_total: briefTot.count || 0,
        sync_stale: ageSec(lastDealAt) != null && ageSec(lastDealAt) > 5400  // > 1.5h → something's wrong
      };
    } catch (e) { return { _error: e.message }; }
  })();

  // 2. ESCROW — DB's view of each deal's stage, plus the live-escrow set.
  out.escrow = (() => {
    try {
      const by_stage = {};
      for (const d of dealRows) { const s = String(d.stage || '?').toLowerCase(); by_stage[s] = (by_stage[s] || 0) + 1; }
      const live_escrow = dealRows
        .filter((d) => ['offer', 'pending'].includes(String(d.stage || '').toLowerCase()))
        .map((d) => ({ deal: d.source_key || d.id, address: d.address || null, stage: d.stage, coe_date: d.coe_date ?? null, sale_price: d.sale_price ?? null }));
      return { by_stage, live_escrow };
    } catch (e) { return { _error: e.message }; }
  })();

  // 3. DOCUMENTS — pending totals, and the dangerous pending+client_safe class.
  out.documents = await (async () => {
    try {
      const { data, error } = await supa.from('deal_documents').select('deal_id, status, client_safe, name, doc_type');
      if (error) throw error;
      const rows = data || [];
      const pending = rows.filter((r) => r.status === 'pending');
      const pendingClientSafe = pending.filter((r) => r.client_safe === true);
      const pending_by_stage = {};
      for (const r of pending) {
        const st = String(dealsById.get(r.deal_id)?.stage || '?').toLowerCase();
        pending_by_stage[st] = (pending_by_stage[st] || 0) + 1;
      }
      return {
        total: rows.length,
        pending: pending.length,
        pending_by_stage,
        pending_client_safe: pendingClientSafe.length,
        pending_client_safe_docs: pendingClientSafe.slice(0, 25).map((r) => ({
          deal: dealsById.get(r.deal_id)?.source_key || r.deal_id,
          address: dealsById.get(r.deal_id)?.address || null,
          name: r.name, doc_type: r.doc_type
        }))
      };
    } catch (e) { return { _error: e.message }; }
  })();

  // 4. AGENT_UPDATES — read-back health.
  out.agent_updates = await (async () => {
    try {
      const [unread, oldest, lastRead] = await Promise.all([
        supa.from('agent_updates').select('id', { count: 'exact', head: true }).eq('read_by_briefing', false),
        supa.from('agent_updates').select('created_at').eq('read_by_briefing', false).order('created_at', { ascending: true }).limit(1),
        supa.from('agent_updates').select('read_by_briefing_at').eq('read_by_briefing', true).order('read_by_briefing_at', { ascending: false }).limit(1)
      ]);
      const lastReadAt = lastRead.data?.[0]?.read_by_briefing_at || null;
      return {
        unread: unread.count || 0,
        oldest_unread: iso(oldest.data?.[0]?.created_at || null),
        last_marked_read: iso(lastReadAt),
        readback_healthy: ageSec(lastReadAt) != null && ageSec(lastReadAt) < 172800  // read within 48h
      };
    } catch (e) { return { _error: e.message }; }
  })();

  // 5. ENGAGEMENT — which table is truth, and recent attributable signal.
  out.engagement = await (async () => {
    try {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: le } = await supa.from('lead_events').select('event_type, created_at').gte('created_at', since);
      const lead_events_7d_by_type = {};
      for (const e of (le || [])) { const t = e.event_type || '?'; lead_events_7d_by_type[t] = (lead_events_7d_by_type[t] || 0) + 1; }
      let collection_events_7d = null;
      try {
        const { count } = await supa.from('collection_events').select('id', { count: 'exact', head: true }).gte('created_at', since);
        collection_events_7d = count || 0;
      } catch (_) { /* table absent */ }
      return { source_of_truth: 'lead_events', lead_events_7d_by_type, collection_events_7d };
    } catch (e) { return { _error: e.message }; }
  })();

  // 6. EMAIL — mailbox connection health (kills false "reconnect Sara" alarms).
  out.email = await (async () => {
    try {
      const { data, error } = await supa.from('email_accounts').select('owner, needs_reconnect, last_synced_at');
      if (error) throw error;
      return (data || []).map((a) => ({
        owner: a.owner, needs_reconnect: !!a.needs_reconnect,
        last_synced_at: iso(a.last_synced_at), last_synced_age_sec: ageSec(a.last_synced_at)
      }));
    } catch (e) { return { _error: e.message }; }
  })();

  // 7. TIMELINE DRIFT — deals off escrow still carrying client-visible timeline.
  out.timeline_drift = await (async () => {
    try {
      const { data, error } = await supa.from('deal_timeline_items').select('deal_id, client_visible');
      if (error) throw error;
      const visByDeal = {};
      for (const t of (data || [])) { if (t.client_visible) visByDeal[t.deal_id] = (visByDeal[t.deal_id] || 0) + 1; }
      const offenders = Object.entries(visByDeal).map(([deal_id, n]) => {
        const d = dealsById.get(deal_id);
        const stage = d ? String(d.stage || '').toLowerCase() : null;
        // A CLOSED deal legitimately keeps its completed (done) closing timeline as
        // history — that is not drift. Only a FELL-THROUGH escrow (back to
        // listing/preparing) showing a client a live timeline is the defect.
        return (stage && !['offer', 'pending', 'closed'].includes(stage))
          ? { deal: d?.source_key || deal_id, address: d?.address || null, stage, client_visible_items: n }
          : null;
      }).filter(Boolean);
      return { off_escrow_with_client_visible_timeline: offenders };
    } catch (e) { return { _error: e.message }; }
  })();

  // 8. EXPECTED DATES (SPEC §3) — agent beliefs with no executed doc yet. Agenda
  // only; never rendered to a client. Fail-soft: pre-089 schema returns _error.
  out.expected_dates = await (async () => {
    try {
      const { data, error } = await supa.from('deals')
        .select('source_key, address, agent_overrides, coe_date, acceptance_date, ' +
          'coe_date_expected, coe_date_expected_by, coe_date_expected_at, coe_date_expected_note, ' +
          'acceptance_date_expected, acceptance_date_expected_by, acceptance_date_expected_at, acceptance_date_expected_note');
      if (error) throw error;
      const confirmedOf = (row, f) => {
        const ov = (row.agent_overrides && typeof row.agent_overrides === 'object') ? row.agent_overrides : {};
        return ov[f] ?? row[f] ?? null;
      };
      const items = [];
      for (const row of (data || [])) {
        for (const f of ['coe_date', 'acceptance_date']) {
          const exp = row[`${f}_expected`];
          if (!exp) continue;
          const confirmed = confirmedOf(row, f);
          const state = confirmed ? (String(confirmed) === String(exp) ? 'promoted_pending_clear' : 'discrepancy') : 'pending';
          items.push({
            deal: row.source_key, address: row.address || null, field: f,
            expected: exp, expected_by: row[`${f}_expected_by`] || null,
            expected_at: iso(row[`${f}_expected_at`]), note: row[`${f}_expected_note`] || null,
            confirmed, state
          });
        }
      }
      return { count: items.length, items };
    } catch (e) { return { _error: e.message }; }
  })();

  // 9. AGENT OVERLAYS (Phase 2) — which deal fields an agent has taken over in the
  // CRM, so Cowork knows what NOT to author in deals.json anymore. For each listed
  // field the DB overlay WINS and Cowork's deals.json value is ignored on the
  // portal until the agent clears it. Fail-soft: a missing column just omits its
  // flag rather than failing the section.
  out.agent_overlays = await (async () => {
    try {
      const { data, error } = await supa.from('deals')
        .select('source_key, address, agent_good_to_know, agent_buyer_good_to_know, ' +
          'agent_milestones, agent_buyer_milestones, agent_note, stage_override, ' +
          'created_in_crm, coe_date_expected, acceptance_date_expected');
      if (error) throw error;
      const isArr = (v) => Array.isArray(v) && v.length > 0;
      const deals = [];
      for (const d of (data || [])) {
        const fields = [];
        if (isArr(d.agent_good_to_know) || isArr(d.agent_buyer_good_to_know)) fields.push('good_to_know');
        if (isArr(d.agent_milestones)   || isArr(d.agent_buyer_milestones))   fields.push('road');
        if (d.agent_note && typeof d.agent_note === 'object' && d.agent_note.origin === 'crm') fields.push('client_note');
        if (d.stage_override) fields.push('stage');
        if (d.created_in_crm) fields.push('created_in_crm');
        if (d.coe_date_expected || d.acceptance_date_expected) fields.push('expected_dates');
        if (fields.length) deals.push({ deal: d.source_key, address: d.address || null, fields });
      }
      return { count: deals.length, deals };
    } catch (e) { return { _error: e.message }; }
  })();

  return ok(res, out);
}
