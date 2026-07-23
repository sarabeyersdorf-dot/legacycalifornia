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

// Merge a deal's listing-sheet metadata with a top-level `client` name (from
// the executed docs) so buyer-side deals carry a client without a full listing.
function mergeMeta(d) {
  const base = d.listing || d.listingMeta || null;
  const client = d.client || d.clientName || (base && base.client) || null;
  if (!base && !client) return null;
  return { ...(base || {}), ...(client ? { client } : {}) };
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
    // Listing-sheet metadata (client, apn, beds/baths, sqft, lot, year, dates,
    // commission, disclosure package, branded video) for the Listings roster.
    // A top-level "client" (buyer/seller name from the executed docs) folds in
    // so buyer-side deals get a client name without a full listing block.
    listing_meta:   mergeMeta(d),
    // CA RPA timeline (acceptance Day 0, overrides, removals, paused clock) for
    // the briefing calendar's contingency/COE deadline math.
    timeline:       d.timeline || null,
    // ONE SHARED TIMELINE: At-a-Glance milestones + the author-attributed client
    // note, written verbatim from deals.json and read by the Today board, seller
    // portal, and buyer dashboard so all three show the same thing. Milestones
    // carry their own `badge`/`desc`/`col` inside the jsonb.
    milestones:     Array.isArray(d.milestones) ? d.milestones : null,
    agent_note:     d.agentNote || null,
    // v1.5 client-portal content: "What I need from you" + "Good to know".
    client_tasks:   Array.isArray(d.clientTasks) ? d.clientTasks : null,
    good_to_know:   Array.isArray(d.goodToKnow) ? d.goodToKnow : null,
    updated_at: new Date().toISOString()
  };
}

function mapDocs(dealId, d) {
  const out = [];

  // A curated flat list (clientDocuments) is the authoritative set of files the
  // CLIENT should see. When one exists, the compliance `docs` object is treated
  // as INTERNAL only (client_safe:false) so the portal shows just the curated
  // uploads — not the old pre-curation compliance rows stacked alongside them.
  const flat = [d.clientDocuments, d.portalDocs, d.documents, d.portalDocuments]
    .find(Array.isArray) || [];
  const hasFlat = flat.length > 0;

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
      client_safe: !hasFlat,                     // hidden from the portal once a curated list exists
      updated_at: new Date().toISOString()
    });
  }

  // SIMPLE PATH — a flat list of files to drop straight into the client portal.
  // No compliance token, no status required: Cowork lists the deal's Dropbox
  // files + share links and writes them here. Any of these keys works.
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

