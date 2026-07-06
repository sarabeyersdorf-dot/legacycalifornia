// api/cron/sync-deals.js
// GET /api/cron/sync-deals?key=<SYNC_SECRET>
//
// Loads the single source of truth (data/deals.json, committed in the repo)
// into Supabase: upserts `deals` and rebuilds `deal_documents` for every
// active (pending / listing) deal. Idempotent — safe to run any number of
// times. Trigger it by visiting the URL, or wire it to a Vercel Cron.
//
// Protect with the SYNC_SECRET env var so only you can trigger it.

import { createRequire } from 'module';
import { adminClient } from '../_lib/supabase.js';

// Load deals.json as a module dependency (not a runtime fs read) so Vercel's
// bundler traces it and ships it inside the serverless function. A bare
// readFileSync(process.cwd()+...) is NOT traced and 500s with ENOENT on Vercel.
const require = createRequire(import.meta.url);
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
    mls_number: d.mls || d.mlsNumber || d.mls_number || null,
    loan_contingency_days: d.id === '433-hwy4' ? 25 : 17,
    notes_internal: d.notes || null,
    // Media, driven from deals.json → seller portal hero photo + tour links.
    photo_url:      d.photo      || d.photoUrl      || null,
    video_url:      d.video      || d.youtube       || d.videoUrl      || null,
    matterport_url: d.matterport || d.matterportUrl || null,
    updated_at: new Date().toISOString()
  };
}

function mapDocs(dealId, d) {
  const out = [];
  const docs = d.docs || {};
  for (const [token, val] of Object.entries(docs)) {
    if (DOC_SKIP.has(token)) continue;
    // A doc value may be a bare status string ("received") OR an object that
    // also carries the link to the executed file: { status, url }.
    const isObj    = val && typeof val === 'object';
    const rawState = isObj ? (val.status ?? val.state ?? val.value) : val;
    const url      = isObj ? (val.url || val.link || val.href || val.file || null) : null;
    const status = docStatus(rawState);
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
      doc_url: url ? String(url) : null,         // link to the executed document, if provided
      client_safe: true,
      updated_at: new Date().toISOString()
    });
  }

  // SIMPLE PATH — a flat list of files to drop straight into the client portal.
  // No compliance token, no status required: Cowork lists the deal's Dropbox
  // files + share links and writes them here. Any of these keys works.
  const flat = [d.clientDocuments, d.portalDocs, d.documents, d.portalDocuments]
    .find(Array.isArray) || [];
  for (const doc of flat) {
    if (!doc) continue;
    const name = String(doc.name || doc.title || doc.label || '').trim();
    const url  = doc.url || doc.link || doc.href || doc.file || null;
    if (!name && !url) continue;
    out.push({
      deal_id: dealId,
      doc_type: extType(name || url),
      name: name || 'Document',
      sub: doc.sub || doc.note || null,
      status: doc.status ? docStatus(doc.status) : null,   // status is OPTIONAL here
      doc_url: url ? String(url) : null,
      client_safe: doc.client_safe === false ? false : true, // shareable by default
      updated_at: new Date().toISOString()
    });
  }
  return out;
}

