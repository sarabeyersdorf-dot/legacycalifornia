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
import { isConfigured as mlsConfigured, apiGet as mlsGet, shape as mlsShape, ids as mlsIds } from '../../_metrolist.js';

// The public site shows listing photos from the LIVE MetroList (RESO) feed —
// the one that actually carries Media. The CRM used to read only the
// `properties` table (a separate iHomefinder sync that may be unconfigured and
// empty), so deals rendered with no photo. Pull from the same MetroList feed
// the website uses, matched by address, and cache the office's active/pending
// listings module-scope for a few minutes so we don't re-hit RESO on every
// Deals-view open.
let _mlsCache = null, _mlsCacheAt = 0;
const MLS_TTL = 5 * 60 * 1000;

// MetroList's data agreement forbids exposing raw MLS photo URLs, and those
// hosts block direct <img> loading (CORS/referrer), so the site serves every
// MetroList photo through the same-origin /api/photo proxy. Mirror that here —
// a raw MediaURL stored on the card would just render as a broken image.
const PHOTO_HOSTS = /(^|\.)(metrolistmls\.com|flexmls\.com)$/i;
function proxyPhoto(u) {
  if (!u) return u;
  try {
    if (PHOTO_HOSTS.test(new URL(u).hostname)) return `/api/photo?url=${encodeURIComponent(u)}`;
  } catch (_) { /* not a URL — leave as-is */ }
  return u;
}

// Hard ceiling on how long the photo enrichment may take. Photos are optional;
// the deals list must ALWAYS return fast. If MetroList is slow/hangs we skip
// photos this round rather than let the whole /api/crm/listings call time out
// (which made deals appear to vanish on navigation).
const RESO_TIMEOUT = 2500;
const EMPTY_MAPS = { byMls: new Map(), byAddr: new Map(), count: 0, configured: false };

