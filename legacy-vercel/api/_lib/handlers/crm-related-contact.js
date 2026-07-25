// api/_lib/handlers/crm-related-contact.js
// POST /api/crm/related-contact   (agent-only)
//
// Adds a related contact (a spouse, usually) to an existing contact. The
// related person gets their OWN contact card, and the two are linked
// symmetrically in lead_relationships so the relationship shows on both cards.
//
// Body:
//   {
//     lead_id:      uuid,    required — the contact we're adding a relation TO
//     first_name:   string,  required
//     last_name?:   string,
//     email?:       string,
//     phone?:       string,
//     relationship: string   default 'spouse'
//   }
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
    const firstName = typeof b?.first_name === 'string' ? b.first_name.trim() : '';
    const lastName  = typeof b?.last_name === 'string' ? b.last_name.trim() : '';
    const email     = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    const phone     = typeof b?.phone === 'string' ? b.phone.trim() : '';
    const relationship = RELATIONSHIPS.includes(b?.relationship) ? b.relationship : 'spouse';

    if (!leadId)     return fail(res, 400, 'lead_id required');
    if (!firstName)  return fail(res, 400, 'first_name required');
    if (email && !EMAIL_RE.test(email)) return fail(res, 400, 'invalid email');

    const supa = adminClient();

    // The primary contact — for inheriting agent + client classification.
    const { data: primary, error: pErr } = await supa
      .from('leads').select('id, assigned_agent, contact_type, buyer_stage, seller_stage')
      .eq('id', leadId).maybeSingle();
    if (pErr)     return fail(res, 500, pErr.message);
    if (!primary) return fail(res, 404, 'contact not found');

    // Reuse an existing contact by exact email; otherwise create one.
    let related = null, createdNew = false;
    if (email) {
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
      if (insErr) return fail(res, 500, `contact create: ${insErr.message}`);
      related = created; createdNew = true;
    }

    if (related.id === leadId) return fail(res, 409, 'a contact cannot be related to itself');

    // Symmetric link (upsert both directions; ignore if already present).
    // Fail-soft: if lead_relationships isn't migrated yet (db/044), the contact
    // is still created — the link just can't be recorded until the table exists.
    const rows = [
      { lead_id: leadId,      related_lead_id: related.id, relationship },
      { lead_id: related.id,  related_lead_id: leadId,     relationship }
    ];
    const { error: relErr } = await supa.from('lead_relationships')
      .upsert(rows, { onConflict: 'lead_id,related_lead_id', ignoreDuplicates: true });

    return ok(res, {
      related: { ...related, relationship },
      created_new: createdNew,
      linked: !relErr,
      warning: relErr ? 'Contact created, but the relationship link needs migration db/044.' : undefined
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
