// api/_lib/handlers/crm-drift-check.js
// GET /api/crm/drift-check?key=<SYNC_SECRET>&severity=all
//
// Read-only diagnostic (SPEC_briefing_bundle_and_drift_check.md, Part 2). Three
// of the four 2026-08-07 bugs were the same shape: the CRM database drifted from
// the master deals.json and nothing noticed (433 E Hwy 4 sat as pending/COE 8-10
// for two days after the escrow was cancelled). This makes that comparison a
// first-class, scheduled thing.
//
// The master copy is read from its SOURCE — the GitHub copy the publish job
// pulls into the bundle — NOT from whatever Supabase currently holds, so a
// broken publish can't hide behind "no drift". Never writes anything.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { timelineEvents } from '../deal-timeline.js';

const GH_OWNER = 'sarabeyersdorf-dot';
const GH_REPO  = 'legacycalifornia';
const GH_BRANCH = 'main';
const GH_PATH  = 'legacy-vercel/data/deals.json';

const ESCROW = new Set(['pending', 'offer']);           // "live" stages
const DEAD   = new Set(['closed', 'cancelled', 'listing', 'preparing', 'inactive', 'dispute', 'dead']);

const normStage = (s) => String(s || '').toLowerCase().trim();
const money = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[^0-9.]/g, '')) || null);
const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);

