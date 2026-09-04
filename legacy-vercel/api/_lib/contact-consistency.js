// api/_lib/contact-consistency.js
// One rule, in one place: WHEN A CONTACT IS A PARTY ON A DEAL, THE DEAL DECIDES
// THEIR SIDE AND THEIR STAGE.
//
// WHY THIS EXISTS
// Nothing used to reconcile the two. `pipeline_stage` was derived from a
// contact's own contact_type + side stages (crm-lead-detail), which is correct
// as far as it goes — but the DEAL was never part of that chain. deal_parties
// records who is on which deal in what role, `deals` carries the stage, and a
// contact's buyer_stage/seller_stage/contact_type were hand-set from a dropdown
// that could contradict both, silently, with nothing to detect it afterwards.
//
// On 2026-09-04 that had produced drift on 8 of 17 party rows:
//   • Guy and Adrianna Castle closed on 7230 Latigo and both records still read
//     in_escrow, so they sat in the under-contract pipeline instead of becoming
//     past clients worth asking for a referral.
//   • Brian Fitzgerald was filed 'sphere' with NO stage while 324 Augusta was on
//     the market with us.
//   • Chitra Brahme was filed 'past_client' in a nurture drip while we were
//     preparing her listing at 517 Forest Meadows.
//   • Jim and Yvonne Heryford read in_escrow on 433 E Highway 4 — whose escrow
//     is status='cancelled'. The escrow fell through, the deal went back to
//     'listing', and nobody moved the contacts back. That one is the whole bug
//     in a single row: the deal knew, the contacts did not.
//
// THE AUTHORITY ORDER, and why the deal wins
// db/091 already established that a deal's effective stage is
// coalesce(stage_override, stage) and that the app reads it everywhere. A person
// is a seller because they have a listing with us, not because someone picked
// "seller" in a dropdown — so the deal is the fact and the contact record is the
// projection. Where a contact sits on several deals, the most advanced one wins,
// which is what the header and kanban should show.
//
// WHAT IS DELIBERATELY NOT TOUCHED
//   • contact_type 'do_not_contact' / 'vendor' / 'counterparty' — these are
//     statements about the RELATIONSHIP, not the transaction, and a deal must
//     never silently un-suppress someone who asked not to be contacted.
//   • Anyone with no deal_parties row. Their record is all we have.
//   • Identity and consent fields. This only ever writes side/stage columns.

// Deal stage (effective) → the side stage a party of that deal should carry.
// 'dead', 'cancelled' and 'inactive' deliberately map to null rather than a
// stage: a fallen-through escrow means the person is no longer in one, and the
// deal's own stage then says where they actually are.
const DEAL_STAGE_TO_SIDE = {
  'buyer-prospect': 'showing_homes',
  preparing:        'preparing',
  listing:          'on_market',
  offer:            'reviewing_offers',
  pending:          'in_escrow',
  closed:           'closed'
};

// How advanced a side stage is, so a contact on several deals follows the
// furthest-along one. Matches crm-lead-detail's STAGE_RANK.
const RANK = { new: 0, nurture: 1, showing_homes: 2, preparing: 2, on_market: 3, writing_offers: 3, reviewing_offers: 3, in_escrow: 4, closed: 5 };

// The coarse pipeline_stage the kanban and the Contacts list read. Must be
// recomputed here too: the first cut of this file wrote the side stages and left
// pipeline_stage alone, which just moved the drift one field along — Guy and
// Adrianna Castle came out buyer_stage 'closed' + seller_stage 'preparing' while
// pipeline_stage still said 'under_contract', so the list showed "In escrow" for
// a sale that had closed. Same mapping as crm-lead-detail's STAGE_TO_PIPELINE.
const STAGE_TO_PIPELINE = {
  new: 'new', nurture: 'nurture',
  showing_homes: 'active', preparing: 'active', on_market: 'active',
  writing_offers: 'active', reviewing_offers: 'active',
  in_escrow: 'under_contract', closed: 'closed'
};

// Types that describe the relationship rather than a transaction. A deal never
// overwrites these — see the note above.
const PROTECTED_TYPES = new Set(['do_not_contact', 'do_not_call', 'vendor', 'counterparty']);

const isSellerRole = (role) => /seller/i.test(String(role || ''));
const isBuyerRole  = (role) => /buyer/i.test(String(role || ''));

/**
 * Work out what every deal-party contact's side/stage SHOULD be, and return only
 * the ones that currently differ. Pure: it reads, compares and reports; the
 * caller decides whether to write.
 *
 * @param supa admin client
 * @returns {{changes: Array, checked: number}} changes carry {lead_id, name, patch, because}
 */
