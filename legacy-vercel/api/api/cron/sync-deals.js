// api/cron/sync-deals.js
// GET /api/cron/sync-deals?key=<SYNC_SECRET>
//
// Loads the single source of truth (data/deals.json, committed in the repo)
// into Supabase: upserts `deals` and rebuilds `deal_documents` for every
// active (pending / listing) deal. Idempotent — safe to run any number of
// times. Trigger it by visiting the URL, or wire it to a Vercel Cron.
//
// Protect with the SYNC_SECRET env var so only you can trigger it.

import { readFileSync } from 'fs';
import { join } from 'path';
import { adminClient } from '../_lib/supabase.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';

// --- document label + status maps (mirror the compliance checklist) --------
const DOC_LABELS = {
  RPA: ['Purchase Agreement', 'Core contract'],
  VLPA: ['Vacant Land Purchase Agreement', 'Core contract'],
  sellerCounter1: ['Seller Counter Offer', 'Revised terms'],
  buyerCounter1: ['Buyer Counter Offer', 'Final price'],
  AAA: ['Agent Acknowledgment', 'Licensed agents'],
  realtorAcknowledgement: ['Agent Acknowledgment', 'Roles confirmed'],
  TDS: ['Seller Disclosures (TDS)', 'Home condition'],
  SPQ: ['Property Questionnaire (SPQ)', 'Seller answers'],
  NHD: ['Natural Hazard Disclosure', 'Hazard zones'],
  wildfireDisclosure: ['Wildfire Disclosure', 'Fire zone'],
  TOPA: ['Tenant Addendum', 'Tenant terms'],
  SWPI: ['Septic / Well / Monument', 'Well & boundary'],
  SIPA: ['Rent-back Agreement', 'Seller-in-possession'],
  EMD: ['Earnest Money Deposit', 'Good-faith deposit'],
  prelim: ['Preliminary Title Report', 'Title review'],
  HOA: ['HOA Documents', 'Community rules'],
  AVID: ['Agent Visual Inspection', 'Walk-through notes'],
  FVAC_HID: ['Inspection Advisory', 'Right to inspect'],
  disclosures: ['Disclosures', 'Seller disclosures'],
  sellerDisclosures: ['Seller Disclosures', 'Full packet'],
  sellerDisclosurePackage: ['Seller Disclosure Package', 'All disclosures'],
  buyerSignedDisclosures: ['Buyer-signed Disclosures', 'Buyer signatures'],
  homeInspection: ['Home Inspection', 'Buyer inspection'],
  roofInspection: ['Roof Inspection Report', 'Roof condition'],
  wellSepticInspection: ['Well & Septic', 'Reports reviewed'],
  vehicleTrailerAddendum: ['Vehicle / Trailer Addendum', 'Removal terms'],
  emdAddendum2: ['Deposit Addendum', 'EMD timing'],
  addendum: ['Addendum', 'Contract change'],
  addendum1: ['Addendum', 'Contract change'],
  buyerContingencyAddendum: ['Contingency Addendum', 'Buyer conditions'],
  buyerContingencyRemoval1: ['Contingency Removal', 'Conditions met'],
  contingencyRemoval: ['Contingency Removal', 'Conditions met'],
  requestForRepair1: ['Request for Repair', 'Repairs asked'],
  lease: ['Lease', 'Tenant lease']
};
// Never surface these on a client portal (internal / marketing / legal).
const DOC_SKIP = new Set([
  'offeringMemo', 'priceReductionMemo', 'inspectionReport', 'listingAgreement',
  'commissionDemand', 'closingDocs', 'brokerCompAddendum', 'pricingStrategy',
  'certOfTrust', 'leaseDocs', 'flyer', 'mfgHomeAddendum', 'modificationOfTerms',
  'sellerDocs', 'mediationFiled', 'commissionCase', 'escrowDocs', 'evidence',
  'transactionDocs', 'BRBC', 'correspondence'
]);
const STATUS_MAP = [
  ['executed', 'signed'], ['accepted', 'signed'], ['signed', 'signed'],
  ['received', 'on_file'], ['sent', 'sent'], ['drafted', 'pending']
];
function docStatus(val) {
  if (val == null) return null;
  const l = String(val).toLowerCase();
  if (l.includes('with seller') || l.includes('seller still') || l.includes('seller signature') || l.includes('seller needs')) return 'with_seller';
  if (l.includes('to sign') || l.includes('owed') || l.includes('awaiting-buyer') || l.includes('awaiting buyer')) return 'to_sign';
  if (l.includes('pending')) return 'pending';
  for (const [k, s] of STATUS_MAP) if (l.includes(k)) return s;
  return 'on_file';
}

function mapDeal(d) {
  const agent = /james/i.test(d.agent || '') ? 'james' : 'sara';
  const c = d.contacts || {};
  return {
    source_key: d.id,
    address: d.address,
    city: d.city || null,
    type: d.type || null,
    side: (d.side === 'listing') ? 'seller' : (d.side || null),
    stage: d.stage || null,
    agent,
    list_price: d.listPrice ?? null,
    sale_price: d.salePrice ?? null,
    escrow_open_date: d.openEscrowDate || null,
    coe_date: d.closingDate || null,
    escrow_officer: c.escrow || null,
    title_company: c.title || null,
    co_agent: c.coAgent || null,
    loan_contingency_days: d.id === '433-hwy4' ? 25 : 17,
    notes_internal: d.notes || null,
    updated_at: new Date().toISOString()
  };
}

function mapDocs(dealId, d) {
  const out = [];
  const docs = d.docs || {};
  for (const [token, val] of Object.entries(docs)) {
    if (DOC_SKIP.has(token)) continue;
    const status = docStatus(val);
    if (!status) continue;
    const base = token.split('_')[0];
    const label = DOC_LABELS[token] || DOC_LABELS[base];
    if (!label) continue;                       // no human name → skip (never raw keys)
    out.push({
      deal_id: dealId,
      doc_type: base.slice(0, 12),
      name: label[0],
      sub: label[1] || null,
      status,
      client_safe: true,
      updated_at: new Date().toISOString()
    });
  }
  return out;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Simple shared-secret guard so only you can trigger a sync.
  const secret = process.env.SYNC_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');

  try {
    const raw = readFileSync(join(process.cwd(), 'data', 'deals.json'), 'utf8');
    const data = JSON.parse(raw);
    const supa = adminClient();

    const active = (data.deals || []).filter((d) => ['pending', 'listing'].includes(d.stage));
    let dealsUpserted = 0, docsWritten = 0;

    for (const d of active) {
      const { data: up, error } = await supa
        .from('deals')
        .upsert(mapDeal(d), { onConflict: 'source_key' })
        .select('id')
        .single();
      if (error) throw new Error(`deal ${d.id}: ${error.message}`);
      dealsUpserted++;

      // Rebuild this deal's documents (delete then insert = idempotent)
      await supa.from('deal_documents').delete().eq('deal_id', up.id);
      const docRows = mapDocs(up.id, d);
      if (docRows.length) {
        const { error: de } = await supa.from('deal_documents').insert(docRows);
        if (de) throw new Error(`docs ${d.id}: ${de.message}`);
        docsWritten += docRows.length;
      }
    }

    return ok(res, {
      synced: true,
      source_version: data.version || null,
      deals_upserted: dealsUpserted,
      documents_written: docsWritten,
      ran_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
