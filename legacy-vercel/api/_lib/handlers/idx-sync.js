// api/_lib/handlers/idx-sync.js
// GET /api/idx/sync
//
// Vercel cron (every 4 hours). Fetches Sara's listings from the iHomefinder
// Client API and upserts them into public.properties keyed by mls_number.
//
// iHomefinder Client API specifics:
//   - Auth:        HTTP Basic with the IDX Control Panel credentials.
//                  Set IHOMEFINDER_API_USER + IHOMEFINDER_API_PASS, or
//                  IHOMEFINDER_API_KEY (which we'll send as the username
//                  with a blank password — the legacy "API token" style).
//   - Base URL:    IHOMEFINDER_API_BASE (default https://www.ihomefinder.com/api)
//   - Listings:    IHOMEFINDER_LISTINGS_PATH (default /listings)
//   - Agent scope: IHOMEFINDER_AGENT_ID — passed as ?agentId= if set.
//
// Field mapping is tolerant: we look for a handful of common aliases so
// the same code adapts to whatever shape your iHomefinder feed returns.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';

const STATUS_MAP = {
  active:    'active',
  pending:   'pending',
  sold:      'sold',
  closed:    'sold',
  withdrawn: 'archived',
  expired:   'archived',
  off_market:'archived',
  contingent:'pending'
};

function authHeader() {
  const user = process.env.IHOMEFINDER_API_USER || process.env.IHOMEFINDER_API_KEY;
  const pass = process.env.IHOMEFINDER_API_PASS || '';
  if (!user) return null;
  const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${b64}`;
}

// Pull the first non-empty value from a list of dotted-path candidates.
function pick(obj, ...paths) {
  for (const p of paths) {
    const v = String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function normaliseListing(raw) {
  const mls = pick(raw, 'mls_number', 'mlsNumber', 'mlsId', 'mls', 'listingId', 'listing_id', 'id');
  if (!mls) return null;

  const statusRaw = String(pick(raw, 'status', 'listingStatus', 'mlsStatus', 'standardStatus') || 'active').toLowerCase();
  const status = STATUS_MAP[statusRaw.replace(/\s+/g, '_')] || 'active';

  const photos = (() => {
    const ph = pick(raw, 'photos', 'images', 'media', 'pictures');
    if (Array.isArray(ph)) {
      return ph.map((x) => typeof x === 'string' ? x : (x?.url || x?.href || x?.src)).filter(Boolean);
    }
    const single = pick(raw, 'photo', 'mainPhoto', 'primaryPhoto', 'photoUrl', 'imageUrl');
    return single ? [single] : [];
  })();

  return {
    mls_number:      String(mls),
    address:         pick(raw, 'address', 'streetAddress', 'fullAddress', 'unparsedAddress') || null,
    city:            pick(raw, 'city')      || null,
    state:           pick(raw, 'state', 'stateOrProvince') || 'CA',
    zip:             pick(raw, 'zip', 'postalCode', 'postal_code') || null,
    price:           pick(raw, 'price', 'listPrice', 'list_price') || null,
    bedrooms:        pick(raw, 'bedrooms', 'beds', 'bedroomsTotal') || null,
    bathrooms:       pick(raw, 'bathrooms', 'baths', 'bathroomsTotal') || null,
    sq_ft:           pick(raw, 'sq_ft', 'sqFt', 'livingArea', 'livingAreaSqFt') || null,
    lot_acres:       pick(raw, 'lot_acres', 'lotAcres', 'lotSizeAcres') || null,
    year_built:      pick(raw, 'year_built', 'yearBuilt') || null,
    property_type:   String(pick(raw, 'property_type', 'propertyType', 'propertyTypeLabel') || 'single_family')
                       .toLowerCase().replace(/[\s-]+/g, '_'),
    status,
    listed_by:       'sara',
    description:     pick(raw, 'description', 'remarks', 'publicRemarks') || null,
    features:        { idx: true, idx_raw_status: statusRaw },
    photos
  };
}

// Polls the iHomefinder API. The response may be either { listings: [...] }
// or a bare array; both shapes are accepted.
async function fetchListings() {
  const base = (process.env.IHOMEFINDER_API_BASE || 'https://www.ihomefinder.com/api').replace(/\/+$/, '');
  const path = process.env.IHOMEFINDER_LISTINGS_PATH || '/listings';
  const auth = authHeader();
  if (!auth) return { skipped: true, reason: 'IHOMEFINDER_API_KEY / IHOMEFINDER_API_USER not configured' };

  const url = new URL(`${base}${path}`);
  if (process.env.IHOMEFINDER_AGENT_ID)  url.searchParams.set('agentId',  process.env.IHOMEFINDER_AGENT_ID);
  if (process.env.IHOMEFINDER_OFFICE_ID) url.searchParams.set('officeId', process.env.IHOMEFINDER_OFFICE_ID);
  url.searchParams.set('limit', '200');
  url.searchParams.set('status', 'active,pending');

  const r = await fetch(url.toString(), {
    method:  'GET',
    headers: { 'Authorization': auth, 'Accept': 'application/json' }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`iHomefinder ${r.status}: ${text.slice(0, 300)}`);

  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`iHomefinder response is not JSON: ${text.slice(0, 200)}`); }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed.listings || parsed.results || parsed.data || parsed.items || []);
  return { listings: list };
}

async function upsertProperties(supa, normalised) {
  // Process in small batches to stay inside the 10-second function budget.
  const batchSize = 25;
  let inserted = 0;
  let updated  = 0;
  const errors = [];

  for (let i = 0; i < normalised.length; i += batchSize) {
    const batch = normalised.slice(i, i + batchSize);

    // Look up which mls_numbers already exist in this batch
    const mlsNos = batch.map((b) => b.mls_number);
    const { data: existing = [] } = await supa
      .from('properties').select('id, mls_number').in('mls_number', mlsNos);
    const existingByMls = new Map(existing.map((r) => [r.mls_number, r.id]));

    for (const row of batch) {
      try {
        const existingId = existingByMls.get(row.mls_number);
        if (existingId) {
          const { error } = await supa.from('properties')
            .update({ ...row, updated_at: new Date().toISOString() })
            .eq('id', existingId);
          if (error) throw error;
          updated++;
        } else {
          const { error } = await supa.from('properties').insert(row);
          if (error) throw error;
          inserted++;
        }
      } catch (e) {
        errors.push({ mls_number: row.mls_number, error: e.message });
      }
    }
  }
  return { inserted, updated, errors };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  // Optional cron secret
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const url    = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const qs     = url.searchParams.get('secret');
    const header = req.headers['authorization'] || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (qs !== expected && bearer !== expected) return fail(res, 401, 'cron secret invalid');
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    const feed = await fetchListings();
    if (feed.skipped) return ok(res, { skipped: true, reason: feed.reason });

    const normalised = (feed.listings || []).map(normaliseListing).filter(Boolean);
    if (!normalised.length) return ok(res, { fetched: 0, inserted: 0, updated: 0 });

    const supa = adminClient();
    const result = await upsertProperties(supa, normalised);

    return ok(res, {
      fetched:  feed.listings.length,
      mapped:   normalised.length,
      ...result,
      ran_at:   new Date().toISOString()
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
