// api/cron/timeline-scan.js
// GET /api/cron/timeline-scan   (Vercel cron — daily, before the morning brief)
//
// For every deal in escrow ('pending'):
//   1. Seed the CA-template timeline if the deal has none yet.
//   2. EXTENSION-AWARE dates (Sara, 2026-07-12): the deal's `timeline` JSON
//      (synced verbatim from deals.json) is the source of truth for deadline
//      dates. Explicit extension dates (timeline.extensions.loan = ISO date)
//      and day-count overrides (timeline.overrides.loan = 34, from
//      acceptance) recompute each contingency + COE due date; stale item
//      due_dates are corrected in place, audit-trailed as pre-approved
//      'auto-doc' proposals, so the client page shows post-ETA dates.
//   3. Clock-paused deals (timeline.clockStart present and null — e.g.
//      bankruptcy-court sales) never get deadline or action proposals.
//   4. If an executed ETA/extension is on file in deals.json docs but NO new
//      date is recorded for a passed contingency, the old deadline is void —
//      we do NOT nag "confirm removal"; the deal lands in `needs_info` for
//      the morning brief so the new date gets recorded.
//   5. Otherwise unchanged: date-passed / doc-evidence / due-soon items file
//      PENDING proposals that wait for the agent.

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';
import { seedDeal } from '../_lib/handlers/crm-timeline.js';
import { DOC_EVIDENCE, expectedDueByKey } from '../_lib/timeline-template.js';
import { createRequire } from 'module';
const requireJson = createRequire(import.meta.url);

