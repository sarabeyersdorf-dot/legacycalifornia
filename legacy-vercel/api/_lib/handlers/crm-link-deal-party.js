// api/_lib/handlers/crm-link-deal-party.js
// POST /api/crm/link-deal-party
//
// Links a client (person) to one of their transactions so that a signed-in
// buyer/seller sees ONLY their own portal. Agent-only.
//
// This closes the identity chain the seller portal walks:
//   users (auth) -> users.lead_id -> leads -> deal_parties(role) -> deals
//
// The endpoint is idempotent and does three things:
//   1. Finds (or creates) the client's `leads` row, keyed by email.
//   2. Upserts a `deal_parties` row tying that lead to the deal with a role.
//   3. Attaches an auth account to the lead so seller.html's role-gated auth
//      lets the client in:
//        - If they already have an account, point users.lead_id at the lead and
//          promote users.role to 'seller'/'buyer' (never demoting an agent).
//        - If they don't and `provision: true` is passed, create a confirmed
//          auth account (NO email is sent) and promote it, so the client can
//          sign in with the normal magic link immediately.
//        - Otherwise return `user_pending: true`. The link still activates the
//          moment they sign in with this email, because GET /api/seller/portal
//          falls back to matching the lead by the signed-in email.
//
// Body:
//   {
//     deal?:        source_key (deals.json id, e.g. "433-hwy4"),
//     deal_id?:     uuid (either deal or deal_id is required),
//     email:        string  (the client — required),
//     first_name?:  string,
//     last_name?:   string,
//     phone?:       string,
//     role?:        'seller' | 'co-seller' | 'buyer' | 'co-buyer'  (default 'seller'),
//     provision?:   boolean (default false — create a confirmed auth account if
//                   the client has none yet; never sends email)
//   }

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const VALID_ROLES = ['seller', 'co-seller', 'buyer', 'co-buyer'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A party role maps to a leads.lead_type and a users.role.
const roleToLeadType = (role) => (role === 'buyer' || role === 'co-buyer') ? 'buyer' : 'seller';
const roleToUserRole = (role) => (role === 'buyer' || role === 'co-buyer') ? 'buyer' : 'seller';

// GoTrue has no server-side email filter, so page through the admin user list.
// Auth users (people who have actually signed in) are far fewer than leads, so
// a bounded scan is cheap. Cap the scan so a runaway never hangs the request.
async function findAuthUserByEmail(supa, email) {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) break; // reached the last page
  }
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);
    const sourceKey = typeof body?.deal === 'string' ? body.deal.trim() : '';
    const dealId    = typeof body?.deal_id === 'string' ? body.deal_id.trim() : '';
    const email     = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const firstName = typeof body?.first_name === 'string' ? body.first_name.trim() : null;
    const lastName  = typeof body?.last_name === 'string' ? body.last_name.trim() : null;
    const phone     = typeof body?.phone === 'string' ? body.phone.trim() : null;
    const role      = (typeof body?.role === 'string' ? body.role.trim() : 'seller') || 'seller';
    const provision = body?.provision === true;

    if (!sourceKey && !dealId) return fail(res, 400, 'deal (source_key) or deal_id is required');
    if (!email)                return fail(res, 400, 'email is required');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'email is not a valid address');
    if (!VALID_ROLES.includes(role)) return fail(res, 400, `role must be one of: ${VALID_ROLES.join(', ')}`);

    const supa = adminClient();

    // 1. Resolve the deal --------------------------------------------------
    let dealQuery = supa.from('deals').select('id, source_key, address, agent');
    dealQuery = dealId ? dealQuery.eq('id', dealId) : dealQuery.eq('source_key', sourceKey);
    const { data: deal, error: dealErr } = await dealQuery.maybeSingle();
    if (dealErr) return fail(res, 500, `deal lookup: ${dealErr.message}`);
    if (!deal)   return fail(res, 404, `deal not found (${dealId || sourceKey})`);

    // 2. Find or create the client's lead (keyed by email) -----------------
    let leadCreated = false;
    let { data: lead, error: leadErr } = await supa
      .from('leads').select('id, email, first_name, last_name').eq('email', email).maybeSingle();
    if (leadErr) return fail(res, 500, `lead lookup: ${leadErr.message}`);

    if (!lead) {
      const { data: created, error: insErr } = await supa.from('leads').insert({
        email,
        first_name:     firstName,
        last_name:      lastName,
        phone,
        source:         'manual',
        lead_type:      roleToLeadType(role),
        assigned_agent: deal.agent === 'james' ? 'james' : 'sara',
        notes:          `Linked to deal ${deal.source_key || deal.id} (${role}) by ${profile.role}.`
      }).select('id, email, first_name, last_name').single();
      if (insErr) return fail(res, 500, `lead create: ${insErr.message}`);
      lead = created;
      leadCreated = true;
    } else if ((firstName && !lead.first_name) || (lastName && !lead.last_name) || phone) {
      // Backfill name/phone only where empty — never clobber existing CRM data.
      const patch = {};
      if (firstName && !lead.first_name) patch.first_name = firstName;
      if (lastName && !lead.last_name)   patch.last_name  = lastName;
      if (phone)                         patch.phone      = phone;
      if (Object.keys(patch).length) await supa.from('leads').update(patch).eq('id', lead.id);
    }

    // 3. Upsert the deal_parties link (idempotent on the composite PK) ------
    const { error: partyErr } = await supa
      .from('deal_parties')
      .upsert({ deal_id: deal.id, lead_id: lead.id, role }, { onConflict: 'deal_id,lead_id' });
    if (partyErr) return fail(res, 500, `deal_parties link: ${partyErr.message}`);

    // 4. Attach an auth account to this lead -------------------------------
    // Promote an auth user (by id) to point at this lead, never demoting an
    // agent/admin. Returns the applied patch or throws on write error.
    const promote = async (authUserId) => {
      const { data: appUser } = await supa
        .from('users').select('id, role, lead_id').eq('id', authUserId).maybeSingle();
      const currentRole = appUser?.role || null;
      const keepRole = currentRole && (/^agent_/.test(currentRole) || currentRole === 'admin');
      const patch = { id: authUserId, lead_id: lead.id };
      if (!keepRole) patch.role = roleToUserRole(role);
      const { error: upErr } = await supa.from('users').upsert(patch, { onConflict: 'id' });
      if (upErr) throw new Error(`users link: ${upErr.message}`);
    };

    let userLinked = false;
    let userPending = true;
    let userProvisioned = false;

    const authUser = await findAuthUserByEmail(supa, email);
    if (authUser) {
      await promote(authUser.id);
      userLinked = true;
      userPending = false;
    } else if (provision) {
      // Create a confirmed auth account (no email sent). The client signs in
      // later with the normal magic link using this same email.
      const display = [lead.first_name || firstName, lead.last_name || lastName].filter(Boolean).join(' ') || null;
      const { data: created, error: cErr } = await supa.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: display ? { display_name: display } : undefined
      });
      if (cErr) return fail(res, 500, `auth provision: ${cErr.message}`);
      const newId = created?.user?.id;
      if (!newId) return fail(res, 500, 'auth provision: no user id returned');
      await promote(newId);
      userLinked = true;
      userPending = false;
      userProvisioned = true;
    }

    return ok(res, {
      linked: true,
      deal:   { id: deal.id, source_key: deal.source_key, address: deal.address },
      lead:   { id: lead.id, email: lead.email, created: leadCreated },
      party:  { role },
      user_linked:      userLinked,      // an auth account is pointed at this lead
      user_provisioned: userProvisioned, // a new confirmed auth account was created
      user_pending:     userPending      // no auth account yet — link activates on first sign-in
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
