// api/_lib/handlers/crm-timeline.js
// Agent-side management of the client-facing deal timeline.
//
//   GET  /api/crm/timeline?deal_id=<uuid> | ?source_key=<key>
//        → { deal, items, proposals } (pending proposals only)
//   GET  /api/crm/timeline?proposals=all → every pending proposal (for the brief)
//   POST ops:
//     { op:'seed', deal_id }                      → seed from the CA template (no-op if items exist)
//     { op:'add-item', deal_id, title, ... }      → custom item (e.g. "Tenant extension in writing")
//     { op:'update-item', id, patch:{...} }       → direct agent edit (the agent IS the approver)
//     { op:'propose', deal_id, item_id|item_key, change:{...}, reason, source }
//     { op:'approve', proposal_id } / { op:'reject', proposal_id }
//
// Approval is the only path for AMBIGUOUS automated changes. Per Sara
// (2026-07-12): document-backed matches that are unambiguous (clean executed
// status, extractable date, deterministic mapping, clock running) AUTO-APPLY,
// logged as pre-approved proposals (decided_by 'auto-doc') so the deal console
// keeps a full audit trail. Only conflicts / uncertain items queue for Sara.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { buildTimelineItems } from '../timeline-template.js';
import { createRequire } from 'module';
const requireJson = createRequire(import.meta.url);

const ITEM_FIELDS = ['title', 'plain', 'owner', 'due_date', 'status', 'done_at', 'detail', 'client_visible', 'sort_order', 'kind'];
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));

async function loadDeal(supa, { deal_id, source_key }) {
  let q = supa.from('deals').select('*');
  if (deal_id) q = q.eq('id', deal_id);
  else if (source_key) q = q.eq('source_key', source_key);
  else return null;
  const { data } = await q.maybeSingle();
  return data || null;
}

