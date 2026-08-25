// api/_lib/handlers/crm-showcase.js
// GET  /api/crm/showcase → deal picker + current showcase selections
// POST /api/crm/showcase → save selections (which deals appear, hero, order, blurb)
//
// Agents only. Backs the CRM "Showcase" tab. The public gallery is served by
// the unauthenticated /api/showcase; this endpoint is the authoring side.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

// Suggest a case-study bucket from the deal's pipeline stage.
function suggestStatus(stage) {
  return String(stage || '').toLowerCase() === 'closed' ? 'sold' : 'active';
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();

    if (req.method === 'GET') {
      // Candidate deals for the picker.
      const { data: deals, error: dErr } = await supa
        .from('deals')
        .select('id, source_key, address, city, stage, side, type, list_price, sale_price, photo_url, photo_override')
        .order('updated_at', { ascending: false });
      if (dErr) return fail(res, 500, `deals: ${dErr.message}`);

      const { data: rows, error: sErr } = await supa
        .from('showcase_deals')
        .select('*');
      if (sErr) return fail(res, 500, `showcase: ${sErr.message}`);

      const byDeal = new Map((rows || []).map((r) => [r.deal_id, r]));

      const candidates = (deals || []).map((d) => {
        const r = byDeal.get(d.id) || null;
        return {
          deal_id:        d.id,
          source_key:     d.source_key,
          address:        d.address || '',
          city:           d.city || '',
          stage:          d.stage || '',
          side:           d.side || '',
          type:           d.type || '',
          list_price:     d.list_price ?? null,
          sale_price:     d.sale_price ?? null,
          photo:          d.photo_override || d.photo_url || '',
          suggested_status: suggestStatus(d.stage),
          // Current showcase config (null if not included)
          included:       !!r,
          featured:       !!(r && r.featured),
          sort_order:     r ? r.sort_order : 0,
          status:         r ? (r.status || suggestStatus(d.stage)) : suggestStatus(d.stage),
          blurb:          r ? (r.blurb || '') : '',
          photo_override: r ? (r.photo_override || '') : '',
          microsite_path: r ? (r.microsite_path || '') : ''
        };
      });

      return ok(res, { deals: candidates, count: (rows || []).length });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const entries = Array.isArray(b.entries) ? b.entries : [];
      const featuredDealId = b.featured_deal_id || null;

      const included = entries.filter((e) => e && e.included && e.deal_id);
      const includedIds = included.map((e) => e.deal_id);

      // Look up stable source_key + stage server-side (don't trust the client).
      let dealMeta = new Map();
      if (includedIds.length) {
        const { data: dm } = await supa
          .from('deals').select('id, source_key, stage').in('id', includedIds);
        dealMeta = new Map((dm || []).map((d) => [d.id, d]));
      }

      // Upsert the included entries.
      if (included.length) {
        const nowIso = new Date().toISOString();
        const upsertRows = included.map((e) => {
          const meta = dealMeta.get(e.deal_id) || {};
          const status = (e.status === 'sold' || e.status === 'active')
            ? e.status : suggestStatus(meta.stage);
          return {
            deal_id:        e.deal_id,
            source_key:     meta.source_key || null,
            featured:       featuredDealId ? (e.deal_id === featuredDealId) : false,
            sort_order:     Number.isFinite(+e.sort_order) ? +e.sort_order : 0,
            status,
            blurb:          (typeof e.blurb === 'string' && e.blurb.trim()) ? e.blurb.trim() : null,
            photo_override: (typeof e.photo_override === 'string' && e.photo_override.trim()) ? e.photo_override.trim() : null,
            microsite_path: (typeof e.microsite_path === 'string' && e.microsite_path.trim()) ? e.microsite_path.trim() : null,
            updated_at:     nowIso
          };
        });
        const { error: upErr } = await supa
          .from('showcase_deals').upsert(upsertRows, { onConflict: 'deal_id' });
        if (upErr) return fail(res, 500, `save: ${upErr.message}`);
      }

      // Remove any DEAL-LINKED showcase rows no longer included. Manual/external
      // entries (deal_id NULL) are managed separately and never pruned here.
      const { data: existing } = await supa
        .from('showcase_deals').select('deal_id').not('deal_id', 'is', null);
      const toRemove = (existing || [])
        .map((r) => r.deal_id)
        .filter((id) => !includedIds.includes(id));
      if (toRemove.length) {
        const { error: delErr } = await supa
          .from('showcase_deals').delete().in('deal_id', toRemove);
        if (delErr) return fail(res, 500, `prune: ${delErr.message}`);
      }

      // Belt-and-suspenders: exactly one featured row.
      if (featuredDealId && includedIds.includes(featuredDealId)) {
        await supa.from('showcase_deals').update({ featured: false }).neq('deal_id', featuredDealId);
        await supa.from('showcase_deals').update({ featured: true }).eq('deal_id', featuredDealId);
      } else {
        await supa.from('showcase_deals').update({ featured: false }).eq('featured', true);
      }

      return ok(res, { saved: included.length, removed: toRemove.length });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
