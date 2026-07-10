// api/_lib/handlers/curate-search.js
// GET  /api/curate/search   — run a MetroList-lite search over public.properties
//
// Agent-only. Filters map to the columns the IDX sync actually populates today
// (see the Phase-1 gap report). Any requested filter we can't honor with real
// data is echoed back in `gaps` — never silently ignored.
//
// runSearch() is exported so the post-sync "new match" cron can reuse the exact
// same query when it flags new listings for a saved search.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

// ---- label maps ------------------------------------------------------------
export const PTYPE_LABEL = {
  single_family: 'Single Family', condo: 'Condo/Townhouse', townhouse: 'Condo/Townhouse',
  manufactured: 'Manufactured', land: 'Land/Lots', ranch: 'Farm/Ranch',
  farm: 'Farm/Ranch', vineyard: 'Vineyard', multi_family: 'Multi-Family',
  commercial: 'Commercial'
};
export const STATUS_LABEL = {
  active: 'Active', pending: 'Pending', sold: 'Sold', off_market: 'Off market', archived: 'Archived'
};
// UI status value → the enum actually stored in properties.status
const STATUS_UI_MAP = { active: 'active', pending: 'pending', sold: 'sold', contingent: 'pending', coming_soon: null };

// Requested filters that have no real data yet → surfaced in `gaps`.
const UNSUPPORTED = {
  price_reduced:  'price reductions (needs price history from the feed)',
  county:         'county filter (no county field captured yet)',
  subdivision:    'subdivision / neighborhood (not in the feed)',
  school_district:'school district (not in the feed)',
  stories:        'stories (not in the feed)',
  garage_min:     'garage spaces (not in the feed)',
  pool:           'pool / spa (use a keyword like "pool" instead)',
  view:           'view flag (use a keyword like "view" instead)',
  waterfront:     'waterfront (use a keyword instead)',
  horse_property: 'horse property (use a keyword instead)',
  gated:          'gated community (not in the feed)',
  senior_55:      'senior 55+ (not in the feed)',
  hoa_max:        'HOA fee (feed does not populate it yet)',
  dom_max:        'days on market (no listing date stored yet)',
  radius_miles:   'map / radius search (no coordinates in the feed yet)',
  owner_financing:'owner financing (not in the feed)',
  new_construction:'new construction (not in the feed)'
};

const num = (v) => { const n = Number(v); return (v === '' || v == null || Number.isNaN(n)) ? null : n; };
const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : (v != null && v !== '' ? String(v) : '');

const fmtUSD = (n) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  const v = +n;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 1 : 2)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
};
const fmtUSDfull = (n) => (n == null || !Number.isFinite(+n)) ? '—' : '$' + Math.round(+n).toLocaleString('en-US');

// Shape a raw properties row into a display-ready listing card.
export function shapeListing(r) {
  const ppsf = (r.price && r.sq_ft) ? Math.round(r.price / r.sq_ft) : null;
  const photos = Array.isArray(r.photos) ? r.photos.filter(Boolean) : [];
  return {
    id: r.id,
    mls_number: r.mls_number || null,
    address: r.address || '',
    city: r.city || '',
    state: r.state || 'CA',
    zip: r.zip || '',
    price: r.price ?? null,
    price_label: fmtUSDfull(r.price),
    price_compact: fmtUSD(r.price),
    beds: r.bedrooms ?? null,
    baths: r.bathrooms ?? null,
    sqft: r.sq_ft ?? null,
    lot_acres: r.lot_acres ?? null,
    year_built: r.year_built ?? null,
    property_type: r.property_type || null,
    property_type_label: PTYPE_LABEL[r.property_type] || (r.property_type || '').replace(/_/g, ' ') || '—',
    status: r.status || null,
    status_label: STATUS_LABEL[r.status] || r.status || '',
    ppsf,
    ppsf_label: ppsf ? `$${ppsf}/sqft` : '',
    photo: photos[0] || null,
    photos
  };
}