export async function seedDeal(supa, deal) {
  const { count } = await supa.from('deal_timeline_items')
    .select('id', { count: 'exact', head: true }).eq('deal_id', deal.id);
  if (count > 0) return { seeded: 0, existing: count };
  const rows = buildTimelineItems(deal).map((r) => ({ ...r, deal_id: deal.id }));
  if (!rows.length) return { seeded: 0, existing: 0 };
  const { error } = await supa.from('deal_timeline_items').insert(rows);
  if (error) throw new Error(`seed: ${error.message}`);
  return { seeded: rows.length, existing: 0 };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Read-only key access for the automated morning briefing (same SYNC_SECRET
  // convention as briefing-feedback / briefing-calendar): pending-proposals
  // list ONLY. Approve/reject/edit always require a signed-in agent session.
  const syncSecret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  const hasKey = syncSecret && req.query?.key === syncSecret;
  if (req.method === 'GET' && req.query?.proposals === 'all' && hasKey) {
    try {
      const supaK = adminClient();
      const { data, error } = await supaK.from('deal_timeline_proposals')
        .select('id, deal_id, item_key, address, change, reason, source, created_at')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(50);
      if (error) return fail(res, 500, error.message);
      return ok(res, { proposals: data || [] });
    } catch (e) { return fail(res, 500, e.message); }
  }
  // Key-gated DIGEST — every active deal's timeline in ONE fixed-URL read.
  // The briefing environment can only follow URLs that appear literally in its
  // instructions, so per-deal constructed URLs are unreachable from there.
  if (req.method === 'GET' && req.query?.deal === '__all__' && hasKey) {
    try {
      const supaK = adminClient();
      const { data: deals } = await supaK.from('deals')
        .select('id, source_key, address, city, stage, coe_date, sale_price')
        .in('stage', ['pending', 'listing', 'offer']).order('stage');
      const out = [];
      for (const deal of deals || []) {
        const [{ data: items }, { data: proposals }, { data: docs }] = await Promise.all([
          supaK.from('deal_timeline_items').select('id, key, kind, title, owner, due_date, status, done_at').eq('deal_id', deal.id).order('sort_order'),
          supaK.from('deal_timeline_proposals').select('id, item_key, change, reason, source, created_at').eq('deal_id', deal.id).eq('status', 'pending'),
          supaK.from('deal_documents').select('name, doc_type, status').eq('deal_id', deal.id)
        ]);
        out.push({ deal, items: items || [], pending_proposals: proposals || [], documents: docs || [] });
      }
      return ok(res, { deals: out });
    } catch (e) { return fail(res, 500, e.message); }
  }
  // Key-gated RECONCILE trigger — the server (which has both deals.json and
  // the DB, and no network restrictions) runs the documents↔timeline match
  // itself and FILES PROPOSALS ONLY. Sara's approval gate is unchanged.
  if (req.method === 'GET' && req.query?.op === 'reconcile' && hasKey) {
    try { return ok(res, await reconcileFromDealsFile(adminClient())); }
    catch (e) { return fail(res, 500, e.message); }
  }
  // Key-gated READ of one deal's items (the briefing reconciles executed docs
  // in the Dropbox file against the timeline) …
  if (req.method === 'GET' && req.query?.source_key && hasKey) {
    try {
      const supaK = adminClient();
      const { data: deal } = await supaK.from('deals').select('id, source_key, address, stage, coe_date').eq('source_key', req.query.source_key).maybeSingle();
      if (!deal) return fail(res, 404, 'deal not found');
      const { data: items } = await supaK.from('deal_timeline_items').select('id, key, kind, title, owner, due_date, status, done_at').eq('deal_id', deal.id).order('sort_order');
      return ok(res, { deal, items: items || [] });
    } catch (e) { return fail(res, 500, e.message); }
  }
  // … and key-gated PROPOSE only (source forced to 'cowork'; approval stays a
  // signed-in-agent action, so nothing client-facing changes without Sara).
  if (req.method === 'POST' && hasKey) {
    try {
      const supaK = adminClient();
      const b = await readJson(req);
      if (b?.op !== 'propose') return fail(res, 403, 'key access allows op:propose only');
      if (!b?.deal_id || !b?.change) return fail(res, 400, 'deal_id and change required');
      let item = null;
      if (b.item_id) ({ data: item } = await supaK.from('deal_timeline_items').select('*').eq('id', b.item_id).maybeSingle());
      else if (b.item_key) ({ data: item } = await supaK.from('deal_timeline_items').select('*').eq('deal_id', b.deal_id).eq('key', b.item_key).maybeSingle());
      if (!item) return fail(res, 404, 'timeline item not found');
      const { count } = await supaK.from('deal_timeline_proposals').select('id', { count: 'exact', head: true }).eq('item_id', item.id).eq('status', 'pending');
      if (count > 0) return ok(res, { deduped: true });
      const { data: deal } = await supaK.from('deals').select('address, city').eq('id', b.deal_id).maybeSingle();
      const { data, error } = await supaK.from('deal_timeline_proposals').insert({
        deal_id: b.deal_id, item_id: item.id, item_key: item.key,
        address: deal ? [deal.address, deal.city].filter(Boolean).join(', ') : null,
        change: pick(b.change, ITEM_FIELDS), reason: (b.reason || '').toString().slice(0, 500) || null,
        source: 'cowork'
      }).select('id').single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { proposal: data });
    } catch (e) { return fail(res, 500, e.message); }
  }

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();
  const who = profile.role === 'agent_james' ? 'james' : 'sara';

  try {
    if (req.method === 'GET') {
      if (req.query?.proposals === 'all') {
        const { data, error } = await supa.from('deal_timeline_proposals')
          .select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(50);
        if (error) return fail(res, 500, error.message);
        return ok(res, { proposals: data || [] });
      }
      const deal = await loadDeal(supa, req.query || {});
      if (!deal) return fail(res, 404, 'deal not found');
      const [{ data: items }, { data: proposals }] = await Promise.all([
        supa.from('deal_timeline_items').select('*').eq('deal_id', deal.id)
          .order('sort_order').order('due_date', { ascending: true, nullsFirst: false }),
        supa.from('deal_timeline_proposals').select('*').eq('deal_id', deal.id)
          .eq('status', 'pending').order('created_at')
      ]);

      // Command-center extras (fail-soft, each optional): documents on file,
      // tasks that reference this deal, upcoming calendar items for its parties.
      let documents = [], tasks = [], events = [];
      try {
        const { data: docs } = await supa.from('deal_documents')
          .select('name, doc_type, status, created_at')
          .eq('deal_id', deal.id).order('created_at', { ascending: false }).limit(40);
        documents = docs || [];
      } catch (_) {}
      try {
        const street = (deal.address || '').split(',')[0].trim();
        const ors = [`source_key.ilike.%${deal.source_key}%`];
        if (street) { ors.push(`title.ilike.%${street}%`); ors.push(`note.ilike.%${street}%`); }
        const { data: tk } = await supa.from('agent_tasks')
          .select('id, title, client, sub, due_label, done, agent')
          .or(ors.join(','))
          .order('done').order('created_at', { ascending: false }).limit(12);
        tasks = tk || [];
      } catch (_) {}
      try {
        const { data: parties } = await supa.from('deal_parties').select('lead_id').eq('deal_id', deal.id);
        const leadIds = (parties || []).map((p) => p.lead_id).filter(Boolean);
        const nowIso = new Date().toISOString();
        if (leadIds.length) {
          const [{ data: tours }, { data: appts }] = await Promise.all([
            supa.from('tours').select('scheduled_at, tour_type, status, leads(first_name,last_name)')
              .in('lead_id', leadIds).gte('scheduled_at', nowIso).order('scheduled_at').limit(6),
            supa.from('appointments').select('starts_at, title, kind')
              .in('lead_id', leadIds).gte('starts_at', nowIso).order('starts_at').limit(6)
          ]);
          events = [
            ...(tours || []).map((t) => ({ at: t.scheduled_at, title: `Tour — ${[t.leads?.first_name, t.leads?.last_name].filter(Boolean).join(' ') || 'client'} (${t.tour_type || 'in person'})`, kind: 'tour' })),
            ...(appts || []).map((a) => ({ at: a.starts_at, title: a.title || a.kind, kind: a.kind || 'appointment' }))
          ].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 8);
        }
      } catch (_) {}

      const meta = deal.listing_meta || {};
      return ok(res, { deal: {
        id: deal.id, source_key: deal.source_key, address: deal.address, stage: deal.stage,
        coe_date: deal.coe_date, side: deal.side,
        list_price: deal.list_price, sale_price: deal.sale_price, mls_number: deal.mls_number,
        escrow_officer: deal.escrow_officer, title_company: deal.title_company, co_agent: deal.co_agent,
        commission: meta.commission || null,
        disclosure_url: meta.disclosurePackage || null,
        video_url: deal.video_url || null, tour_url: deal.matterport_url || deal.tour_url || null
      }, items: items || [], proposals: proposals || [], documents, tasks, events });
    }

    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const b = await readJson(req);
    const op = b?.op;

    if (op === 'seed') {
      const deal = await loadDeal(supa, b);
      if (!deal) return fail(res, 404, 'deal not found');
      return ok(res, await seedDeal(supa, deal));
    }

    if (op === 'add-item') {
      if (!b?.deal_id || !b?.title) return fail(res, 400, 'deal_id and title required');
      const row = {
        deal_id: b.deal_id,
        key: 'custom:' + (b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || Date.now()),
        kind: ['milestone','contingency','disclosure','task','document'].includes(b.kind) ? b.kind : 'task',
        ...pick(b, ['title', 'plain', 'owner', 'due_date', 'detail', 'sort_order']),
      };
      const { data, error } = await supa.from('deal_timeline_items').insert(row).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { item: data });
    }

    if (op === 'update-item') {
      if (!b?.id) return fail(res, 400, 'id required');
      const patch = pick(b.patch, ITEM_FIELDS);
      if (!Object.keys(patch).length) return fail(res, 400, 'nothing to update');
      if (patch.status === 'done' && !patch.done_at) patch.done_at = new Date().toISOString();
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supa.from('deal_timeline_items').update(patch).eq('id', b.id).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { item: data });
    }

    if (op === 'propose') {
      if (!b?.deal_id || !b?.change) return fail(res, 400, 'deal_id and change required');
      let item = null;
      if (b.item_id) ({ data: item } = await supa.from('deal_timeline_items').select('*').eq('id', b.item_id).maybeSingle());
      else if (b.item_key) ({ data: item } = await supa.from('deal_timeline_items').select('*').eq('deal_id', b.deal_id).eq('key', b.item_key).maybeSingle());
      if (!item) return fail(res, 404, 'timeline item not found');
      // one pending proposal per item
      const { count } = await supa.from('deal_timeline_proposals')
        .select('id', { count: 'exact', head: true }).eq('item_id', item.id).eq('status', 'pending');
      if (count > 0) return ok(res, { deduped: true });
      const { data: deal } = await supa.from('deals').select('address, city').eq('id', b.deal_id).maybeSingle();
      const { data, error } = await supa.from('deal_timeline_proposals').insert({
        deal_id: b.deal_id, item_id: item.id, item_key: item.key,
        address: deal ? [deal.address, deal.city].filter(Boolean).join(', ') : null,
        change: pick(b.change, ITEM_FIELDS), reason: b.reason || null,
        source: ['cron','cowork','agent','system'].includes(b.source) ? b.source : 'agent'
      }).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { proposal: data });
    }

    if (op === 'approve' || op === 'reject') {
      if (!b?.proposal_id) return fail(res, 400, 'proposal_id required');
      const { data: p } = await supa.from('deal_timeline_proposals').select('*').eq('id', b.proposal_id).maybeSingle();
      if (!p) return fail(res, 404, 'proposal not found');
      if (p.status !== 'pending') return fail(res, 409, `already ${p.status}`);
      if (op === 'approve') {
        const patch = pick(p.change, ITEM_FIELDS);
        if (patch.status === 'done' && !patch.done_at) patch.done_at = new Date().toISOString();
        patch.updated_at = new Date().toISOString();
        const { error: uErr } = await supa.from('deal_timeline_items').update(patch).eq('id', p.item_id);
        if (uErr) return fail(res, 500, uErr.message);
      }
      const { error } = await supa.from('deal_timeline_proposals')
        .update({ status: op === 'approve' ? 'approved' : 'rejected', decided_by: who, decided_at: new Date().toISOString() })
        .eq('id', p.id);
      if (error) return fail(res, 500, error.message);
      return ok(res, { [op === 'approve' ? 'approved' : 'rejected']: true });
    }

    return fail(res, 400, `unknown op: ${op}`);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}


