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
import { DOC_EVIDENCE } from '../_lib/timeline-template.js';
import { createRequire } from 'module';
const requireJson = createRequire(import.meta.url);

const CONT = { cont_inspection: 'inspection', cont_appraisal: 'appraisal', cont_title: 'title', cont_insurance: 'insurance', cont_loan: 'loan' };
const ISO = /^\d{4}-\d{2}-\d{2}/;
const addDays = (iso, n) => new Date(new Date(iso.slice(0, 10) + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

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

      const effectiveDue = (item) => {
        const c = CONT[item.key];
        if (c) {
          const ext = tl.extensions && tl.extensions[c];
          if (typeof ext === 'string' && ISO.test(ext)) return ext.slice(0, 10);
          const days = Number(tl.overrides && tl.overrides[c]);
          const acc = tl.acceptance || tl.clockStart;
          if (Number.isFinite(days) && days > 0 && typeof acc === 'string' && ISO.test(acc)) return addDays(acc, days);
        }
        if (item.key === 'coe' && typeof tl.coe === 'string' && ISO.test(tl.coe)) return tl.coe.slice(0, 10);
        return item.due_date;
      };

      const [{ data: items }, { data: pend }, { data: docs }] = await Promise.all([
        supa.from('deal_timeline_items').select('*').eq('deal_id', deal.id),
        supa.from('deal_timeline_proposals').select('item_id').eq('deal_id', deal.id).eq('status', 'pending'),
        supa.from('deal_documents').select('name, doc_type, created_at').eq('deal_id', deal.id)
      ]);
      const pending = new Set((pend || []).map((p) => p.item_id));
      const addr = [deal.address, deal.city].filter(Boolean).join(', ');

      const propose = async (item, change, reason) => {
        if (pending.has(item.id)) return;
        const { error: pErr } = await supa.from('deal_timeline_proposals').insert({
          deal_id: deal.id, item_id: item.id, item_key: item.key, address: addr,
          change, reason, source: 'cron'
        });
        if (!pErr) { pending.add(item.id); out.proposed += 1; }
      };

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

        // Extension terms recompute the due date; correct stale item dates in
        // place (audit-trailed) so the client page shows the post-ETA date.
        const eff = effectiveDue(item);
        if (eff && ISO.test(String(eff)) && eff !== item.due_date) {
          const nowIso = new Date().toISOString();
          const { error: dErr } = await supa.from('deal_timeline_items')
            .update({ due_date: eff, updated_at: nowIso }).eq('id', item.id);
          if (!dErr) {
            out.corrected_dates += 1;
            await supa.from('deal_timeline_proposals').insert({
              deal_id: deal.id, item_id: item.id, item_key: item.key, address: addr,
              change: { due_date: eff },
              reason: `Due date recomputed from executed extension terms in deals.json (${item.due_date} → ${eff}) — auto-applied (document-backed).`,
              source: 'cron', status: 'approved', decided_by: 'auto-doc', decided_at: nowIso
            });
            item.due_date = eff;
          }
        }

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
