// api/_lib/match.js
//
// Shared listing-match scoring + a "live preference" model for buyer alerts.
//
// matchPct/statusForMatch/fmtSpecs mirror the buyer dashboard's scorer so the
// dashboard's "matches" and the emailed alerts rank identically. derivePrefs is
// the dynamic part: it blends a buyer's stated brief (leads columns) with what
// they've actually FAVORITED (saved_properties) so the search tracks real
// behaviour — the homes they gravitate to — not just what they typed on day one.

export const fmtSpecs = (p) => {
  const bits = [];
  if (p.bedrooms)  bits.push(`${p.bedrooms} bed`);
  if (p.bathrooms) bits.push(`${p.bathrooms} bath`);
  if (p.sq_ft)     bits.push(`${(+p.sq_ft).toLocaleString()} sq ft`);
  if (!bits.length && p.lot_acres) bits.push(`${p.lot_acres} ac`);
  return bits.join(' · ') || '';
};

export function matchPct(lead, p) {
  let score = 0;
  // Price (40)
  if (p.price && lead.price_min && lead.price_max) {
    if (p.price >= lead.price_min && p.price <= lead.price_max) score += 40;
    else {
      const mid  = (lead.price_min + lead.price_max) / 2;
      const dist = Math.abs(p.price - mid) / mid;
      score += Math.max(0, Math.round(40 * (1 - dist)));
    }
  } else if (p.price && lead.price_max && p.price <= lead.price_max) {
    score += 30;
  } else {
    score += 20;
  }
  // Area (30)
  const areas = (lead.areas || []).map((a) => String(a).toLowerCase());
  if (areas.length && p.city && areas.includes(p.city.toLowerCase())) score += 30;
  else if (!areas.length) score += 15;
  // Beds (15)
  const wantBeds = parseInt(((lead.must_haves || []).find((m) => /\d+\s*bed/i.test(m)) || '').match(/\d+/)?.[0] || '3', 10);
  if (p.bedrooms && p.bedrooms >= wantBeds) score += 15;
  else score += 5;
  // Lot (15)
  const wantsLand = (lead.must_haves || []).some((m) => /acre|land|lot|privacy/i.test(m));
  if (wantsLand && p.lot_acres && p.lot_acres >= 1) score += 15;
  else if (!wantsLand) score += 10;
  return Math.max(0, Math.min(100, score));
}

export function statusForMatch(pct) {
  if (pct >= 85) return 'Strong match';
  if (pct >= 70) return 'Worth a look';
  if (pct >= 55) return 'Maybe';
  return 'Stretch';
}

// Build a live preference profile: the buyer's brief, stretched toward what they
// actually save. Favorites can widen the price band, add towns they keep saving
// in, and imply beds/acreage — so alerts follow behaviour even when it drifts
// from the original profile.
export function derivePrefs(lead, savedProps) {
  const saved  = (savedProps || []).map((s) => (s && s.properties) || s).filter(Boolean);
  const prices = saved.map((p) => +p.price).filter((n) => n > 0).sort((a, b) => a - b);
  const cities = saved.map((p) => (p.city || '').trim()).filter(Boolean);
  const beds   = saved.map((p) => +p.bedrooms).filter((n) => n > 0).sort((a, b) => a - b);
  const acres  = saved.map((p) => +p.lot_acres).filter((n) => n > 0);

  let price_min = lead.price_min || null;
  let price_max = lead.price_max || null;
  if (prices.length) {
    const lo = prices[0], hi = prices[prices.length - 1];
    price_min = price_min ? Math.min(price_min, Math.round(lo * 0.9)) : Math.round(lo * 0.85);
    price_max = price_max ? Math.max(price_max, Math.round(hi * 1.1)) : Math.round(hi * 1.15);
  }
  const savedCities = Array.from(new Set(cities));
  const areas = Array.from(new Set([...(lead.areas || []), ...savedCities].map((a) => String(a)).filter(Boolean)));
  const must_haves = [...(lead.must_haves || [])];
  if (beds.length) {
    const med = beds[Math.floor(beds.length / 2)];
    if (med && !must_haves.some((m) => /\d+\s*bed/i.test(m))) must_haves.push(`${med} bed`);
  }
  if (acres.some((a) => a >= 1) && !must_haves.some((m) => /acre|land|lot|privacy/i.test(m))) must_haves.push('acreage');

  return { ...lead, price_min, price_max, areas, must_haves,
           _signal: { savedCount: saved.length, savedCities } };
}

// A short, human "why this one" line for a matched home — makes the alert feel
// hand-picked rather than a filter dump.
export function reasonFor(prefs, p) {
  const bits = [];
  const sc = (prefs._signal && prefs._signal.savedCities) || [];
  if (p.city && sc.map((c) => c.toLowerCase()).includes(p.city.toLowerCase())) {
    bits.push(`in ${p.city}, right where you've been saving`);
  } else if ((prefs.areas || []).map((a) => String(a).toLowerCase()).includes((p.city || '').toLowerCase())) {
    bits.push(`in ${p.city}`);
  }
  if (p.price && prefs.price_min && prefs.price_max && p.price >= prefs.price_min && p.price <= prefs.price_max) {
    bits.push('right in your range');
  }
  if ((prefs.must_haves || []).some((m) => /acre|land|lot|privacy/i.test(m)) && p.lot_acres >= 1) {
    bits.push(`${p.lot_acres} acres of room`);
  }
  return bits.slice(0, 2).join(' · ');
}
