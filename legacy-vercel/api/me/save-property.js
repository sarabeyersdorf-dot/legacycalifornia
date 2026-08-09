// api/me/save-property.js
//   GET  /api/me/save-property           → { ids: [...] }  saved listing ids (button state)
//   POST /api/me/save-property           → { saved: bool }  toggle a save
//     body: { listing_id, address?, city?, price?, image?, unsave? }
//
// Native "save this home" for signed-in buyers — writes straight to our own
// saved_properties table, no third-party dependency. The listing itself is
// still displayed by the iHomefinder IDX widget, but the SAVE lives in our DB,
// keyed by the iHomefinder listing id (properties.ihomefinder_idx_id). The
// buyer dashboard reads saved_properties, so saves show up there immediately.

import { adminClient } from '../_lib/supabase.js';
import { getCallerProfile } from '../_lib/auth.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';

// Resolve (or create) the signed-in buyer's lead, so a save always has a home.
async function resolveLead(supa, user, profile) {
  let lead = null;
  if (profile && profile.lead_id) {
    const { data } = await supa.from('leads').select('id').eq('id', profile.lead_id).maybeSingle();
    lead = data || null;
  }
  const email = (user.email || '').toLowerCase();
  if (!lead && email) {
    const { data } = await supa.from('leads').select('id').eq('email', email).maybeSingle();
    lead = data || null;
  }
  if (!lead) {
    const { data, error } = await supa.from('leads').insert({
      email: email || null,
      source: 'website_form', status: 'active', assigned_agent: 'sara',
      pipeline_stage: 'new', lead_type: 'buyer',
      notes: 'Auto-created on first saved home'
    }).select('id').single();
    if (!error) lead = data;
  }
  if (lead && profile && !profile.lead_id) {
    await supa.from('users').update({ lead_id: lead.id }).eq('id', user.id).then(() => {}, () => {});
  }
  return lead;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user) return fail(res, 401, 'sign in to save homes');

  const supa = adminClient();
  const lead = await resolveLead(supa, user, profile);
  if (!lead) return fail(res, 500, 'could not resolve your account');

  // --- GET: which listings has this buyer saved (for the heart state) ---
  if (req.method === 'GET') {
    const { data } = await supa.from('saved_properties')
      .select('properties(ihomefinder_idx_id, mls_number)')
      .eq('lead_id', lead.id);
    const ids = (data || [])
      .map((r) => r.properties && (r.properties.ihomefinder_idx_id || r.properties.mls_number))
      .filter(Boolean);
    return ok(res, { ids });
  }

  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const b = await readJson(req);
  const unsave = !!b.unsave;

  // Path 2: save an EXISTING property directly by id (dashboard match/saved
  // cards, which are already rows in our properties table — no IDX lookup).
  const propertyId = b.property_id ? String(b.property_id).trim() : '';
  if (propertyId) {
    const { data: exists } = await supa.from('properties').select('id').eq('id', propertyId).maybeSingle();
    if (!exists) return fail(res, 404, 'property not found');
    if (unsave) {
      await supa.from('saved_properties').delete().eq('lead_id', lead.id).eq('property_id', propertyId);
      return ok(res, { saved: false });
    }
    const { error } = await supa.from('saved_properties')
      .upsert({ lead_id: lead.id, property_id: propertyId, tag: 'favorite', last_viewed_at: new Date().toISOString() },
              { onConflict: 'lead_id,property_id' });
    if (error) return fail(res, 500, error.message);
    return ok(res, { saved: true });
  }

  // Path 1: save by iHomefinder listing id (IDX search/detail cards).
  const listingId = String(b.listing_id || '').trim();
  if (!listingId) return fail(res, 400, 'listing_id or property_id required');
  const priceInt = (b.price != null && !isNaN(parseInt(b.price, 10))) ? parseInt(b.price, 10) : null;

  // Find the property row (keyed by iHomefinder listing id); create on first save.
  let { data: prop } = await supa.from('properties')
    .select('id').eq('ihomefinder_idx_id', listingId).maybeSingle();

  if (!prop) {
    if (unsave) return ok(res, { saved: false });   // nothing to remove
    const { data: ins, error } = await supa.from('properties').insert({
      ihomefinder_idx_id: listingId,
      address: b.address ? String(b.address).slice(0, 200) : null,
      city:    b.city ? String(b.city).slice(0, 80) : null,
      price:   priceInt,
      photos:  b.image ? [String(b.image)] : null,
      status:  'active'
    }).select('id').single();
    if (error) return fail(res, 500, error.message);
    prop = ins;
  }

  if (unsave) {
    await supa.from('saved_properties').delete().eq('lead_id', lead.id).eq('property_id', prop.id);
    return ok(res, { saved: false });
  }

  // Best-effort enrich (fill blanks the frontend now has), then save.
  const patch = {};
  if (b.address) patch.address = String(b.address).slice(0, 200);
  if (b.city)    patch.city = String(b.city).slice(0, 80);
  if (priceInt != null) patch.price = priceInt;
  if (Object.keys(patch).length) await supa.from('properties').update(patch).eq('id', prop.id).then(() => {}, () => {});

  const { error: sErr } = await supa.from('saved_properties')
    .upsert({ lead_id: lead.id, property_id: prop.id, tag: 'favorite', last_viewed_at: new Date().toISOString() },
            { onConflict: 'lead_id,property_id' });
  if (sErr) return fail(res, 500, sErr.message);

  await supa.from('lead_events')
    .insert({ lead_id: lead.id, event_type: 'property_saved', source: 'website_form', event_data: { listing_id: listingId, native: true } })
    .then(() => {}, () => {});

  return ok(res, { saved: true });
}
