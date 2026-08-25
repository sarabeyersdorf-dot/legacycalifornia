// ─────────────────────────────────────────────────────────────
// MetroList RESO Web API client
// Shared helper used by /api/listings, /api/listing, /api/photo
// ─────────────────────────────────────────────────────────────
//
// Auth: OAuth2 client_credentials grant. Token cached in module scope
// so we don't hit the auth endpoint on every request.
// Vercel keeps the module warm between invocations on the same
// instance, so cache hits are likely under load.
//
// Standard RESO Data Dictionary fields we use:
//   ListingId, ListPrice, BedroomsTotal, BathroomsTotalInteger,
//   LivingArea, LotSizeAcres, UnparsedAddress, City, StateOrProvince,
//   PostalCode, MlsStatus, PropertyType, PublicRemarks, YearBuilt,
//   ListAgentMlsId, ListOfficeName, Media, ModificationTimestamp

const TOKEN_URL     = process.env.METROLIST_TOKEN_URL;
const API_BASE      = process.env.METROLIST_API_BASE;
const CLIENT_ID     = process.env.METROLIST_CLIENT_ID;
const CLIENT_SECRET = process.env.METROLIST_CLIENT_SECRET;
const AGENT_ID      = process.env.METROLIST_AGENT_ID;
const OFFICE_ID     = process.env.METROLIST_OFFICE_ID;

let _token       = null;
let _tokenExpiry = 0;

/** Returns true when env is configured enough to make live calls. */
export function isConfigured() {
  return Boolean(TOKEN_URL && API_BASE && CLIENT_ID && CLIENT_SECRET);
}

/** Fetch (or reuse) an OAuth access token. */
export async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExpiry - 30_000) return _token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'api',
  });

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`Token request failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  _token       = j.access_token;
  _tokenExpiry = now + (j.expires_in || 3600) * 1000;
  return _token;
}

/** Authenticated RESO Web API GET (OData). Path includes the leading slash. */
export async function apiGet(path, params = {}) {
  const token = await getToken();
  const url   = new URL(API_BASE.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`API ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Known IDs from env (so callers don't reach for env directly) */
export const ids = {
  agent:  AGENT_ID,
  office: OFFICE_ID,
};

// MLS statuses that mean "this home is back on the market" (so we must NOT
// cold-email the owner — it would be soliciting a listing another broker holds).
export const ON_MARKET_STATUSES = [
  'Active', 'Active Under Contract', 'Pending', 'Coming Soon', 'Contingent',
];

/**
 * Fetch currently-on-market listings across a set of cities. One query per
 * city keeps the round-trips small (an expired batch spans a handful of towns).
 * Returns { address, city, status } rows for on-market statuses only. A single
 * city's query failing never sinks the batch — it just yields fewer matches.
 */
export async function onMarketListingsForCities(cities) {
  if (!isConfigured() || !cities || !cities.length) return [];
  const statusFilter =
    '(' + ON_MARKET_STATUSES.map((s) => `MlsStatus eq '${s}'`).join(' or ') + ')';
  const out = [];
  for (const city of cities) {
    const cf = String(city).replace(/'/g, "''");
    try {
      const data = await apiGet('/Property', {
        '$filter': `${statusFilter} and City eq '${cf}'`,
        '$top': 200,
        '$select': 'ListingId,UnparsedAddress,StreetNumber,StreetName,StreetSuffix,City,MlsStatus',
      });
      for (const p of (data.value || [])) {
        const addr = p.UnparsedAddress
          || [p.StreetNumber, p.StreetName, p.StreetSuffix].filter(Boolean).join(' ');
        if (addr) out.push({ address: addr, city: p.City || city, status: p.MlsStatus });
      }
    } catch (_) { /* one city failing shouldn't sink the batch */ }
  }
  return out;
}

/** Allow-origin guard. Loose in dev; strict when ALLOWED_ORIGINS is set. */
export function setCors(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const ok      = allowed.length === 0 || allowed.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', ok ? origin || '*' : 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

// ─────────────────────────────────────────────────────────────
// Domain transforms — RESO field names → Legacy property shape.
// Keep this in ONE place so server and client agree on the schema.
// ─────────────────────────────────────────────────────────────

/** Format a price as $1,399,000 / $33K. */
export function fmtPrice(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

/** Map a single RESO Property record to our internal shape. */
export function shape(p, mediaByListing = {}) {
  const media = mediaByListing[p.ListingId] || p.Media || [];
  const photos = media
    .filter(m => m.MediaCategory === 'Photo' || m.MediaType === 'image/jpeg' || m.MediaURL)
    .map(m => m.MediaURL)
    .filter(Boolean);

  const addr = p.UnparsedAddress
    || [p.StreetNumber, p.StreetName, p.StreetSuffix].filter(Boolean).join(' ');

  return {
    id:        p.ListingId,
    price:     p.ListPrice,
    priceFmt:  fmtPrice(p.ListPrice),
    address:   addr,
    city:      p.City,
    state:     p.StateOrProvince,
    zip:       p.PostalCode,
    beds:      p.BedroomsTotal,
    baths:     p.BathroomsTotalInteger,
    sqft:      p.LivingArea,
    lotAcres:  p.LotSizeAcres,
    yearBuilt: p.YearBuilt,
    type:      p.PropertyType,
    status:    p.MlsStatus,
    remarks:   p.PublicRemarks,
    listAgent: p.ListAgentMlsId,
    listOffice:p.ListOfficeName,
    photos,
    photoCount: photos.length,
    modified:  p.ModificationTimestamp,
  };
}
