// api/_lib/handlers/crm-listings.js
// GET /api/crm/listings
//
// The agent's own listings — the sell-side deals from deals.json (deals table,
// side in listing/seller/both), grouped for the CRM Listings view:
//   active  = on market      (stage 'listing')
//   pending = in escrow      (stage 'pending')
//   closed  = funded         (stage 'closed')
// Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

// Normalize a street address so a deal (deals.json) can be matched to an IDX
// property: drop the city after the first comma, lowercase, strip punctuation
// and common street-type / direction words, collapse whitespace.
function normAddr(a) {
  if (!a) return '';
  return String(a).toLowerCase().split(',')[0]
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|boulevard|blvd|way|highway|hwy|circle|cir|place|pl|terrace|ter|trail|trl|loop|east|west|north|south|e|w|n|s)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  try {
    const supa = adminClient();
    const [dealsRes, propsRes] = await Promise.all([
      supa.from('deals')
        .select('source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, photo_url, video_url, matterport_url')
        .in('side', ['listing', 'seller', 'both'])
        .order('coe_date', { ascending: true, nullsFirst: false }),
      // IDX listings (on-market) — used to backfill listing photos by address.
      supa.from('properties').select('mls_number, address, photos').in('status', ['active', 'pending']).limit(2000)
    ]);
    const { data, error } = dealsRes;
    if (error) return fail(res, 500, error.message);

    // Lookup maps from the IDX feed → first photo.
    const byMls = new Map(), byAddr = new Map();
    for (const p of (propsRes.data || [])) {
      const photo = Array.isArray(p.photos) && p.photos.length ? p.photos[0] : null;
      if (!photo) continue;
      if (p.mls_number) byMls.set(String(p.mls_number), photo);
      const na = normAddr(p.address);
      if (na && !byAddr.has(na)) byAddr.set(na, photo);
    }
    const idxPhotoFor = (d) => {
      if (d.mls_number && byMls.has(String(d.mls_number))) return byMls.get(String(d.mls_number));
      const na = normAddr(d.address);
      return na ? (byAddr.get(na) || null) : null;
    };

    const buckets = { active: [], pending: [], closed: [] };
    for (const d of (data || [])) {
      const row = {
        source_key: d.source_key,
        address:    d.address,
        city:       d.city,
        side:       d.side,
        agent:      d.agent,
        price:      d.sale_price || d.list_price || null,
        list_price: d.list_price,
        sale_price: d.sale_price,
        coe_date:   d.coe_date,
        photo_url:  d.photo_url || idxPhotoFor(d),   // deals.json photo, else IDX feed
        has_video:  !!d.video_url,
        has_tour:   !!d.matterport_url
      };
      if (d.stage === 'listing')      buckets.active.push(row);
      else if (d.stage === 'pending') buckets.pending.push(row);
      else if (d.stage === 'closed')  buckets.closed.push(row);
    }

    return ok(res, {
      active:  buckets.active,
      pending: buckets.pending,
      closed:  buckets.closed,
      counts:  { active: buckets.active.length, pending: buckets.pending.length, closed: buckets.closed.length }
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
