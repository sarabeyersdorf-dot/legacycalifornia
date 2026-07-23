// api/_lib/deal-parties.js
// One place that merges a deal's people/escrow info from the two sources:
//   1. deals.json (synced onto the deals row as prose: escrow_officer,
//      title_company, co_agent, coe_date, listing_meta.client), and
//   2. the agent's structured overlay (deals.party_details, db/029).
// The overlay always wins; prose fills the gaps. Used by every deal surface
// (listings, deals-in-motion, the deal-parties editor) so they all agree.

// A clean party object or null (drop all-empty).
function party(o) {
  if (!o || typeof o !== 'object') return null;
  const p = {};
  for (const k of ['name', 'company', 'brokerage', 'phone', 'email', 'officer', 'number', 'lead_id']) {
    const v = o[k];
    if (v != null && String(v).trim() !== '') p[k] = String(v).trim();
  }
  return Object.keys(p).length ? p : null;
}

// Merge the deals-row prose base + party_details overlay into a structured,
// display-ready parties object. `d` is a deals row (any column subset).
export function resolveParties(d) {
  const ov = (d && d.party_details && typeof d.party_details === 'object') ? d.party_details : {};
  const meta = (d && d.listing_meta && typeof d.listing_meta === 'object') ? d.listing_meta : {};

  // Escrow: overlay first; else the deals.json prose (officer + company).
  const escrowBase = (d && (d.escrow_officer || d.title_company))
    ? party({ officer: d.escrow_officer, company: d.title_company })
    : null;

  // Co-agent: overlay first; else the deals.json prose name.
  const coAgentBase = (d && d.co_agent) ? party({ name: d.co_agent }) : null;

  return {
    agent:   d ? (d.agent || null) : null,
    side:    d ? (d.side || null) : null,
    coe:     (ov.coe && String(ov.coe).trim()) || (d ? (d.coe_date || null) : null),
    // The seller-side "client" name deals.json already carries (listing_meta).
    client_name: meta.client || null,
    buyer:    party(ov.buyer),
    buyer2:   party(ov.buyer2),
    seller:   party(ov.seller) || (meta.client && (d?.side === 'seller' || d?.side === 'listing' || d?.side === 'both') ? party({ name: meta.client }) : null),
    seller2:  party(ov.seller2),
    co_agent: party(ov.co_agent) || coAgentBase,
    tc:       party(ov.tc),
    escrow:   party(ov.escrow) || escrowBase,
    lender:   party(ov.lender),
    // True when the agent has saved any structured overlay (vs pure deals.json).
    has_overlay: !!(d && d.party_details && Object.keys(d.party_details).length)
  };
}

// A one-line summary of the key people for a compact card, e.g.
// "Buyer: Ashley Robinson · Co-agent: Busy Bee Realty · Escrow #P-704376".
export function partySummary(parties) {
  if (!parties) return '';
  const bits = [];
  const nm = (p) => p && (p.name || p.officer || p.company);
  if (nm(parties.buyer))    bits.push('Buyer: ' + nm(parties.buyer));
  if (nm(parties.seller))   bits.push('Seller: ' + nm(parties.seller));
  if (nm(parties.co_agent)) bits.push('Co-agent: ' + nm(parties.co_agent));
  if (parties.escrow && parties.escrow.number) bits.push('Escrow #' + parties.escrow.number);
  return bits.join(' · ');
}

// Sanitize an incoming party_details overlay before persisting — keep only the
// known sections and known keys, trim strings, drop empties. Never trust the
// client to send arbitrary jsonb.
export function sanitizeOverlay(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const section of ['buyer', 'buyer2', 'seller', 'seller2', 'co_agent', 'tc', 'escrow', 'lender']) {
    const p = party(input[section]);
    if (p) out[section] = p;
  }
  if (input.coe != null && String(input.coe).trim() !== '') {
    // Accept a plain, REAL calendar date (YYYY-MM-DD) only — reject impossible
    // ones like 2026-13-99 that pass a format check but aren't valid dates.
    const s = String(input.coe).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const dt = new Date(s + 'T12:00:00Z');
      if (!isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s) out.coe = s;
    }
  }
  return out;
}