// Fetch the master deals.json from GitHub (works on a private repo; mirrors
// publish-from-dropbox). Falls back to the build-bundled copy only if GitHub is
// unreachable — and says so, so a fallback can't masquerade as the live master.
async function fetchMaster() {
  const token = process.env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`;
  try {
    const r = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/vnd.github+json'
      }
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const j = await r.json();
    const text = Buffer.from(j.content, 'base64').toString('utf-8');
    return { data: JSON.parse(text), source: 'github', fetched_at: new Date().toISOString() };
  } catch (e) {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    return { data: req('../../../data/deals.json'), source: `bundle (github unreachable: ${e.message})`, fetched_at: new Date().toISOString() };
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');
  const wantSeverity = String(req.query?.severity || 'all').toLowerCase();

  try {
    const supa = adminClient();
    const { data: master, source: masterSource, fetched_at } = await fetchMaster();
    const masterDeals = (master.deals || []);
    const masterById = new Map(masterDeals.map((d) => [d.id, d]));

    // Supabase state.
    const [dealsR, itemsR, propsR, tasksR] = await Promise.all([
      supa.from('deals').select('id, source_key, address, stage, stage_override, coe_date, escrow_open_date, loan_contingency_days, sale_price, side, timeline, milestones, escrow_officer, title_company, co_agent, listing_meta, updated_at'),
      supa.from('deal_timeline_items').select('deal_id, key, title, due_date, status, kind').then((x) => x, () => ({ data: [] })),
      supa.from('deal_timeline_proposals').select('deal_id, item_key, change, status').then((x) => x, () => ({ data: [] })),
      supa.from('agent_tasks').select('source_key, client, title, done, source').then((x) => x, () => ({ data: [] }))
    ]);
    if (dealsR.error) return fail(res, 500, `deals: ${dealsR.error.message}`);
    const crmDeals = dealsR.data || [];
    const crmBySrc = new Map(crmDeals.map((d) => [d.source_key, d]));
    const crmById  = new Map(crmDeals.map((d) => [d.id, d]));

    const itemsByDeal = new Map();
    for (const it of (itemsR.data || [])) { if (!itemsByDeal.has(it.deal_id)) itemsByDeal.set(it.deal_id, []); itemsByDeal.get(it.deal_id).push(it); }
    const propsByDeal = new Map();
    for (const p of (propsR.data || [])) { if (!propsByDeal.has(p.deal_id)) propsByDeal.set(p.deal_id, []); propsByDeal.get(p.deal_id).push(p); }

    // last_publish_at — the most recent time sync wrote a deal row. Best proxy
    // available without a dedicated publish log (noted in the finding).
    let lastPublishAt = null;
    for (const d of crmDeals) if (d.updated_at && (!lastPublishAt || d.updated_at > lastPublishAt)) lastPublishAt = d.updated_at;

    // Window for orphan_calendar: only FUTURE events are phantom deadlines. A
    // closed deal's historical COE (a past date) is not drift.
    const todayStr = new Date().toISOString().slice(0, 10);
    const horizonStr = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

    const findings = [];
    const add = (severity, check, deal, extra) => findings.push({
      severity, check, deal: deal || null,
      address: extra?.address ?? (masterById.get(deal)?.address || crmBySrc.get(deal)?.address || null),
      master: extra?.master ?? null, crm: extra?.crm ?? null,
      detail: extra?.detail || '', client_visible: !!extra?.client_visible
    });

    // ---- CRITICAL: publish_stale ----------------------------------------
    if (master.lastUpdated && lastPublishAt && dateOnly(master.lastUpdated) > dateOnly(lastPublishAt)) {
      add('critical', 'publish_stale', null, {
        master: master.lastUpdated, crm: dateOnly(lastPublishAt),
        detail: `Master lastUpdated ${master.lastUpdated} is newer than the last deal write ${dateOnly(lastPublishAt)} — the publish path is behind (last_publish_at is a max(updated_at) proxy).`
      });
    }

    // ---- Per-deal checks over the union of both sources ------------------
    const allIds = new Set([...masterById.keys(), ...crmBySrc.keys()]);
    for (const id of allIds) {
      const m = masterById.get(id);
      const c = crmBySrc.get(id);

      // deal_only_in_one_source (INFO)
      if (!m || !c) {
        add('info', 'deal_only_in_one_source', id, {
          address: (m || c)?.address || null,
          master: m ? 'present' : 'absent', crm: c ? 'present' : 'absent',
          detail: m ? 'In master deals.json but not in Supabase.' : 'In Supabase but not in master deals.json.'
        });
        continue;
      }

      const mStage = normStage(m.stage);
      const cStage = normStage(c.stage_override || c.stage);   // effective stage the CRM surfaces
      const mLive = ESCROW.has(mStage);

      // stage_mismatch (CRITICAL)
      if (mStage !== cStage) {
        const viaOverride = c.stage_override && normStage(c.stage_override) !== normStage(c.stage);
        add('critical', 'stage_mismatch', id, {
          master: m.stage || null, crm: c.stage_override || c.stage || null, client_visible: true,
          detail: `Master ${m.stage} ≠ CRM ${c.stage_override || c.stage}${viaOverride ? ` (stale stage_override='${c.stage_override}' over base '${c.stage}')` : ''}.`
        });
      }
      // coe_mismatch (CRITICAL)
      if (dateOnly(m.closingDate) !== dateOnly(c.coe_date)) {
        add('critical', 'coe_mismatch', id, {
          master: dateOnly(m.closingDate), crm: dateOnly(c.coe_date), client_visible: true,
          detail: `Master closingDate ${dateOnly(m.closingDate) || 'null'} ≠ CRM coe_date ${dateOnly(c.coe_date) || 'null'}.`
        });
      }
      // price_mismatch (CRITICAL)
      if (money(m.salePrice) !== money(c.sale_price)) {
        add('critical', 'price_mismatch', id, {
          master: money(m.salePrice), crm: money(c.sale_price), client_visible: true,
          detail: `Master salePrice ${money(m.salePrice)} ≠ CRM sale_price ${money(c.sale_price)}.`
        });
      }

      const items = itemsByDeal.get(c.id) || [];
      const props = propsByDeal.get(c.id) || [];

      // milestone_status_mismatch (WARN) — an item still 'upcoming' in the CRM
      // that the master shows as satisfied (e.g. 695 Feather: escrow_open / emd /
      // tds / spq / nhd all upcoming in the CRM, all done in master).
      const SATISFIED = /executed|received|signed|on file|accepted|filed|complete|final|waived/i;
      const mdocs = m.docs || {};
      const masterSatisfies = (key) => {
        const k = String(key || '').toLowerCase();
        if (k === 'escrow_open') return !!m.openEscrowDate;
        const tokenByKey = { emd: 'EMD', tds: 'TDS', spq: 'SPQ', nhd: 'NHD' };
        const tok = tokenByKey[k];
        if (!tok) return false;
        const v = mdocs[tok];
        const raw = v && typeof v === 'object' ? (v.status ?? v.state ?? v.value) : v;
        return !!raw && SATISFIED.test(String(raw));
      };
      for (const it of items) {
        if (normStage(it.status) === 'upcoming' && masterSatisfies(it.key)) {
          add('warn', 'milestone_status_mismatch', id, {
            crm: `${it.key} upcoming`, master: 'satisfied',
            detail: `Item '${it.key}' is 'upcoming' in the CRM but satisfied in master deals.json.`
          });
        }
      }

      // orphan_timeline (CRITICAL) — dead deal, live timeline items
      if (!mLive) {
        const upcoming = items.filter((it) => normStage(it.status) === 'upcoming');
        if (upcoming.length) {
          add('critical', 'orphan_timeline', id, {
            master: m.stage, crm: `${upcoming.length} upcoming item(s)`, client_visible: true,
            detail: `Deal is ${m.stage} in master but has ${upcoming.length} timeline item(s) still 'upcoming' (${upcoming.map((i) => i.key).join(', ')}). A stage exit should retire them.`
          });
        }
        // orphan_calendar (CRITICAL) — dead deal still generates FUTURE calendar
        // events (past dates on a closed deal are history, not drift).
        let ev = [];
        try { ev = timelineEvents(c, { todayStr, endStr: horizonStr }) || []; } catch (_) { ev = []; }
        if (ev.length) {
          add('critical', 'orphan_calendar', id, {
            master: m.stage, crm: `${ev.length} event(s)`, client_visible: true,
            detail: `Deal is ${m.stage} in master but its timeline still generates ${ev.length} calendar event(s) (${ev.map((e) => e.type || 'event').join(', ')}).`
          });
        }
        // proposal_on_dead_deal (CRITICAL)
        const pend = props.filter((p) => normStage(p.status) === 'pending');
        if (pend.length) {
          add('critical', 'proposal_on_dead_deal', id, {
            master: m.stage, crm: `${pend.length} pending proposal(s)`,
            detail: `Deal is ${m.stage} in master but has ${pend.length} pending timeline proposal(s).`
          });
        }
      }

      // rejected_reproposed (WARN) — a pending proposal that matches a prior rejection
      const rejected = props.filter((p) => normStage(p.status) === 'rejected');
      for (const p of props.filter((x) => normStage(x.status) === 'pending')) {
        const match = rejected.find((r) => r.item_key === p.item_key && JSON.stringify(r.change || {}) === JSON.stringify(p.change || {}));
        if (match) {
          add('warn', 'rejected_reproposed', id, {
            crm: p.item_key, detail: `Pending proposal on '${p.item_key}' matches a previously rejected one (same change) — a rejection that didn't stick.`
          });
        }
      }

      // contingency_after_coe (WARN)
      if (c.coe_date) {
        for (const it of items) {
          if (it.kind === 'contingency' && it.due_date && dateOnly(it.due_date) > dateOnly(c.coe_date)) {
            add('warn', 'contingency_after_coe', id, {
              crm: `${it.key} due ${dateOnly(it.due_date)}`,
              detail: `Contingency '${it.key}' due ${dateOnly(it.due_date)} falls after COE ${dateOnly(c.coe_date)}.`
            });
          }
        }
      }

      // (next_pointer omitted: the milestones model carries no 'next' flag, so
      // the check can't be evaluated without inventing one — it would false-flag
      // every live deal. Revisit if milestones gain an explicit next-open marker.)

      // INFO — missing_commission / missing_contact on live deals
      if (mLive) {
        const commission = (m.listing && m.listing.commission) || m.commission || (m.listingMeta && m.listingMeta.commission) || null;
        if (!commission) add('info', 'missing_commission', id, { detail: 'Live deal has no listing.commission.' });
        const cx = m.contacts || {};
        const missingContacts = ['escrow', 'lender', 'title'].filter((k) => !cx[k]);
        if (missingContacts.length) add('info', 'missing_contact', id, { detail: `Live deal missing contact(s): ${missingContacts.join(', ')}.` });
      }
    }

    // ---- WARN: task_on_closed_deal --------------------------------------
    for (const t of (tasksR.data || [])) {
      if (t.done || !t.source_key) continue;
      const c = crmBySrc.get(t.source_key);
      const m = c ? masterById.get(t.source_key) : null;
      if (m && DEAD.has(normStage(m.stage))) {
        add('warn', 'task_on_closed_deal', t.source_key, {
          crm: t.title || null, detail: `Open agent_task on a ${m.stage} deal: "${t.title}".`
        });
      }
    }

    const order = { critical: 0, warn: 1, info: 2 };
    findings.sort((a, b) => (order[a.severity] - order[b.severity]) || a.check.localeCompare(b.check));
    const counts = { critical: 0, warn: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;

    const filtered = wantSeverity === 'all' ? findings : findings.filter((f) => f.severity === wantSeverity);

    return ok(res, {
      generated_at: new Date().toISOString(),
      master: { version: master.version ?? null, lastUpdated: master.lastUpdated ?? null, source: masterSource, fetched_at },
      last_publish_at: lastPublishAt,
      counts,
      findings: filtered
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
