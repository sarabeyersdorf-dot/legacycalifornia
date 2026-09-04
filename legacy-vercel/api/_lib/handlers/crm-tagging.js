// api/_lib/handlers/crm-tagging.js
// /api/crm/tagging   (agent-only)
//
//   GET  → a queue of contacts with no contact_type set, plus the counts.
//   POST → apply a type to one contact, to a list of them, or to the whole
//          remaining queue.
//
// WHY THIS EXISTS
// 2,190 of 2,279 contacts (96%) have no contact_type. Every filter that matters
// — "my sellers", "my sphere", the roster's browse buckets — reads that field,
// so almost the whole book is invisible to all of them. 1,989 of the untyped
// arrived in one import on 2026-06-24.
//
// WHAT THAT IMPORT ACTUALLY IS (an earlier read of this was wrong and is worth
// recording): sampling the alphabetically-first rows turned up "Amanda/Placer
// Title", "Angel Transfer", "Amy Agent" and I reported it as a dump of title
// reps and other agents. A random sample says otherwise — Mike Costa, Victoria
// Starkey, Kimberly Martin, Steven Rogers. Only ~32 of the 2,190 match any
// trade-name pattern. It is Sara's real sphere: her phone contacts. 1,690 of
// them have already been sent something.
//
// So the tool is built for that shape. Typing 1,989 people one at a time is a
// month nobody has; the fast path is `scope: 'all'`, which types everything left
// in the queue as sphere in one call — the right default for "someone in my
// phone I market to" — leaving only the contacts worth individual judgement.
// The per-contact queue is then for refining those, not for grinding the bulk.
//
// The queue itself holds only the contacts carrying a signal — replied, on a
// deal, a collection's client, saved a property, or arrived from a real inbound
// source. On this book that is 122 people, and the rest is the bulk action.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

// The types the roster and the follow-up lanes actually read. 'vendor' is new:
// there was nowhere to file a title rep or another agent, so they could only be
// mislabelled as sphere and then get marketed to like a client.
const TYPES = ['sphere', 'buyer', 'seller', 'both', 'past_client', 'vendor', 'do_not_contact'];
const MAX_PAGE = 100;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();
  try {
    if (req.method === 'GET')  return await list(supa, req, res);
    if (req.method === 'POST') return await apply(supa, req, res, profile);
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// The queue is the untyped contacts that CARRY A SIGNAL — someone who has
// written back, sits on a deal, is a collection's client, has saved a property,
// or came in through a real inbound source rather than being typed in.
//
// Ordering by last_contact_at (the obvious first choice) is useless here: a
// newsletter send stamps last_contact_at on everyone it reaches, so the top of
// that queue was several hundred people touched "today" with nothing to tell
// them apart — precisely the population the bulk action exists for. Signal is
// what separates a contact needing a judgement from one that is simply sphere.
//
// On this book that is 122 contacts against ~2,068 for the bulk action: an
// afternoon, not a month.
async function list(supa, req, res) {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 25, 1), MAX_PAGE);
  const safe = (p) => p.then((r) => r, () => ({ data: [] }));

  // Every relation that constitutes a signal. All are small (a few thousand rows
  // at most), so pulling the ids wholesale beats a per-contact existence check.
  const [{ count: remaining }, { data: inbound }, { data: parties }, { data: colls }, { data: savedProps }] = await Promise.all([
    supa.from('leads').select('id', { count: 'exact', head: true })
      .is('contact_type', null).eq('status', 'active'),
    safe(supa.from('deal_messages').select('contact_id').eq('direction', 'inbound').not('contact_id', 'is', null).limit(5000)),
    safe(supa.from('deal_parties').select('lead_id').limit(2000)),
    safe(supa.from('curated_collections').select('client_lead_id').not('client_lead_id', 'is', null).limit(2000)),
    safe(supa.from('saved_properties').select('lead_id').not('lead_id', 'is', null).limit(2000))
  ]);

  const replied      = new Set((inbound    || []).map((r) => r.contact_id).filter(Boolean));
  const onDeal       = new Set((parties    || []).map((r) => r.lead_id).filter(Boolean));
  const inCollection = new Set((colls      || []).map((r) => r.client_lead_id).filter(Boolean));
  const savedOne     = new Set((savedProps || []).map((r) => r.lead_id).filter(Boolean));
  const signalled    = new Set([...replied, ...onDeal, ...inCollection, ...savedOne]);

  // Two passes so the page fills even when few signalled contacts remain:
  // the signalled ones by id, then any untyped contact from a non-manual source
  // (a website form or portal enquiry is itself a signal).
  const byId = new Map();
  const COLS = 'id, first_name, last_name, email, phone, source, created_at, last_contact_at';
  if (signalled.size) {
    const { data } = await safe(supa.from('leads').select(COLS)
      .is('contact_type', null).eq('status', 'active')
      .in('id', [...signalled].slice(0, 500)).limit(limit));
    for (const l of (data || [])) byId.set(l.id, l);
  }
  if (byId.size < limit) {
    const { data } = await safe(supa.from('leads').select(COLS)
      .is('contact_type', null).eq('status', 'active')
      .neq('source', 'manual')
      .order('created_at', { ascending: false })
      .limit(limit - byId.size));
    for (const l of (data || [])) if (!byId.has(l.id)) byId.set(l.id, l);
  }

  const people = [...byId.values()].slice(0, limit).map((l) => ({
    id: l.id,
    name: [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.email || l.phone || '(no name)',
    email: l.email, phone: l.phone, source: l.source,
    last_contact_at: l.last_contact_at,
    // A hint, never an auto-apply. Someone on a deal or in a collection is being
    // worked as a client; someone who has only written back is a real
    // conversation and deliberately gets NO suggestion — that one is a judgement.
    suggestion: (onDeal.has(l.id) || inCollection.has(l.id) || savedOne.has(l.id)) ? 'buyer'
              : replied.has(l.id) ? null
              : 'sphere',
    signals: {
      replied: replied.has(l.id),
      on_deal: onDeal.has(l.id),
      in_collection: inCollection.has(l.id),
      saved_property: savedOne.has(l.id)
    }
  }));

  return ok(res, { remaining: remaining || 0, needs_decision: people.length, people, types: TYPES });
}