export async function computeContactFixes(supa) {
  const safe = (p) => p.then((r) => r, () => ({ data: [] }));
  const [{ data: parties }, { data: deals }] = await Promise.all([
    safe(supa.from('deal_parties').select('deal_id, lead_id, role').limit(5000)),
    safe(supa.from('deals').select('id, address, stage, stage_override').limit(2000))
  ]);
  if (!parties || !parties.length) return { changes: [], checked: 0 };

  const dealById = new Map((deals || []).map((d) => [d.id, d]));
  const leadIds = [...new Set(parties.map((p) => p.lead_id).filter(Boolean))];
  if (!leadIds.length) return { changes: [], checked: 0 };

  const { data: leads } = await safe(supa.from('leads')
    .select('id, first_name, last_name, contact_type, buyer_stage, seller_stage, pipeline_stage, deal_side')
    .in('id', leadIds));

  // Gather, per contact, the best (most advanced) stage seen on each side.
  const want = new Map();   // lead_id -> { buyer, seller, why: [] }
  for (const p of parties) {
    const d = dealById.get(p.deal_id);
    if (!d || !p.lead_id) continue;
    const effective = d.stage_override || d.stage;
    const side = DEAL_STAGE_TO_SIDE[effective];
    if (!side) continue;                       // dead / cancelled / unknown — say nothing
    const slot = isSellerRole(p.role) ? 'seller' : isBuyerRole(p.role) ? 'buyer' : null;
    if (!slot) continue;
    let w = want.get(p.lead_id);
    if (!w) { w = { buyer: null, seller: null, why: [] }; want.set(p.lead_id, w); }
    if (w[slot] == null || (RANK[side] ?? -1) > (RANK[w[slot]] ?? -1)) w[slot] = side;
    w.why.push(`${d.address || p.deal_id} (${p.role}) is ${effective}`);
  }

  const changes = [];
  for (const l of (leads || [])) {
    const w = want.get(l.id);
    if (!w) continue;
    // A protected type is skipped ENTIRELY, not just for contact_type. A
    // counterparty or a vendor is on the deal as a fact of the file, not as a
    // position in our pipeline — giving Denis Listengourt a buyer_stage of
    // 'on_market' because he is the buyer on our Augusta listing would put him
    // straight back in the pipeline this category exists to keep him out of.
    if (PROTECTED_TYPES.has(l.contact_type)) continue;
    const patch = {};
    if (w.buyer  && l.buyer_stage  !== w.buyer)  patch.buyer_stage  = w.buyer;
    if (w.seller && l.seller_stage !== w.seller) patch.seller_stage = w.seller;

    // contact_type follows from which sides they actually hold — but never
    // overwrite a protected type, and never demote a type that is already at
    // least as specific as what the deal implies.
    // Coarse stage follows the LIVE side, not the most advanced one. Guy and
    // Adrianna Castle bought 7230 Latigo (closed) and are now selling 1143 Echo
    // (preparing). Taking the furthest-along stage would file them 'closed' and
    // bury a live listing; what Sara needs to see is the work in front of her.
    // So: pick the most advanced stage among the UNFINISHED sides, and only fall
    // back to closed when every side they hold is finished.
    const held = [w.buyer || l.buyer_stage, w.seller || l.seller_stage].filter((x) => x && RANK[x] != null);
    const live = held.filter((x) => x !== 'closed');
    if (held.length) {
      const best = (live.length ? live : held).reduce((a, b) => ((RANK[b] > RANK[a]) ? b : a));
      const wantPipeline = STAGE_TO_PIPELINE[best] || null;
      if (wantPipeline && l.pipeline_stage !== wantPipeline) patch.pipeline_stage = wantPipeline;
    }

    const sides = [w.buyer ? 'buyer' : null, w.seller ? 'seller' : null].filter(Boolean);
    const impliedSide = sides.length === 2 ? 'both' : sides[0] || null;
    // deal_side and roles are NOT written here any more: db/100 derives both in a
    // BEFORE trigger from contact_type + the side stages, so writing them from
    // here would be a second opinion on a settled question — exactly the pattern
    // that produced the drift in the first place.
    if (impliedSide && !PROTECTED_TYPES.has(l.contact_type)) {
      // 'client' and 'closed' are already transaction-grade; leave them be.
      // 'sphere' / 'past_client' / null on someone with a live deal is the bug.
      const keep = new Set(['client', 'closed', 'both', impliedSide]);
      if (!keep.has(l.contact_type)) patch.contact_type = impliedSide;
    }

    if (Object.keys(patch).length) {
      changes.push({
        lead_id: l.id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.id,
        patch,
        because: w.why
      });
    }
  }
  return { changes, checked: leadIds.length };
}

/**
 * Apply the fixes. Writes only side/stage columns, one contact at a time so a
 * single bad row can never abort the rest — this runs inside the hourly sync and
 * must never take it down.
 */
export async function reconcileContactsToDeals(supa, { dryRun = false } = {}) {
  const { changes, checked } = await computeContactFixes(supa);
  if (dryRun || !changes.length) return { checked, changed: 0, changes };

  let changed = 0;
  const errors = [];
  for (const c of changes) {
    const { error } = await supa.from('leads').update(c.patch).eq('id', c.lead_id);
    if (error) errors.push({ lead_id: c.lead_id, error: error.message });
    else changed++;
  }
  return { checked, changed, changes, errors: errors.length ? errors : undefined };
}
