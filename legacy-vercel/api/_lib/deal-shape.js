// api/_lib/deal-shape.js
//
// Shared "what stage is this deal actually at, in plain language" logic.
// Before this file existed, crm-deal-ledger.js and crm-morning-brief.js
// (shapeDealsInMotion) each had their own copy-pasted version of the same
// escrow/offer stage math — same formula, same wording, just typed twice.
// That's exactly the kind of duplication that quietly drifts: someone tweaks
// the "days to close" rounding or the overdue wording in one file during a
// bug fix and forgets the other one exists.
//
// This does NOT merge the two endpoints into one. They stay separate on
// purpose:
//   - crm-morning-brief.js's "deals in motion" cards intentionally scope to
//     stage IN ('offer','pending') only — on-market listings are excluded,
//     per that file's own comment ("On-market listings are NOT deals in
//     motion — they live in the Deals & Offers view").
//   - crm-deal-ledger.js's Ledger intentionally scopes wider — ACTIVE_STAGES
//     includes 'listing' and 'preparing' too, matching what crm-calendar.js
//     already treats as an active deal for its picker.
//   - The two views also render different shapes for different UI: the
//     brief wants a full sentence for a narrative card; the Ledger wants a
//     short chip key it can color and a separate short stage word.
//
// Only the underlying stage-timing calculation is shared, here, so both
// views can't quietly disagree about how many days are left until closing.

// Days until close-of-escrow, rounded to whole days. Positive = in the
// future, negative = overdue, null if there's no coe_date to compare.
export function daysToCoe(coeDate) {
  if (!coeDate) return null;
  const coe = new Date(coeDate);
  if (isNaN(coe.getTime())) return null;
  return Math.round((coe.getTime() - Date.now()) / 86400000);
}

// Long-form stage sentence — "In escrow · 12 days to close", "Offer out",
// "On market", etc. Used by the morning brief's deal cards. Does NOT know
// about 'preparing' (the brief's query never returns that stage); callers
// that can see 'preparing' deals (the Ledger) should check for it first.
export function escrowStageSentence(d) {
  const inEscrow = d.stage === 'pending';
  const isOffer = d.stage === 'offer';
  if (inEscrow) {
    const days = daysToCoe(d.coe_date);
    if (days == null) return 'In escrow';
    if (days >= 0) return `In escrow · ${days} day${days === 1 ? '' : 's'} to close`;
    return 'Closing overdue';
  }
  if (isOffer) return d.side === 'buyer' ? 'Offer out' : 'Offer in';
  return 'On market';
}

// Short side key for chip rendering: 'buy' | 'sell' | 'dual' | null.
// Returns null (not a default) for anything unrecognized, so callers that
// need a guaranteed string (like the brief's "Buy-side"/"Sell-side" text)
// apply their own fallback on top of this.
export function sideKey(side) {
  if (side === 'both') return 'dual';
  if (side === 'buyer') return 'buy';
  if (side === 'seller') return 'sell';
  return null;
}
