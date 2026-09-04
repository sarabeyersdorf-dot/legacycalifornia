// api/_lib/lead-stage.js
// ONE definition of "which side is this contact on, and how far along are they."
//
// STEP 2 of collapsing the contact model (Sara chose "A then B", 2026-09-04).
// db/100 already made deal_side and roles derived. This file retires the other
// dead duplicate: `journey_stage`.
//
// WHY journey_stage GOES
// It was a buyer-intent ladder — discovering / narrowing / touring /
// ready_to_offer — written by the intake forms, the IDX webhook and the tour
// booker. On the live book it is set on 2 contacts out of 2,281. Meanwhile
// buyer_stage answers the same question, is set by the CRM and by the deal
// reconciler, and is what the pipeline, the kanban and the Contacts list read.
//
// Two ladders for one fact is the pattern that produced every drift bug this
// week, and the loser was journey_stage: the lead-scorer handed out +30 for
// 'ready_to_offer' and +20 for 'touring' on a field almost no lead carried, so
// a buyer who was genuinely writing an offer scored the same as a cold import.
//
// So: the FORMS keep sending journey_stage (their JavaScript is cached on
// visitors' browsers and must keep working unchanged), the server translates it
// to buyer_stage on the way in, and nothing stores or reads journey_stage any
// more. The column stays in place, commented as retired — see db/101.

// The intent a form states → where that actually puts them on the buyer ladder.
export const JOURNEY_TO_BUYER_STAGE = {
  discovering:    'new',
  narrowing:      'nurture',
  touring:        'showing_homes',
  ready_to_offer: 'writing_offers'
};

// How advanced a side stage is. Same order as contact-consistency.js and
// crm-lead-detail — a returning lead may progress, but a form submission must
// never DEMOTE someone the CRM already moved forward.
export const STAGE_RANK = {
  new: 0, nurture: 1, showing_homes: 2, preparing: 2, on_market: 3,
  writing_offers: 3, reviewing_offers: 3, in_escrow: 4, closed: 5
};

// Types that describe the RELATIONSHIP rather than a transaction. A form, a
// webhook or a deal must never silently overwrite one — a person who asked not
// to be contacted stays that way, and the buyer on our own listing is not our
// buyer. Single definition; contact-consistency.js imports it from here.
export const PROTECTED_TYPES = new Set(['do_not_contact', 'do_not_call', 'vendor', 'counterparty']);

// contact_type values that are merely "we haven't said" — a form stating a side
// is allowed to fill these in, and nothing else.
const UNSPECIFIC_TYPES = new Set([null, undefined, '', 'sphere', 'lead']);

export const isMoreAdvanced = (next, current) =>
  (STAGE_RANK[next] ?? -1) > (STAGE_RANK[current] ?? -1);

/**
 * The stage that describes what is IN FRONT OF US for this person: the most
 * advanced side they hold that has not finished, falling back to a finished one
 * only when every side is finished.
 *
 * Guy and Adrianna Castle bought 7230 Latigo (closed) and are selling 1143 Echo
 * (preparing). Plain "furthest along" files them Closed and buries a live
 * listing; plain "first side" is a coin toss. This is the rule the kanban, the
 * Contacts list and the lead scorer all need, so it lives in one place.
 *
 * @param {string[]} stages any mix of side stages, nulls ignored
 * @returns {string|null}
 */
export function bestLiveStage(stages) {
  const held = (stages || []).filter((x) => x && STAGE_RANK[x] != null);
  if (!held.length) return null;
  const live = held.filter((x) => x !== 'closed');
  return (live.length ? live : held).reduce((a, b) => (STAGE_RANK[b] > STAGE_RANK[a] ? b : a));
}

/**
 * What a lead capture is telling us about sides and stages.
 * Takes the wire fields a form still sends and returns real columns.
 *
 * @param {{journey_stage?: string, lead_type?: string}} wire
 * @returns {{buyer_stage?: string, seller_stage?: string, contact_type?: string}}
 */
export function sidesFromIntake(wire) {
  const jStage = JOURNEY_TO_BUYER_STAGE[wire.journey_stage] || null;
  const type   = wire.lead_type || null;
  const wantsBuyer  = type === 'buyer'  || type === 'both' || type === 'relocation' || (!type && !!jStage);
  const wantsSeller = type === 'seller' || type === 'both';

  const out = {};
  // A stated journey stage is buyer intent; a stated side with no stage still
  // means they are on that side, just at the beginning of it.
  if (wantsBuyer)  out.buyer_stage  = jStage || 'new';
  if (wantsSeller) out.seller_stage = 'new';
  if (wantsBuyer && wantsSeller) out.contact_type = 'both';
  else if (wantsBuyer)  out.contact_type = 'buyer';
  else if (wantsSeller) out.contact_type = 'seller';
  return out;
}

/**
 * Merge those into an EXISTING contact without ever losing curated work.
 * Rules, in order:
 *   • a protected type is left completely alone
 *   • a stage only ever moves forward
 *   • contact_type is only filled in when it says nothing specific
 *
 * @returns {object} the columns that should change (may be empty)
 */
export function mergeSidesInto(existing, wire) {
  if (PROTECTED_TYPES.has(existing.contact_type)) return {};
  const want = sidesFromIntake(wire);
  const patch = {};
  if (want.buyer_stage  && isMoreAdvanced(want.buyer_stage,  existing.buyer_stage))  patch.buyer_stage  = want.buyer_stage;
  if (want.seller_stage && isMoreAdvanced(want.seller_stage, existing.seller_stage)) patch.seller_stage = want.seller_stage;
  if (want.contact_type && UNSPECIFIC_TYPES.has(existing.contact_type || null)) {
    // Someone in the sphere who just filled in a buyer form IS a buyer now.
    patch.contact_type = want.contact_type;
  }
  return patch;
}

// Plain-language labels, so every AI prompt describes a contact the same way
// instead of each handler inventing its own line.
const BUYER_SAYS = {
  new: 'just started looking', nurture: 'narrowing down',
  showing_homes: 'touring homes', writing_offers: 'ready to write an offer',
  in_escrow: 'in escrow', closed: 'closed on a home'
};
const SELLER_SAYS = {
  new: 'thinking about selling', nurture: 'thinking about selling',
  preparing: 'preparing to list', on_market: 'on the market',
  reviewing_offers: 'reviewing offers', in_escrow: 'in escrow', closed: 'sold'
};

/** One human sentence for the prompts: "buyer, touring homes; seller, on the market". */
export function describeStage(lead) {
  const bits = [];
  if (lead.buyer_stage)  bits.push(`buyer, ${BUYER_SAYS[lead.buyer_stage]   || lead.buyer_stage}`);
  if (lead.seller_stage) bits.push(`seller, ${SELLER_SAYS[lead.seller_stage] || lead.seller_stage}`);
  if (bits.length) return bits.join('; ');
  if (lead.contact_type && !UNSPECIFIC_TYPES.has(lead.contact_type)) return String(lead.contact_type).replace(/_/g, ' ');
  return 'unknown';
}
