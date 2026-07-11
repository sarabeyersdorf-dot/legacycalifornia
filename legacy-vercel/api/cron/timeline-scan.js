// api/cron/timeline-scan.js
// GET /api/cron/timeline-scan   (Vercel cron — daily, before the morning brief)
//
// For every deal in escrow ('pending'):
//   1. Seed the CA-template timeline if the deal has none yet.
//   2. File PROPOSALS (never direct changes) where evidence says an item is
//      satisfied:
//        - date-certain milestones whose date has passed (escrow open, COE,
//          walk-through) → "date passed — confirm"
//        - contingency deadlines that have passed → "deadline passed — confirm
//          the buyer's written removal"
//        - disclosures with a matching document in deal_documents → "document
//          on file"
//   3. Flag items due within 2 days that still sit 'upcoming' → status:'action'
//      proposal so the seller's page shows it in "what we need from you".
//
// Every proposal waits in deal_timeline_proposals for the agent's approval in
// the morning brief. Dedupe = one pending proposal per item (enforced here and
// in the API).

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';
import { seedDeal } from '../_lib/handlers/crm-timeline.js';
import { DOC_EVIDENCE } from '../_lib/timeline-template.js';

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
  const out = { seeded: [], proposed: 0, deals: 0 };

  try {
    const { data: deals, error } = await supa.from('deals').select('*').eq('stage', 'pending').limit(40);
    if (error) return fail(res, 500, error.message);

    for (const deal of (deals || [])) {
      out.deals += 1;
      try {
        const s = await seedDeal(supa, deal);
        if (s.seeded) out.seeded.push({ deal: deal.source_key, items: s.seeded });
      } catch (_) { continue; }

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

        if (!item.due_date) continue;

        // Date passed → confirm satisfied.
        if (item.due_date < today) {
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