async function metrolistPhotoMaps(nowMs, mlsNumbers) {
  if (!mlsConfigured()) return EMPTY_MAPS;
  if (_mlsCache && (nowMs - _mlsCacheAt) < MLS_TTL) return _mlsCache;

  const byMls = new Map(), byAddr = new Map();
  let count = 0, timedOut = false;
  try {
    // Prefer an EXACT ListingId query for the deals we're showing — this pulls
    // each listing's photo straight by MLS number and doesn't depend on the
    // office/agent filter being right. Fall back to the office-wide feed
    // (matched later by address) when we have no MLS numbers.
    const mlsList = [...new Set((mlsNumbers || []).filter(Boolean).map(String))].slice(0, 60);
    let filter;
    if (mlsList.length) {
      filter = '(' + mlsList.map((m) => `ListingId eq '${m.replace(/'/g, "''")}'`).join(' or ') + ')';
    } else {
      const scope = mlsIds.office ? `ListOfficeMlsId eq '${mlsIds.office}'`
                  : mlsIds.agent  ? `ListAgentMlsId eq '${mlsIds.agent}'`
                  : null;
      filter = [`(MlsStatus eq 'Active' or MlsStatus eq 'Pending')`, scope].filter(Boolean).join(' and ');
    }
    // Race the RESO call against a timeout, and make the call itself
    // non-rejecting so a late failure can't surface as an unhandled rejection.
    const call = mlsGet('/Property', {
      '$filter':  filter,
      '$top':     100,
      '$orderby': 'ModificationTimestamp desc',
      '$expand':  'Media',
      '$select':  'ListingId,UnparsedAddress,City,MlsStatus'
    }).catch(() => ({ value: [] }));
    const timer = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve({ value: [] }); }, RESO_TIMEOUT));
    const data = await Promise.race([call, timer]);
    for (const p of (data.value || [])) {
      const s = mlsShape(p);
      const photo = proxyPhoto((s.photos && s.photos[0]) || null);   // through /api/photo
      if (!photo) continue;
      count++;
      if (s.id) byMls.set(String(s.id), photo);
      const na = normAddr(s.address);
      if (na && !byAddr.has(na)) byAddr.set(na, photo);
    }
  } catch (_) { /* fail-soft — photos are a nicety, never break the Deals list */ }

  const result = { byMls, byAddr, count, configured: true };
  // Only cache a real result. If we timed out (or got nothing), don't lock in
  // an empty map for the full TTL — let the next request try again.
  if (!timedOut && count > 0) { _mlsCache = result; _mlsCacheAt = nowMs; }
  return result;
}

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
    const BASE      = 'source_key, address, city, stage, side, agent, list_price, sale_price, coe_date, photo_url, video_url, matterport_url';
    const COLS_FULL = BASE + ', mls_number, listing_meta';
    const COLS_MLS  = BASE + ', mls_number';
    const COLS      = BASE;
    // Include buyer-side deals too — a purchase we represent is a live
    // transaction that needs a client portal, and Sara expects to see it under
    // the in-escrow list. It's tagged by `side` so the card can say Buying vs
    // Selling. (We exclude only non-transaction rows like prospects/leads,
    // which aren't a real side.)
    const SIDES = ['listing', 'seller', 'both', 'buyer'];
    const dealsQuery = (cols) => supa.from('deals').select(cols)
      .in('side', SIDES)
      .order('coe_date', { ascending: true, nullsFirst: false });

    // Photos come from two sources, in priority order:
    //   1. the LIVE MetroList feed (what the public site uses — has real Media)
    //   2. the `properties` table (iHomefinder sync; may be empty if unconfigured)
    // Both are keyed by MLS number and by normalized address so a deal with no
    // MLS still matches by street address.
    const propsPromise = supa.from('properties').select('mls_number, address, photos').in('status', ['active', 'pending']).limit(2000);

    // Prefer the full column set; degrade gracefully if listing_meta (019) or
    // mls_number (013) aren't in the table yet.
    let dealsRes = await dealsQuery(COLS_FULL);
    if (dealsRes.error) dealsRes = await dealsQuery(COLS_MLS);
    if (dealsRes.error) dealsRes = await dealsQuery(COLS);
    const { data, error } = dealsRes;
    if (error) return fail(res, 500, error.message);

    // Now that we have the deals, fetch their photos from MetroList BY exact MLS
    // number (falls back to the office feed if a deal has no MLS). Bounded by a
    // timeout so it can never delay the deals response.
    const dealMls = (data || []).map((d) => d.mls_number).filter(Boolean);
    const propsRes = await propsPromise;
    const mls      = await metrolistPhotoMaps(Date.now(), dealMls);

    // Lookup maps from the properties table → first photo.
    const byMls = new Map(), byAddr = new Map();
    for (const p of (propsRes.data || [])) {
      const photo = Array.isArray(p.photos) && p.photos.length ? p.photos[0] : null;
      if (!photo) continue;
      if (p.mls_number) byMls.set(String(p.mls_number), photo);
      const na = normAddr(p.address);
      if (na && !byAddr.has(na)) byAddr.set(na, photo);
    }
    // MetroList is the authoritative photo source — the public site uses it —
    // so let it win over any stale properties-table entry for the same key.
    for (const [k, v] of mls.byMls)  byMls.set(k, v);
    for (const [k, v] of mls.byAddr) byAddr.set(k, v);

    const idxPhotoFor = (d) => {
      if (d.mls_number && byMls.has(String(d.mls_number))) return byMls.get(String(d.mls_number));
      const na = normAddr(d.address);
      return na ? (byAddr.get(na) || null) : null;
    };

    let photosMatched = 0;
    const buckets = { active: [], pending: [], closed: [], preparing: [] };
    for (const d of (data || [])) {
      const photo = d.photo_url || idxPhotoFor(d);   // deals.json photo, else IDX/MetroList
      if (photo) photosMatched++;
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
        mls:        d.mls_number || null,
        meta:       d.listing_meta || null,   // client, apn, beds/baths, sqft, dates, disclosure, video
        photo_url:  photo,
        has_video:  !!d.video_url,
        has_tour:   !!d.matterport_url
      };
      if (d.stage === 'listing')        buckets.active.push(row);
      else if (d.stage === 'pending')   buckets.pending.push(row);
      else if (d.stage === 'closed')    buckets.closed.push(row);
      else if (d.stage === 'preparing') buckets.preparing.push(row);
    }

    return ok(res, {
      active:    buckets.active,
      pending:   buckets.pending,
      closed:    buckets.closed,
      preparing: buckets.preparing,
      counts:    { active: buckets.active.length, pending: buckets.pending.length, closed: buckets.closed.length, preparing: buckets.preparing.length },
      // Photo-sourcing diagnostics: how many deals got a photo, and where the
      // feeds stood. If metrolist_configured is false, the MetroList env vars
      // aren't set on this deployment; if metrolist_listings is 0, the office
      // filter returned nothing.
      photo_debug: {
        deals_total:          (data || []).length,
        photos_matched:       photosMatched,
        metrolist_configured: mls.configured,
        metrolist_listings:   mls.count,
        properties_rows:      (propsRes.data || []).length
      }
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