// A contact linked to a deal that's in escrow or closed is, by definition, a
// client — not a lead. Roll every such lead's classification forward to match
// the deal, so the roster stops showing them under "Leads" and the agent never
// has to swap them by hand. Never touches anyone already a client/past_client/
// sphere/do-not-contact. Returns the number of leads actually updated.
async function promoteAttachedLeads(supa) {
  // 1. Deals under contract (pending) or closed, keyed by id.
  const { data: deals, error: dErr } = await supa.from('deals').select('id, stage').in('stage', ['pending', 'closed']);
  if (dErr || !deals || !deals.length) return 0;
  const stageByDeal = new Map(deals.map((d) => [d.id, d.stage]));

  // 2. Their parties (lead ↔ deal ↔ role).
  const { data: parties, error: pErr } = await supa.from('deal_parties')
    .select('deal_id, lead_id, role').in('deal_id', [...stageByDeal.keys()]);
  if (pErr || !parties || !parties.length) return 0;

  // 3. Fold to one desired classification per lead. Closed beats pending; a
  //    buyer role sets buyer_stage, a seller role sets seller_stage (a lead on
  //    both sides gets both).
  const want = new Map(); // lead_id -> { pipeline, closed, buyer, seller }
  for (const p of parties) {
    if (!p.lead_id) continue;
    const stage = stageByDeal.get(p.deal_id);
    const closed = stage === 'closed';
    const isBuyer = /buyer/.test(p.role || '');
    const isSeller = /seller/.test(p.role || '') || !isBuyer; // default to seller side
    const cur = want.get(p.lead_id) || { closed: false, buyer: false, seller: false };
    cur.closed = cur.closed || closed;
    cur.buyer = cur.buyer || isBuyer;
    cur.seller = cur.seller || isSeller;
    want.set(p.lead_id, cur);
  }
  const leadIds = [...want.keys()];
  if (!leadIds.length) return 0;

  // 4. Current lead state — skip anyone already tracked, and only write a diff.
  const { data: leads, error: lErr } = await supa.from('leads')
    .select('id, contact_type, pipeline_stage, buyer_stage, seller_stage').in('id', leadIds);
  if (lErr || !leads) return 0;

  const TRACKED = new Set(['client', 'past_client', 'sphere', 'do_not_call', 'do_not_contact']);
  let promoted = 0;
  for (const l of leads) {
    if (TRACKED.has(l.contact_type)) continue;         // never touch an existing client/etc.
    const w = want.get(l.id);
    const sideStage = w.closed ? 'closed' : 'in_escrow';
    const pipeline  = w.closed ? 'closed' : 'under_contract';
    const patch = {};
    if (l.contact_type !== 'client') patch.contact_type = 'client';
    if (l.pipeline_stage !== pipeline) patch.pipeline_stage = pipeline;
    if (w.buyer  && l.buyer_stage  !== sideStage) patch.buyer_stage  = sideStage;
    if (w.seller && l.seller_stage !== sideStage) patch.seller_stage = sideStage;
    if (!Object.keys(patch).length) continue;
    const { error } = await supa.from('leads').update(patch).eq('id', l.id);
    if (!error) promoted++;
  }
  return promoted;
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

    const active = (data.deals || []).filter((d) => ['offer', 'pending', 'listing', 'closed', 'preparing'].includes(d.stage));
    let dealsUpserted = 0, docsWritten = 0;
    const errors = [];

    for (const d of active) {
      try {
        const mapped = mapDeal(d);
        // Manual upsert (select → update|insert) so we DON'T depend on a unique
        // constraint on source_key existing in the (ad-hoc) deals table. A
        // missing constraint would make .upsert(onConflict) throw and abort the
        // whole sync, zeroing every listing.
        let ex = null;
        {
          const sel = await supa.from('deals').select('id, agent_note').eq('source_key', mapped.source_key).maybeSingle();
          if (sel.error && /agent_note/i.test(sel.error.message || '')) {
            const sel2 = await supa.from('deals').select('id').eq('source_key', mapped.source_key).maybeSingle();
            if (sel2.error) throw new Error(`lookup: ${sel2.error.message}`);
            ex = sel2.data;
          } else if (sel.error) {
            throw new Error(`lookup: ${sel.error.message}`);
          } else {
            ex = sel.data;
          }
        }

        // Preserve a note the agent PUBLISHED in the CRM. deals.json always ships
        // the note as a draft, so without this a routine re-sync would silently
        // un-publish a live client note. Keep 'published' as long as the body is
        // unchanged; if Cowork edited the note text, it reverts to draft and needs
        // re-publishing (so the client never sees an edit the agent didn't OK).
        const exNote = ex && ex.agent_note && typeof ex.agent_note === 'object' && !Array.isArray(ex.agent_note) ? ex.agent_note : null;
        if (exNote && exNote.status === 'published' && mapped.agent_note &&
            String(exNote.body || '').trim() === String(mapped.agent_note.body || '').trim()) {
          mapped.agent_note = {
            ...mapped.agent_note,
            status: 'published',
            published_at: exNote.published_at || null,
            published_by: exNote.published_by || null
          };
        }

        // If a newly-added column (e.g. listing_meta before migration 019 runs)
        // isn't in the table yet, retry once without it rather than dropping the
        // whole deal — a missing optional column must never blank the roster.
        const writeDeal = async (payload) => {
          if (ex) {
            const { error } = await supa.from('deals').update(payload).eq('id', ex.id);
            return { error, id: ex.id };
          }
          const { data: ins, error } = await supa.from('deals').insert(payload).select('id').single();
          return { error, id: ins?.id };
        };
        let { error: wErr, id: dealId } = await writeDeal(mapped);
        // If a not-yet-migrated optional column (listing_meta / timeline) is
        // referenced before its migration runs, retry without them rather than
        // dropping the whole deal — a missing column must never blank the list.
        // They're restored automatically on the next sync once migrated.
        if (wErr && /(listing_meta|timeline|milestones|agent_note|client_tasks|good_to_know)/i.test(wErr.message || '')) {
          const { listing_meta, timeline, milestones, agent_note, client_tasks, good_to_know, ...safe } = mapped;
          ({ error: wErr, id: dealId } = await writeDeal(safe));
        }
        if (wErr) throw new Error(`${ex ? 'update' : 'insert'}: ${wErr.message}`);
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

    // Reconcile: the deals table must MIRROR the active feed. A deal that
    // dropped out of deals.json — removed outright, or moved to a retired stage
    // like 'inactive'/'dispute' — was previously left frozen at its last stage,
    // so e.g. an offer Cowork retired lingered as a phantom in the Offers tab.
    // Prune any table row whose source_key is no longer an active deal. All
    // child rows (documents, parties, timeline, milestones) cascade on delete.
    // Guarded: never prune when the active set is empty, so a bad/empty deploy
    // of deals.json can't wipe the table.
    let dealsPruned = 0;
    try {
      const activeKeys = new Set(active.map((d) => d.id).filter(Boolean));
      if (activeKeys.size > 0) {
        const { data: existing, error: exErr } = await supa.from('deals').select('source_key');
        if (exErr) throw new Error(exErr.message);
        const orphans = [...new Set((existing || [])
          .map((r) => r.source_key)
          .filter((k) => k && !activeKeys.has(k)))];
        if (orphans.length) {
          const { error: pErr } = await supa.from('deals').delete().in('source_key', orphans);
          if (pErr) throw new Error(pErr.message);
          dealsPruned = orphans.length;
        }
      }
    } catch (e) {
      errors.push({ deal: 'prune-orphans', error: e.message || String(e) });
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

    // Promote any lead attached to an in-escrow / closed deal to a CLIENT with
    // the matching side stage, so a contact who's under contract never lingers
    // in the roster as a "lead". Self-healing: runs every sync, only touches
    // rows that need it, and never downgrades an existing client/past/sphere/DNC.
    let leadsPromoted = 0;
    try { leadsPromoted = await promoteAttachedLeads(supa); }
    catch (e) { errors.push({ deal: 'lead-promotion', error: e.message || String(e) }); }

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
      deals_pruned: dealsPruned,
      documents_written: docsWritten,
      tasks_written: tasksWritten,
      leads_promoted: leadsPromoted,
      deal_errors: errors,
      deals_in_table: dealsInTable,
      ran_at: new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