// ---- the query builder (shared with the saved-search cron) -----------------
export async function runSearch(supa, f = {}, opts = {}) {
  const gaps = [];
  const SELECT = 'id, mls_number, address, city, state, zip, price, bedrooms, bathrooms, sq_ft, lot_acres, year_built, property_type, status, description, photos';
  let q = supa.from('properties').select(SELECT, { count: 'exact' });

  // status
  if (Array.isArray(f.status) && f.status.length) {
    if (f.status.includes('coming_soon')) gaps.push(UNSUPPORTED_STATUS_NOTE);
    const mapped = [...new Set(f.status.map((s) => (s in STATUS_UI_MAP ? STATUS_UI_MAP[s] : s)).filter(Boolean))];
    if (mapped.length) q = q.in('status', mapped);
  } else {
    q = q.in('status', ['active', 'pending']); // default: on-market only
  }

  if (num(f.price_min) != null) q = q.gte('price', num(f.price_min));
  if (num(f.price_max) != null) q = q.lte('price', num(f.price_max));

  if (Array.isArray(f.property_type) && f.property_type.length) q = q.in('property_type', f.property_type);

  if (num(f.beds_min)  != null) q = q.gte('bedrooms',  num(f.beds_min));
  if (num(f.baths_min) != null) q = q.gte('bathrooms', num(f.baths_min));

  if (num(f.sqft_min) != null) q = q.gte('sq_ft', num(f.sqft_min));
  if (num(f.sqft_max) != null) q = q.lte('sq_ft', num(f.sqft_max));

  // lot size: accept acres OR sqft (converted)
  let lotMin = num(f.lot_acres_min), lotMax = num(f.lot_acres_max);
  if (lotMin == null && num(f.lot_sqft_min) != null) lotMin = num(f.lot_sqft_min) / 43560;
  if (lotMax == null && num(f.lot_sqft_max) != null) lotMax = num(f.lot_sqft_max) / 43560;
  if (lotMin != null) q = q.gte('lot_acres', lotMin);
  if (lotMax != null) q = q.lte('lot_acres', lotMax);

  if (num(f.year_min) != null) q = q.gte('year_built', num(f.year_min));
  if (num(f.year_max) != null) q = q.lte('year_built', num(f.year_max));

  if (str(f.city)) q = q.ilike('city', `%${str(f.city)}%`);
  if (str(f.zip))  q = q.eq('zip', str(f.zip));

  if (str(f.keyword)) {
    const kw = str(f.keyword).replace(/[%(),]/g, ' ').trim();
    if (kw) q = q.or(`description.ilike.%${kw}%,address.ilike.%${kw}%,city.ilike.%${kw}%`);
  }

  // record any requested-but-unsupported filters
  for (const [k, label] of Object.entries(UNSUPPORTED)) {
    const v = f[k];
    if (v != null && v !== '' && v !== false) gaps.push(label);
  }

  const SORTS = {
    price_asc:  ['price', { ascending: true }],
    price_desc: ['price', { ascending: false }],
    newest:     ['created_at', { ascending: false }],
    beds_desc:  ['bedrooms', { ascending: false }]
  };
  const [col, ord] = SORTS[f.sort] || SORTS.newest;
  q = q.order(col, ord).order('id', { ascending: true });

  const limit  = Math.min(Math.max(parseInt(opts.limit ?? f.limit ?? 60, 10) || 60, 1), 200);
  const offset = Math.max(parseInt(opts.offset ?? f.offset ?? 0, 10) || 0, 0);
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw new Error(error.message);

  let rows = data || [];
  const ppsfMax = num(f.ppsf_max);
  if (ppsfMax != null) rows = rows.filter((r) => (r.price && r.sq_ft) ? (r.price / r.sq_ft) <= ppsfMax : true);

  return { listings: rows.map(shapeListing), count: count ?? rows.length, limit, offset, gaps: [...new Set(gaps)] };
}
const UNSUPPORTED_STATUS_NOTE = 'coming_soon status not captured by the feed';

// Parse filters from either a querystring (GET) or a JSON body.
function filtersFromQuery(qy) {
  const arr = (v) => v == null ? undefined : (Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean));
  // Pass the raw query through so requested-but-unsupported filters (pool,
  // county, radius, …) still surface in `gaps` instead of vanishing silently;
  // then normalize the multi-value fields.
  return { ...qy, status: arr(qy.status), property_type: arr(qy.property_type) };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const supa = adminClient();
    const result = await runSearch(supa, filtersFromQuery(req.query || {}), {});

    // Curated search reads public.properties, populated by the iHomefinder IDX
    // sync (api/_lib/handlers/idx-sync.js). If nothing comes back, report the
    // table's total so an empty grid isn't silent — 0 means the sync hasn't run
    // / isn't populating; >0 means the filters just excluded everything.
    if (!result.listings.length) {
      const { count } = await supa.from('properties').select('id', { count: 'exact', head: true });
      result.properties_total = count ?? 0;
      if (!count) result.notice = 'No IDX listings in the properties table yet — the iHomefinder sync hasn’t populated it. Run the IDX sync (or check the IHOMEFINDER_* config).';
    }

    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