// ---------------------------------------------------------------------------
// Documents ↔ timeline reconciliation (server-side; briefing Step 1c).
// Reads the raw compliance `docs` block in data/deals.json — whose free-text
// statuses carry the execution/delivery dates — and files 'done' proposals
// for timeline items an executed document satisfies. Dedupe: one pending
// proposal per item. Never touches an item directly.
const DOC_RULES = [
  { tok: /^(RPA|VLPA|sellerCounter|buyerCounter)/i, keys: ['acceptance'], sat: /executed|signed|accepted/i },
  { tok: /^TDS/i,                                   keys: ['tds'],        sat: /executed|signed|complete|received/i },
  { tok: /^SPQ/i,                                   keys: ['spq'],        sat: /executed|signed|complete|received/i },
  { tok: /^(NHD|MU_PA_NHD)/i,                       keys: ['nhd'],        sat: /executed|signed|complete|received/i },
  { tok: /^(sellerDisclosures|buyerSignedDisclosures|sellerDisclosurePackage)$/i, keys: ['tds', 'spq'], sat: /signed|complete|received/i },
  { tok: /^(EMD|emdAddendum)/i,                     keys: ['emd'],        sat: /received|confirmed|deposited|cleared/i },
  { tok: /contingencyRemoval/i,                     keys: null,           sat: /executed|signed|received/i } // keys from text
];
const CONT_KEYS = ['cont_inspection', 'cont_appraisal', 'cont_title', 'cont_insurance', 'cont_loan'];