const CONT = { cont_inspection: 'inspection', cont_appraisal: 'appraisal', cont_title: 'title', cont_insurance: 'insurance', cont_loan: 'loan' };
const ISO = /^\d{4}-\d{2}-\d{2}/;
const addDays = (iso, n) => new Date(new Date(iso.slice(0, 10) + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const changeKey = (c) => { try { return JSON.stringify(c); } catch (_) { return String(c); } };

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okCron = !!req.headers['x-vercel-cron'] || (cronSecret ? bearer === cronSecret : true);
  if (!okCron) return fail(res, 401, 'cron secret invalid');
  res.setHeader('Cache-Control', 'no-store');

  const supa = adminClient();
  const today = new Date().toISOString().slice(0, 10);
  const soon  = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const out = { seeded: [], proposed: 0, corrected_dates: 0, needs_info: [], paused: [], deals: 0 };

  // deals.json ships in the bundle — it carries the extension/override terms.
  let srcById = {};
  try {
    const file = requireJson('../../data/deals.json');
    for (const d of (Array.isArray(file) ? file : (file.deals || []))) srcById[d.id] = d;
  } catch (_) {}

  try {
    const { data: deals, error } = await supa.from('deals').select('*').eq('stage', 'pending').limit(40);
    if (error) return fail(res, 500, error.message);

    for (const deal of (deals || [])) {
      out.deals += 1;
      try {
        const s = await seedDeal(supa, deal);
        if (s.seeded) out.seeded.push({ deal: deal.source_key, items: s.seeded });
      } catch (_) { continue; }

      const src = srcById[deal.source_key] || {};
      const tl = deal.timeline || src.timeline || {};
      const paused = ('clockStart' in tl) && !tl.clockStart;
      if (paused) out.paused.push(deal.source_key);
      const hasExtDoc = Object.entries(src.docs || {}).some(([k, v]) => {
        const raw = v && typeof v === 'object' ? (v.status ?? v.state ?? '') : v;
        return /^ETA|extension/i.test(k) && /executed|signed|filed/i.test(String(raw || ''));
      });

      // Authoritative due date per item key, from deals.json timeline + deal
      // columns (extensions, <c>Contingency dates, coe). One source of truth so
      // a stale offset (Bug 3) or a null-seeded date (Bug 4) self-heals here.
      const expected = expectedDueByKey({ ...deal, timeline: deal.timeline || src.timeline || null });

      const [{ data: items }, { data: props }, { data: docs }] = await Promise.all([
        supa.from('deal_timeline_items').select('*').eq('deal_id', deal.id),
        supa.from('deal_timeline_proposals').select('item_id, item_key, change, status')
          .eq('deal_id', deal.id).in('status', ['pending', 'rejected']),
        supa.from('deal_documents').select('name, doc_type, created_at').eq('deal_id', deal.id)
      ]);
      const pending = new Set((props || []).filter((p) => p.status === 'pending').map((p) => p.item_id));
      // Rejected changes, keyed item_key → set of change payloads Sara already
      // said no to. We never re-propose an equivalent change (Bug 1: the same
      // walk-through "done" was re-created five mornings after four rejections).
      const rejected = new Map();
      for (const p of (props || [])) {
        if (p.status !== 'rejected') continue;
        const k = p.item_key || '';
        if (!rejected.has(k)) rejected.set(k, new Set());
        rejected.get(k).add(changeKey(p.change));
      }
      const addr = [deal.address, deal.city].filter(Boolean).join(', ');

      const propose = async (item, change, reason) => {
        if (pending.has(item.id)) return;
        // Suppress anything Sara has already rejected for this item+change.
        const rej = rejected.get(item.key);
        if (rej && rej.has(changeKey(change))) { out.suppressed_rejected = (out.suppressed_rejected || 0) + 1; return; }
        const { error: pErr } = await supa.from('deal_timeline_proposals').insert({
          deal_id: deal.id, item_id: item.id, item_key: item.key, address: addr,
          change, reason, source: 'cron'
        });
        if (!pErr) { pending.add(item.id); out.proposed += 1; }
      };

      // Correct stale/missing due dates in place FIRST, for every live item —
      // including ones seeded with a null date. This is an unambiguous,
      // document/contract-backed change, so it is applied directly and logged to
      // deal_activity — it does NOT go through the approval queue (Bug 2: writing
      // an auto-approved proposal produced rows with decided_at < created_at).
      for (const item of (items || [])) {
        if (['done', 'waived', 'na'].includes(item.status)) continue;
        if (paused) continue;
        const eff = expected[item.key];
        if (eff && ISO.test(String(eff)) && eff !== item.due_date) {
          const nowIso = new Date().toISOString();
          const { error: dErr } = await supa.from('deal_timeline_items')
            .update({ due_date: eff, updated_at: nowIso }).eq('id', item.id);
          if (!dErr) {
            out.corrected_dates += 1;
            await supa.from('deal_activity').insert({
              deal_id: deal.id,
              text: `Timeline: “${item.title}” due date ${item.due_date || '(unset)'} → ${eff} (recomputed from deals.json).`,
              emphasis: 'normal'
            }).then(() => {}, () => {});
            item.due_date = eff;
          }
        }
      }

      // Bug 4b — an active deal whose close date can't be resolved is a data gap,
      // not a silent blank. Surface it to the brief so the date gets recorded.
      const coeItem = (items || []).find((i) => i.key === 'coe');
      if (coeItem && !coeItem.due_date && !paused && !['done', 'na', 'waived'].includes(coeItem.status)) {
        out.needs_info.push(`${deal.source_key}: close-of-escrow date is unknown — add timeline.coe (or closingDate) to deals.json`);
      }

      for (const item of (items || [])) {
        if (['done', 'waived', 'na'].includes(item.status)) continue;

        // Disclosure evidence: a matching document landed in deal_documents.
        const evid = DOC_EVIDENCE[item.key];
        if (evid && (docs || []).some((d) => evid.test(d.name || '') || evid.test(d.doc_type || ''))) {
          await propose(item, { status: 'done' }, `A matching document is on file for “${item.title}”.`);
          continue;
        }

        // No deadline chatter while the contract clock is stopped.
        if (paused) continue;
        if (!item.due_date) continue;

        // Date passed → confirm satisfied.
        if (item.due_date < today) {
          // An executed ETA with no recorded new date voids the old deadline —
          // don't nag; ask for the date via the morning brief instead.
          if (CONT[item.key] && hasExtDoc
              && !(tl.extensions && tl.extensions[CONT[item.key]])
              && !(tl.overrides && tl.overrides[CONT[item.key]])) {
            out.needs_info.push(`${deal.source_key}: ${item.key} deadline ${item.due_date} passed, but an executed extension is on file with no new date recorded — add it to deals.json timeline.extensions`);
            continue;
          }
          const reason = item.kind === 'contingency'
            ? `The ${item.title.toLowerCase()} deadline (${item.due_date}) has passed — confirm the buyer's written removal is in hand.`
            : `The scheduled date (${item.due_date}) has passed — confirm this happened.`;
          await propose(item, { status: 'done' }, reason);
          continue;
        }

        // Due imminently and still 'upcoming' → surface as action-needed.
        if (item.status === 'upcoming' && item.owner === 'seller' && item.due_date <= soon) {
          await propose(item, { status: 'action' },
            `“${item.title}” is due ${item.due_date} — flag it in the seller's “what we need from you” list.`);
        }
      }
    }
    return ok(res, out);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
