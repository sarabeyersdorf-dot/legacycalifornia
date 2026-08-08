// api/_lib/handlers/crm-document-visibility.js
// The Command Center's per-document visibility control (SPEC_portal_document_model.md).
//
//   GET  /api/crm/document-visibility?deal=<source_key> | ?deal_id=<uuid>
//        → this deal's documents with their scope + current effective visibility,
//          so the CRM can render a toggle per document.
//
//   POST /api/crm/document-visibility
//        { deal|deal_id, doc_key, visibility }   visibility ∈ agent_only|seller|buyer|both
//        → writes the grant to deal_document_governance (set_by='agent'). This is
//          the AUTHORITATIVE writer: the hourly sync never touches this table, so a
//          grant survives every rebuild. Fail CLOSED everywhere — a document with
//          no grant is agent_only.
//
// Agent-only. The write path is what promotes a document out of agent_only, so it
// carries a wire-fraud guard: a document whose name reads like wire/payment
// instructions can never be shared, mirroring /api/crm/visibility.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const VIS = new Set(['agent_only', 'seller', 'buyer', 'both']);
const normName = (s) => String(s || '').trim().toLowerCase();
// Anything that looks like money-movement instructions must never be shareable.
const WIRE_RE = /\b(wire|wiring|routing|account\s*#|acct|swift|iban|ach|payment\s*instruction|bank(ing)?\s*(detail|info|instruction))/i;

async function resolveDeal(supa, req, body) {
  const sourceKey = String((body && body.deal) || req.query?.deal || '').trim();
  const dealId    = String((body && body.deal_id) || req.query?.deal_id || '').trim();
  if (!sourceKey && !dealId) return { error: 'deal (source_key) or deal_id is required' };
  let dq = supa.from('deals').select('id, source_key, address, side');
  dq = dealId ? dq.eq('id', dealId) : dq.eq('source_key', sourceKey);
  const { data: deal, error } = await dq.maybeSingle();
  if (error) return { error: `deal lookup: ${error.message}` };
  if (!deal)  return { error: `deal not found (${dealId || sourceKey})`, notFound: true };
  return { deal };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    // ---- GET: list documents + effective visibility -----------------------
    if (req.method === 'GET') {
      const r = await resolveDeal(supa, req, null);
      if (r.error) return fail(res, r.notFound ? 404 : 400, r.error);
      const deal = r.deal;

      const { data: docs, error: dErr } = await supa.from('deal_documents')
        .select('name, sub, doc_type, doc_key, scope, status, doc_url')
        .eq('deal_id', deal.id);
      if (dErr) return fail(res, 500, `documents: ${dErr.message}`);

      const { data: gov } = await supa.from('deal_document_governance')
        .select('doc_key, visibility, doc_fingerprint, set_by, set_at').eq('deal_id', deal.id);
      const govByKey = new Map((gov || []).map((g) => [g.doc_key, g]));

      const items = (docs || []).map((doc) => {
        const g = doc.doc_key ? govByKey.get(doc.doc_key) : null;
        // A grant only counts if its fingerprint still matches (key-reuse guard).
        const applies = g && normName(g.doc_fingerprint) === normName(doc.name);
        return {
          doc_key: doc.doc_key || null,
          name: doc.name,
          sub: doc.sub || null,
          doc_type: doc.doc_type || null,
          scope: doc.scope || 'transaction',
          status: doc.status || null,
          has_url: !!doc.doc_url,
          visibility: applies ? g.visibility : 'agent_only',
          set_by: applies ? g.set_by : null,
          set_at: applies ? g.set_at : null,
          governable: !!doc.doc_key,          // a doc with no stable key can't be shared
          wire_locked: WIRE_RE.test(doc.name || '')
        };
      });

      return ok(res, {
        deal: { id: deal.id, source_key: deal.source_key, address: deal.address, side: deal.side },
        items
      });
    }

    // ---- POST: set a document's visibility --------------------------------
    if (req.method === 'POST') {
      const body = await readJson(req);
      const r = await resolveDeal(supa, req, body);
      if (r.error) return fail(res, r.notFound ? 404 : 400, r.error);
      const deal = r.deal;

      const doc_key = String(body?.doc_key || '').trim();
      const visibility = String(body?.visibility || '').trim().toLowerCase();
      if (!doc_key)          return fail(res, 400, 'doc_key is required');
      if (!VIS.has(visibility)) return fail(res, 400, `visibility must be one of ${[...VIS].join(', ')}`);

      // The document must exist on this deal (so we can fingerprint it and refuse
      // to govern a key that points at nothing). Pick the row matching the key.
      const { data: rows, error: docErr } = await supa.from('deal_documents')
        .select('name').eq('deal_id', deal.id).eq('doc_key', doc_key).limit(1);
      if (docErr) return fail(res, 500, `document lookup: ${docErr.message}`);
      const docName = rows && rows[0] && rows[0].name;
      if (!docName) return fail(res, 404, `no document with doc_key '${doc_key}' on this deal`);

      // Wire-fraud guard: money-movement docs can never leave agent_only.
      if (visibility !== 'agent_only' && WIRE_RE.test(docName)) {
        return fail(res, 422, 'this document reads like wire/payment instructions and cannot be shared');
      }

      const row = {
        deal_id: deal.id,
        doc_key,
        visibility,
        doc_fingerprint: normName(docName),
        set_by: 'agent',
        set_at: new Date().toISOString()
      };
      // Upsert on (deal_id, doc_key) — the unique index from db/053.
      const { error: upErr } = await supa.from('deal_document_governance')
        .upsert(row, { onConflict: 'deal_id,doc_key' });
      if (upErr) return fail(res, 500, `save: ${upErr.message}`);

      return ok(res, { saved: true, deal_id: deal.id, doc_key, visibility });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