// Ambiguity / negation cues — a doc status containing any of these is never
// auto-applied; it files a proposal for Sara instead.
const AMBIG = /awaiting|pending|out for|not\b|unchecked|missing|unsigned|partial|draft|still (?:to|needs|awaiting|out)|needs to|chase|watch for|to be filed|owed/i;

function contKeysFromText(raw) {
  const t = String(raw).toLowerCase();
  const scan = (x) => {
    const h = [];
    if (/loan|financ/.test(x))  h.push('cont_loan');
    if (/apprais/.test(x))      h.push('cont_appraisal');
    if (/\btitle/.test(x))      h.push('cont_title');
    if (/insur/.test(x))        h.push('cont_insurance');
    if (/inspect|investigat/.test(x)) h.push('cont_inspection');
    return h;
  };
  // "removes ALL contingencies EXCEPT appraisal & loan" → everything BUT those.
  const [before, after = ''] = t.split(/\bexcept\b/);
  const excluded = scan(after);
  if (/all contingen|all remaining|all buyer contingen/.test(before)) {
    return { keys: CONT_KEYS.filter((k) => !excluded.includes(k)), guessed: false };
  }
  const hits = scan(before).filter((k) => !excluded.includes(k));
  if (hits.length) return { keys: hits, guessed: false };
  return { keys: ['cont_inspection'], guessed: true }; // CR-1 default — Sara decides
}