async function apply(supa, req, res, profile) {
  const b = await readJson(req);
  const type = b?.contact_type;
  const scope = b?.scope === 'all' ? 'all' : 'ids';

  // 'archive' is not a contact_type — it's for the junk an imported phone book
  // carries ("No name", a bare initial). Filing those as a type would leave them
  // in the roster forever; archiving takes them out of every list without
  // deleting anything.
  if (type !== 'archive' && !TYPES.includes(type)) {
    return fail(res, 400, `contact_type must be one of ${TYPES.join(', ')} (or 'archive')`);
  }
  const patch = type === 'archive' ? { status: 'archived' } : { contact_type: type };

  if (scope === 'all') {
    // Everything still untyped. Deliberately re-derived server-side from the same
    // predicate the queue uses rather than trusting a list of ids the browser
    // built — the page may be minutes stale, and this writes thousands of rows.
    if (type === 'archive') return fail(res, 400, "refusing to archive every untyped contact — that is not a bulk decision");
    // Count BEFORE updating and report that. The statement updates every matching
    // row, but PostgREST caps the returned representation at max-rows (1000), so
    // `.select()` here would report "1,000 filed" on a 1,989-row run and send the
    // agent back to click it again on an already-empty queue.
    const { count: willUpdate } = await supa.from('leads')
      .select('id', { count: 'exact', head: true }).is('contact_type', null).eq('status', 'active');
    const { error } = await supa.from('leads')
      .update(patch).is('contact_type', null).eq('status', 'active');
    if (error) return fail(res, 500, error.message);
    return ok(res, { updated: willUpdate || 0, scope: 'all', contact_type: type });
  }

  const ids = Array.isArray(b?.lead_ids)
    ? [...new Set(b.lead_ids.filter((x) => typeof x === 'string' && x))].slice(0, MAX_PAGE)
    : [];
  if (!ids.length) return fail(res, 400, 'lead_ids required');

  const { data, error } = await supa.from('leads').update(patch).in('id', ids).select('id');
  if (error) return fail(res, 500, error.message);
  return ok(res, { updated: (data || []).length, scope: 'ids', contact_type: type });
}
