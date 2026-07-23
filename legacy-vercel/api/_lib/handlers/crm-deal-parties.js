// api/_lib/handlers/crm-deal-parties.js
// GET  /api/crm/deal-parties?deal=<source_key>   → merged people/escrow for a deal
// POST /api/crm/deal-parties { deal, party_details?, link? }
//        party_details → save the agent's structured overlay (db/029)
//        link:{ lead_id, role } → tie a CRM contact to the deal (deal_parties)
//                                 and snapshot their name/phone/email into the
//                                 matching overlay section (buyer/seller).
// Agent-only. The overlay is sync-safe: the deals.json sync never writes
// party_details, so edits persist across re-syncs, and Cowork can fold them back
// into deals.json from the sync response.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { resolveParties, sanitizeOverlay } from '../deal-parties.js';

const DEAL_COLS = 'id, source_key, address, city, stage, side, agent, coe_date, escrow_officer, title_company, co_agent, listing_meta, party_details';
const VALID_ROLES = ['seller', 'co-seller', 'buyer', 'co-buyer'];
const roleToSection = (role) => ({ buyer: 'buyer', 'co-buyer': 'buyer2', seller: 'seller', 'co-seller': 'seller2' }[role] || 'buyer');

async function loadDeal(supa, sourceKey, dealId) {
  let q = supa.from('deals').select(DEAL_COLS);
  q = dealId ? q.eq('id', dealId) : q.eq('source_key', sourceKey);
  const { data, error } = await q.maybeSingle();
  return { deal: data || null, error };
}

// The deal's linked CRM contacts (live name/phone/email) via deal_parties.
async function linkedParties(supa, dealId) {
  const { data } = await supa.from('deal_parties')
    .select('role, lead_id, leads(id, first_name, last_name, phone, email)')
    .eq('deal_id', dealId);
  return (data || []).filter((r) => r.leads).map((r) => ({
    lead_id: r.lead_id, role: r.role,
    name: [r.leads.first_name, r.leads.last_name].filter(Boolean).join(' ') || r.leads.email || 'Contact',
    phone: r.leads.phone || null, email: r.leads.email || null
  }));
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();

  try {
    if (req.method === 'GET') {
      const sourceKey = typeof req.query?.deal === 'string' ? req.query.deal.trim() : '';
      const dealId    = typeof req.query?.deal_id === 'string' ? req.query.deal_id.trim() : '';
      if (!sourceKey && !dealId) return fail(res, 400, 'deal (source_key) or deal_id required');
      const { deal, error } = await loadDeal(supa, sourceKey, dealId);
      if (error && /party_details|column/i.test(error.message || '')) return fail(res, 409, 'party_details column missing — run db/029_deal_party_details.sql');
      if (error) return fail(res, 500, error.message);
      if (!deal) return fail(res, 404, `no deal ${sourceKey || dealId}`);
      return ok(res, {
        deal:    { source_key: deal.source_key, address: deal.address, city: deal.city, stage: deal.stage, side: deal.side, agent: deal.agent },
        parties: resolveParties(deal),
        overlay: deal.party_details || {},
        linked:  await linkedParties(supa, deal.id),
        base:    { escrow_officer: deal.escrow_officer || null, title_company: deal.title_company || null, co_agent: deal.co_agent || null, client: deal.listing_meta?.client || null }
      });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const sourceKey = typeof b?.deal === 'string' ? b.deal.trim() : '';
      const dealId    = typeof b?.deal_id === 'string' ? b.deal_id.trim() : '';
      if (!sourceKey && !dealId) return fail(res, 400, 'deal (source_key) or deal_id required');
      const { deal, error } = await loadDeal(supa, sourceKey, dealId);
      if (error && /party_details|column/i.test(error.message || '')) return fail(res, 409, 'party_details column missing — run db/029_deal_party_details.sql');
      if (error) return fail(res, 500, error.message);
      if (!deal) return fail(res, 404, `no deal ${sourceKey || dealId}`);

      // Start from the current overlay so partial saves don't wipe other fields.
      let overlay = (deal.party_details && typeof deal.party_details === 'object') ? { ...deal.party_details } : {};

      // Link a CRM contact to the deal: upsert deal_parties + snapshot into overlay.
      if (b?.link && b.link.lead_id) {
        const role = VALID_ROLES.includes(b.link.role) ? b.link.role : 'buyer';
        const { error: pErr } = await supa.from('deal_parties')
          .upsert({ deal_id: deal.id, lead_id: b.link.lead_id, role }, { onConflict: 'deal_id,lead_id' });
        if (pErr) return fail(res, 500, `link: ${pErr.message}`);
        const { data: lead } = await supa.from('leads').select('first_name,last_name,phone,email').eq('id', b.link.lead_id).maybeSingle();
        if (lead) {
          const section = roleToSection(role);
          overlay[section] = {
            ...(overlay[section] || {}),
            name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || (overlay[section]?.name || ''),
            phone: lead.phone || overlay[section]?.phone || '',
            email: lead.email || overlay[section]?.email || '',
            lead_id: b.link.lead_id
          };
        }
      }

      // Merge the edited fields (sanitized) over the current overlay.
      if (b?.party_details && typeof b.party_details === 'object') {
        const clean = sanitizeOverlay(b.party_details);
        overlay = { ...overlay, ...clean };
        // An explicitly emptied section clears it (sanitize drops empties, so a
        // section the client sent as all-blank simply won't appear in `clean`;
        // honor an explicit null to remove).
        for (const k of Object.keys(b.party_details)) {
          if (b.party_details[k] === null) delete overlay[k];
        }
      }

      // Any buyer/seller section carrying a lead_id means the agent linked a CRM
      // contact — mirror it into deal_parties so the portal identity chain
      // (users → leads → deal_parties → deals) resolves. Idempotent; fail-soft.
      const SECTION_ROLE = { buyer: 'buyer', buyer2: 'co-buyer', seller: 'seller', seller2: 'co-seller' };
      for (const [section, role] of Object.entries(SECTION_ROLE)) {
        const lid = overlay[section]?.lead_id;
        if (lid) await supa.from('deal_parties').upsert({ deal_id: deal.id, lead_id: lid, role }, { onConflict: 'deal_id,lead_id' }).then(() => {}, () => {});
      }

      const { error: uErr } = await supa.from('deals').update({ party_details: overlay }).eq('id', deal.id);
      if (uErr) {
        if (/party_details|column|schema cache/i.test(uErr.message || '')) return fail(res, 409, 'party_details column missing — run db/029_deal_party_details.sql');
        return fail(res, 500, uErr.message);
      }

      const { deal: fresh } = await loadDeal(supa, null, deal.id);
      return ok(res, { saved: true, parties: resolveParties(fresh || deal), overlay, linked: await linkedParties(supa, deal.id) });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