// A short type tag from a filename / URL extension (PDF / DOC / IMG / …).
function extType(s) {
  const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(String(s || ''));
  const e = (m ? m[1] : '').toLowerCase();
  if (e === 'pdf') return 'PDF';
  if (e === 'doc' || e === 'docx') return 'DOC';
  if (['jpg','jpeg','png','heic','gif','webp'].includes(e)) return 'IMG';
  if (['xls','xlsx','csv'].includes(e)) return 'XLS';
  return e ? e.toUpperCase().slice(0, 4) : 'DOC';
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Auth: allow two callers.
  //  1. Manual trigger — the bookmark URL with ?key=<SYNC_SECRET>.
  //  2. Vercel Cron — scheduled runs carry an "x-vercel-cron" header, and
  //     (if set) an "Authorization: Bearer <CRON_SECRET>". Either is accepted.
  const secret     = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const bearer     = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okManual   = !secret || req.query?.key === secret;
  const okCron     = !!req.headers['x-vercel-cron'] || (cronSecret && bearer === cronSecret);
  if (!okManual && !okCron) return fail(res, 401, 'bad key');

  try {
    const data = require('../../data/deals.json');
    const supa = adminClient();

    const active = (data.deals || []).filter((d) => ['pending', 'listing', 'closed', 'preparing'].includes(d.stage));
    let dealsUpserted = 0, docsWritten = 0;
    const errors = [];

    for (const d of active) {
      try {
        const mapped = mapDeal(d);
        // Manual upsert (select → update|insert) so we DON'T depend on a unique
        // constraint on source_key existing in the (ad-hoc) deals table. A
        // missing constraint would make .upsert(onConflict) throw and abort the
        // whole sync, zeroing every listing.
        const { data: ex, error: selErr } = await supa
          .from('deals').select('id').eq('source_key', mapped.source_key).maybeSingle();
        if (selErr) throw new Error(`lookup: ${selErr.message}`);

        let dealId;
        if (ex) {
          const { error: upErr } = await supa.from('deals').update(mapped).eq('id', ex.id);
          if (upErr) throw new Error(`update: ${upErr.message}`);
          dealId = ex.id;
        } else {
          const { data: ins, error: insErr } = await supa.from('deals').insert(mapped).select('id').single();
          if (insErr) throw new Error(`insert: ${insErr.message}`);
          dealId = ins.id;
        }
        dealsUpserted++;

        // Rebuild this deal's documents (delete then insert = idempotent)
        await supa.from('deal_documents').delete().eq('deal_id', dealId);
        const docRows = mapDocs(dealId, d);
        if (docRows.length) {
          const { error: de } = await supa.from('deal_documents').insert(docRows);
          if (de) throw new Error(`docs: ${de.message}`);
          docsWritten += docRows.length;
        }
      } catch (e) {
        // Keep going — one malformed deal must never zero out every listing.
        errors.push({ deal: d.id, address: d.address || null, error: e.message || String(e) });
      }
    }

    // Per-agent tasks from the briefing (deals.json "tasks") → agent_tasks.
    // The briefing is the source of truth for content, but check-offs made in
    // the CRM are preserved across syncs (matched by agent|client|title).
    let tasksWritten = 0;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const normAgent = (a) => { a = String(a || '').toLowerCase(); return /james/.test(a) ? 'james' : (/both/.test(a) ? 'both' : 'sara'); };
    const sig = (agent, client, title) => `${agent}|${client || ''}|${title}`;

    // Preserve, across the re-sync, the done checkmark AND the agents'
    // note-back-to-briefing + attention flag (matched by agent|client|title),
    // so a re-sync never wipes an agent's feedback.
    let hasFbCols = true, prior = [];
    {
      const r = await supa.from('agent_tasks')
        .select('agent, client, title, done, agent_note, attention, agent_note_by, agent_note_at')
        .eq('source', 'briefing');
      if (r.error) {
        hasFbCols = false;
        const r2 = await supa.from('agent_tasks').select('agent, client, title, done').eq('source', 'briefing');
        prior = r2.data || [];
      } else prior = r.data || [];
    }
    const keepBy = new Map(prior.map((t) => [sig(t.agent, t.client, t.title), t]));

    await supa.from('agent_tasks').delete().eq('source', 'briefing');
    if (tasks.length) {
      const rows = tasks.map((t) => {
        const agent  = normAgent(t.agent);
        const title  = String(t.title || t.task || '').slice(0, 300);
        const client = t.client ? String(t.client).slice(0, 80) : null;
        const s = sig(agent, client, title);
        const kept = keepBy.get(s);
        const row = {
          agent,
          client,
          title,
          sub:        t.sub ? String(t.sub).slice(0, 300) : null,
          note:       t.note ? String(t.note).slice(0, 600) : null,
          due_label:  t.due || t.due_label || null,
          source_key: t.deal || t.source_key || null,
          source:     'briefing',
          done:       kept ? !!kept.done : (t.done === true)
        };
        if (hasFbCols && kept) {
          row.agent_note    = kept.agent_note ?? null;
          row.attention     = !!kept.attention;
          row.agent_note_by = kept.agent_note_by ?? null;
          row.agent_note_at = kept.agent_note_at ?? null;
        }
        return row;
      }).filter((r) => r.title);
      if (rows.length) {
        const { error: te } = await supa.from('agent_tasks').insert(rows);
        if (te) throw new Error(`tasks: ${te.message}`);
        tasksWritten = rows.length;
      }
    }

    // Post-sync breakdown of the deals table (side/stage) so a single trigger
    // is self-diagnosing: you can see exactly what the CRM Listings view reads.
    let dealsInTable = null;
    try {
      const { data: after } = await supa.from('deals').select('side, stage');
      const bd = {};
      for (const r of (after || [])) { const k = `${r.side || '?'}/${r.stage || '?'}`; bd[k] = (bd[k] || 0) + 1; }
      dealsInTable = { total: (after || []).length, by_side_stage: bd };
    } catch (_) { /* diagnostic only */ }

    return ok(res, {
      synced: true,
      source_version: data.version || null,
      deals_upserted: dealsUpserted,
      documents_written: docsWritten,
      tasks_written: tasksWritten,
      deal_errors: errors,
      deals_in_table: dealsInTable,
      ran_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
