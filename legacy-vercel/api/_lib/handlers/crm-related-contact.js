// api/_lib/handlers/crm-related-contact.js
// POST /api/crm/related-contact   (agent-only)
//
// Adds a related contact (a spouse, usually) to an existing contact. The
// related person gets their OWN contact card, and the two are linked
// symmetrically in lead_relationships so the relationship shows on both cards.
//
// Body — link an EXISTING contact (what the typeahead sends):
//   { lead_id, related_lead_id: uuid, relationship?, include_on_comms? }
//
// Body — create a NEW contact (typed in by hand):
//   { lead_id, first_name, last_name?, email?, phone?, relationship?, include_on_comms? }
//
// Body — retarget an existing link's cc flag:
//   { lead_id, related_lead_id, op: 'set-include', include_on_comms: bool }
//
// related_lead_id is the preferred path and the one the card's typeahead uses:
// most spouses Sara "adds" are ALREADY in the book (1,600+ contacts), and the
// old create-only form silently minted a duplicate card for them whenever their
// email differed by a character or was blank. Matching on exact email was the
// only dedupe, which is no dedupe at all for the many contacts stored phone-only.
//
// include_on_comms (db/097) decides whether this person is offered as a cc on
// outreach to the primary. Written on BOTH symmetric rows on create, so the
// pairing reads the same from either card; the 'set-include' op writes only the
// direction being toggled, so "cc Larry when I write Bev" is independent of
// "cc Bev when I write Larry".
//
// If a contact with the given email already exists, we link that one instead of
// creating a duplicate. The new/linked contact inherits the primary's agent and
// client classification (spouses are almost always the same side of the deal).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RELATIONSHIPS = ['spouse', 'partner', 'co-buyer', 'co-seller', 'parent', 'child', 'family', 'other'];

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const b = await readJson(req);
    const leadId    = b?.lead_id;
    const relatedId = typeof b?.related_lead_id === 'string' ? b.related_lead_id.trim() : '';
    const includeOnComms = b?.include_on_comms === undefined ? true : !!b.include_on_comms;
    const firstName = typeof b?.first_name === 'string' ? b.first_name.trim() : '';
    const lastName  = typeof b?.last_name === 'string' ? b.last_name.trim() : '';
    const email     = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    const phone     = typeof b?.phone === 'string' ? b.phone.trim() : '';
    const relationship = RELATIONSHIPS.includes(b?.relationship) ? b.relationship : 'spouse';

    if (!leadId) return fail(res, 400, 'lead_id required');
    // Either pick an existing contact (typeahead) or type a new one — not neither.
    if (!relatedId && !firstName) return fail(res, 400, 'related_lead_id or first_name required');
    if (email && !EMAIL_RE.test(email)) return fail(res, 400, 'invalid email');

    const supa = adminClient();

    // ---- flip an existing link's cc flag; no contact is created or changed ----
    if (b?.op === 'set-include') {
      if (!relatedId) return fail(res, 400, 'related_lead_id required');
      const { error } = await supa.from('lead_relationships')
        .update({ include_on_comms: includeOnComms })
        .eq('lead_id', leadId).eq('related_lead_id', relatedId);
      if (error) return fail(res, 500, `include_on_comms (run db/097): ${error.message}`);
      return ok(res, { updated: true, include_on_comms: includeOnComms });
    }

    // The primary contact — for inheriting agent + client classification.
    const { data: primary, error: pErr } = await supa
      .from('leads').select('id, assigned_agent, contact_type, buyer_stage, seller_stage')
      .eq('id', leadId).maybeSingle();
    if (pErr)     return fail(res, 500, pErr.message);
    if (!primary) return fail(res, 404, 'contact not found');

    // Reuse an existing contact — by id when the typeahead picked one (the
    // reliable path), else by exact email; otherwise create one.
    let related = null, createdNew = false;
    if (relatedId) {
      const { data: picked, error: rErr } = await supa.from('leads')
        .select('id, first_name, last_name, email, phone').eq('id', relatedId).maybeSingle();
      if (rErr)    return fail(res, 500, rErr.message);
      if (!picked) return fail(res, 404, 'selected contact not found');
      related = picked;
    }
    if (!related && email) {
      const { data: existing } = await supa.from('leads')
        .select('id, first_name, last_name, email, phone').eq('email', email).maybeSingle();
      if (existing) related = existing;
    }
    if (!related) {
      const inherit = {
        contact_type: primary.contact_type || 'client',
        buyer_stage:  primary.buyer_stage || null,
        seller_stage: primary.seller_stage || null
      };
      const { data: created, error: insErr } = await supa.from('leads').insert({
        first_name:     firstName,
        last_name:      lastName || null,
        email:          email || null,
        phone:          phone || null,
        source:         'related_contact',
        assigned_agent: primary.assigned_agent || 'sara',
        ...inherit,
        notes:          `Added as ${relationship} of contact ${leadId}.`
      }).select('id, first_name, last_name, email, phone').single();
      // Name the offending value: a bare "violates check constraint" tells the
      // agent (and whoever they report it to) nothing they can act on.
      if (insErr) return fail(res, 500, `contact create (source='related_contact'): ${insErr.message}`);
      related = created; createdNew = true;
    }

    if (related.id === leadId) return fail(res, 409, 'a contact cannot be related to itself');

    // Symmetric link (upsert both directions; ignore if already present).
    // Fail-soft: if lead_relationships isn't migrated yet (db/044), the contact
    // is still created — the link just can't be recorded until the table exists.
    const rows = [
      { lead_id: leadId,      related_lead_id: related.id, relationship, include_on_comms: includeOnComms },
      { lead_id: related.id,  related_lead_id: leadId,     relationship, include_on_comms: includeOnComms }
    ];
    // ignoreDuplicates so re-adding an already-linked pair is a no-op rather than
    // an error. Retry without include_on_comms if db/097 hasn't landed yet — the
    // link still gets made, it just can't carry the cc flag until it has.
    let { error: relErr } = await supa.from('lead_relationships')
      .upsert(rows, { onConflict: 'lead_id,related_lead_id', ignoreDuplicates: true });
    if (relErr && /include_on_comms/i.test(relErr.message || '')) {
      ({ error: relErr } = await supa.from('lead_relationships')
        .upsert(rows.map(({ include_on_comms, ...r }) => r), { onConflict: 'lead_id,related_lead_id', ignoreDuplicates: true }));
    }

    return ok(res, {
      related: { ...related, relationship, include_on_comms: includeOnComms },
      created_new: createdNew,
      linked_existing: !createdNew,
      linked: !relErr,
      warning: relErr ? 'Contact created, but the relationship link needs migration db/044.' : undefined
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
