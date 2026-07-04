// api/_lib/handlers/curate-collections.js
// /api/curate/collections   (agent-only)
//
//   GET                     → list this agent's collections (+ counts)
//   GET ?id=<uuid>          → one collection: meta + listings (checklist view)
//                             + reaction/event rollups
//   POST (create)           → { title, client_lead_id?, intro_note?, closing_note? }
//   POST { op:'set-listing', collection_id, property_id, included?, agent_note?,
//          note_style?, why_note?, priority?, sort_order? }   → upsert one listing
//   POST { op:'add-listings', collection_id, property_ids:[] }→ bulk include
//   PATCH { id, title?, intro_note?, closing_note?, status?, expires_at? }
//   DELETE ?id=<uuid>       → delete a collection (cascades listings/reactions)
//
// The included=false default means nothing reaches a client the agent didn't
// affirmatively pick.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { shapeListing } from './curate-search.js';

const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');
const NOTE_STYLES = ['sticky', 'highlight', 'banner'];
const COLL_STATUS = ['draft', 'active', 'revoked'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa  = adminClient();
  const agent = agentKey(profile);

  try {
    if (req.method === 'GET' && req.query?.id) return getOne(supa, agent, req.query.id, res);
    if (req.method === 'GET')                  return listAll(supa, agent, res);
    if (req.method === 'POST')                 return postAction(supa, agent, req, res);
    if (req.method === 'PATCH')                return patchCollection(supa, agent, req, res);
    if (req.method === 'DELETE')               return deleteCollection(supa, agent, req, res);
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function listAll(supa, agent, res) {
  const { data, error } = await supa
    .from('curated_collections')
    .select('id, title, status, share_token, client_lead_id, intro_note, created_at, updated_at, leads(first_name,last_name), collection_listings(included), collection_reactions(id)')
    .eq('agent', agent)
    .order('updated_at', { ascending: false });
  if (error) return fail(res, 500, error.message);
  const collections = (data || []).map((c) => ({
    id: c.id, title: c.title, status: c.status, share_token: c.share_token,
    client_lead_id: c.client_lead_id,
    client_name: c.leads ? [c.leads.first_name, c.leads.last_name].filter(Boolean).join(' ') : null,
    included_count: (c.collection_listings || []).filter((l) => l.included).length,
    listing_count:  (c.collection_listings || []).length,
    reaction_count: (c.collection_reactions || []).length,
    created_at: c.created_at, updated_at: c.updated_at,
    share_path: `/c/${c.share_token}`
  }));
  return ok(res, { collections });
}

async function getOne(supa, agent, id, res) {
  const { data: c, error } = await supa
    .from('curated_collections')
    .select('*, leads(first_name,last_name,email,phone)')
    .eq('id', id).eq('agent', agent).maybeSingle();
  if (error) return fail(res, 500, error.message);
  if (!c)    return fail(res, 404, 'collection not found');

  const { data: cls } = await supa
    .from('collection_listings')
    .select('*, properties(*)')
    .eq('collection_id', id)
    .order('sort_order', { ascending: true });

  const listings = (cls || []).map((row) => ({
    id: row.id,
    property_id: row.property_id,
    included: row.included,
    agent_note: row.agent_note || '',
    note_style: row.note_style,
    why_note: row.why_note || '',
    priority: row.priority,
    sort_order: row.sort_order,
    listing: row.properties ? shapeListing(row.properties) : null
  }));

  const { data: reactions } = await supa
    .from('collection_reactions')
    .select('property_id, reaction, comment, client_label, created_at')
    .eq('collection_id', id)
    .order('created_at', { ascending: false });

  const { data: events } = await supa
    .from('collection_events')
    .select('event_type, property_id, dwell_ms, created_at')
    .eq('collection_id', id)
    .order('created_at', { ascending: false })
    .limit(200);

  const opens = (events || []).filter((e) => e.event_type === 'open').length;

  return ok(res, {
    collection: {
      id: c.id, title: c.title, status: c.status, share_token: c.share_token,
      share_path: `/c/${c.share_token}`,
      intro_note: c.intro_note || '', closing_note: c.closing_note || '',
      client_lead_id: c.client_lead_id,
      client_name: c.leads ? [c.leads.first_name, c.leads.last_name].filter(Boolean).join(' ') : null,
      client_email: c.leads?.email || null, client_phone: c.leads?.phone || null,
      expires_at: c.expires_at, created_at: c.created_at, updated_at: c.updated_at
    },
    listings,
    reactions: reactions || [],
    engagement: { opens, events: (events || []).slice(0, 50) }
  });
}

async function postAction(supa, agent, req, res) {
  const b = await readJson(req);
  const op = b?.op || 'create';

  if (op === 'create') {
    const row = {
      agent,
      title: typeof b?.title === 'string' ? b.title.trim() : null,
      client_lead_id: b?.client_lead_id || null,
      intro_note: b?.intro_note || null,
      closing_note: b?.closing_note || null,
      status: 'draft'
    };
    const { data, error } = await supa.from('curated_collections').insert(row).select().single();
    if (error) return fail(res, 500, error.message);
    return ok(res, { collection: { ...data, share_path: `/c/${data.share_token}` } });
  }

  if (op === 'set-listing') {
    if (!b?.collection_id || !b?.property_id) return fail(res, 400, 'collection_id and property_id required');
    const owned = await ownsCollection(supa, agent, b.collection_id);
    if (!owned) return fail(res, 404, 'collection not found');
    const style = NOTE_STYLES.includes(b?.note_style) ? b.note_style : 'sticky';
    const row = {
      collection_id: b.collection_id,
      property_id: b.property_id,
      included: b?.included !== undefined ? !!b.included : true,
      agent_note: b?.agent_note ?? null,
      note_style: style,
      why_note: b?.why_note ?? null,
      priority: !!b?.priority,
      sort_order: Number.isFinite(+b?.sort_order) ? +b.sort_order : 0
    };
    const { data, error } = await supa.from('collection_listings')
      .upsert(row, { onConflict: 'collection_id,property_id' }).select().single();
    if (error) return fail(res, 500, error.message);
    await touch(supa, b.collection_id);
    return ok(res, { listing: data });
  }

  if (op === 'add-listings') {
    if (!b?.collection_id || !Array.isArray(b?.property_ids) || !b.property_ids.length)
      return fail(res, 400, 'collection_id and property_ids[] required');
    const owned = await ownsCollection(supa, agent, b.collection_id);
    if (!owned) return fail(res, 404, 'collection not found');
    const rows = b.property_ids.map((pid, i) => ({
      collection_id: b.collection_id, property_id: pid, included: true, sort_order: i
    }));
    const { error } = await supa.from('collection_listings')
      .upsert(rows, { onConflict: 'collection_id,property_id' });
    if (error) return fail(res, 500, error.message);
    await touch(supa, b.collection_id);
    return ok(res, { added: rows.length });
  }

  if (op === 'remove-listing') {
    if (!b?.collection_id || !b?.property_id) return fail(res, 400, 'collection_id and property_id required');
    const owned = await ownsCollection(supa, agent, b.collection_id);
    if (!owned) return fail(res, 404, 'collection not found');
    const { error } = await supa.from('collection_listings')
      .delete().eq('collection_id', b.collection_id).eq('property_id', b.property_id);
    if (error) return fail(res, 500, error.message);
    await touch(supa, b.collection_id);
    return ok(res, { removed: true });
  }

  return fail(res, 400, `unknown op: ${op}`);
}

async function patchCollection(supa, agent, req, res) {
  const b = await readJson(req);
  if (!b?.id) return fail(res, 400, 'id required');
  const patch = {};
  if ('title' in b)        patch.title = b.title;
  if ('intro_note' in b)   patch.intro_note = b.intro_note;
  if ('closing_note' in b) patch.closing_note = b.closing_note;
  if ('expires_at' in b)   patch.expires_at = b.expires_at || null;
  if ('status' in b) {
    if (!COLL_STATUS.includes(b.status)) return fail(res, 400, `status must be one of ${COLL_STATUS.join(', ')}`);
    patch.status = b.status;
  }
  if (!Object.keys(patch).length) return fail(res, 400, 'nothing to update');
  const { data, error } = await supa.from('curated_collections')
    .update(patch).eq('id', b.id).eq('agent', agent).select().single();
  if (error) return fail(res, 500, error.message);
  return ok(res, { collection: { ...data, share_path: `/c/${data.share_token}` } });
}

async function deleteCollection(supa, agent, req, res) {
  const id = req.query?.id;
  if (!id) return fail(res, 400, 'id required');
  const { error } = await supa.from('curated_collections').delete().eq('id', id).eq('agent', agent);
  if (error) return fail(res, 500, error.message);
  return ok(res, { deleted: true, id });
}

async function ownsCollection(supa, agent, id) {
  const { data } = await supa.from('curated_collections').select('id').eq('id', id).eq('agent', agent).maybeSingle();
  return !!data;
}
async function touch(supa, id) {
  await supa.from('curated_collections').update({ updated_at: new Date().toISOString() }).eq('id', id);
}