// Last m/d(/yy) date in the status text → ISO. Year defaults to the current
// one; a date that lands in the future rolls back a year.
function dateFromText(raw) {
  const m = [...String(raw).matchAll(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g)].pop();
  if (!m) return null;
  const now = new Date();
  let y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getUTCFullYear();
  const mo = Number(m[1]), da = Number(m[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  let d = new Date(Date.UTC(y, mo - 1, da, 12));
  if (!m[3] && d.getTime() > now.getTime() + 2 * 86400e3) d = new Date(Date.UTC(y - 1, mo - 1, da, 12));
  return d.toISOString();
}

export async function reconcileFromDealsFile(supa) {
  const data = requireJson('../../../data/deals.json');
  const list = Array.isArray(data) ? data : (data.deals || []);
  const summary = { checked: 0, auto_applied: [], filed: [], deduped: 0, skipped: 0 };
  const now = () => new Date().toISOString();

  for (const d of list) {
    if (!/pending/i.test(String(d.stage || ''))) continue;
    // Clock-paused deals (e.g. bankruptcy-court sales): evidence never
    // auto-applies — every change goes to Sara as a proposal.
    const paused = d.timeline && 'clockStart' in d.timeline && !d.timeline.clockStart;
    const { data: deal } = await supa.from('deals').select('id, address, city').eq('source_key', d.id).maybeSingle();
    if (!deal) continue;
    const { data: items } = await supa.from('deal_timeline_items')
      .select('id, key, title, status').eq('deal_id', deal.id);
    if (!items?.length) continue;
    summary.checked++;
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    const addr = [deal.address, deal.city].filter(Boolean).join(', ');

    for (const [token, val] of Object.entries(d.docs || {})) {
      const raw = val && typeof val === 'object' ? (val.status ?? val.state ?? '') : val;
      if (!raw) continue;
      const rule = DOC_RULES.find((r) => r.tok.test(token));
      if (!rule || !rule.sat.test(String(raw))) continue;
      let keys = rule.keys, guessed = false;
      if (!keys) ({ keys, guessed } = contKeysFromText(raw));
      const done_at = dateFromText(raw);
      // AUTO only when the evidence is unambiguous: clean executed status,
      // a real date, deterministic item mapping, and a running clock.
      const confident = !paused && !guessed && !!done_at && !AMBIG.test(String(raw));

      for (const key of keys) {
        const item = byKey[key];
        if (!item || ['done', 'waived', 'na'].includes(item.status)) { summary.skipped++; continue; }
        const reason = ('Executed document on file — ' + token + ': "' + String(raw).slice(0, 160) + '"').slice(0, 460);
        const { data: pend } = await supa.from('deal_timeline_proposals')
          .select('id').eq('item_id', item.id).eq('status', 'pending');
        const change = { status: 'done' };
        if (done_at) change.done_at = done_at;
        const label = addr + ' — ' + (item.title || key) + (done_at ? ' (done ' + done_at.slice(0, 10) + ')' : '');

        if (confident) {
          const { error: uErr } = await supa.from('deal_timeline_items')
            .update({ ...change, updated_at: now() }).eq('id', item.id);
          if (uErr) { summary.skipped++; continue; }
          if (pend?.length) {
            await supa.from('deal_timeline_proposals')
              .update({ status: 'approved', decided_by: 'auto-doc', decided_at: now() })
              .in('id', pend.map((p) => p.id));
          } else {
            await supa.from('deal_timeline_proposals').insert({
              deal_id: deal.id, item_id: item.id, item_key: item.key, address: addr,
              change, reason: reason + ' — auto-applied (document-backed)', source: 'cron',
              status: 'approved', decided_by: 'auto-doc', decided_at: now()
            });
          }
          byKey[key].status = 'done'; // in-run memo: a 2nd doc token can't re-apply
          summary.auto_applied.push(label);
          continue;
        }
        if (pend?.length) { summary.deduped++; continue; }
        const { error } = await supa.from('deal_timeline_proposals').insert({
          deal_id: deal.id, item_id: item.id, item_key: item.key, address: addr,
          change, reason, source: 'cron'
        });
        if (!error) summary.filed.push(label);
      }
    }
  }
  return summary;
}
