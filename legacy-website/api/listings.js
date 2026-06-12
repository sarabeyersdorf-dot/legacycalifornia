// api/listings.js
// ─────────────────────────────────────────────────────────────
// GET /api/listings
//   ?status=Active            (default: Active)
//   ?agent=02122175           (optional override; default = METROLIST_AGENT_ID)
//   ?office=                  (optional; pull office-wide listings)
//   ?city=Murphys             (optional filter)
//   ?minPrice=300000          (optional)
//   ?maxPrice=2000000         (optional)
//   ?top=24                   (default 24, max 100)
//
// Returns: { listings: [...], total, fetchedAt, source: 'live'|'sample' }
//
// If MetroList env is not configured (the case until Sara's API keys arrive),
// returns the bundled `sample-listings.json` so the front-end works in dev.
// ─────────────────────────────────────────────────────────────

import { isConfigured, apiGet, shape, ids, setCors } from './_metrolist.js';
import sampleListings from './_sample-listings.json' assert { type: 'json' };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  // ── Sample-data fallback (no creds yet) ─────────────────
  if (!isConfigured()) {
    return res.status(200).json({
      listings: sampleListings,
      total: sampleListings.length,
      fetchedAt: new Date().toISOString(),
      source: 'sample',
      note: 'MetroList credentials not configured — serving sample-listings.json. Set env vars in Vercel to go live.',
    });
  }

  // ── Build OData $filter ─────────────────────────────────
  const q = req.query;
  const filters = [];

  const status = q.status || 'Active';
  filters.push(`MlsStatus eq '${status}'`);

  const agent  = q.agent  || ids.agent;
  const office = q.office || ids.office;
  if (agent)  filters.push(`ListAgentMlsId eq '${agent}'`);
  if (office) filters.push(`ListOfficeMlsId eq '${office}'`);
  if (q.city)     filters.push(`City eq '${String(q.city).replace(/'/g, "''")}'`);
  if (q.minPrice) filters.push(`ListPrice ge ${Number(q.minPrice)}`);
  if (q.maxPrice) filters.push(`ListPrice le ${Number(q.maxPrice)}`);
  if (q.minBeds)  filters.push(`BedroomsTotal ge ${Number(q.minBeds)}`);

  const top = Math.min(Number(q.top) || 24, 100);

  try {
    const data = await apiGet('/Property', {
      '$filter':  filters.join(' and '),
      '$top':     top,
      '$orderby': 'ModificationTimestamp desc',
      // expand Media so we get photos in one round-trip
      '$expand':  'Media',
      // ask for only the fields we use to keep payload small
      '$select':  [
        'ListingId','ListPrice','BedroomsTotal','BathroomsTotalInteger',
        'LivingArea','LotSizeAcres','UnparsedAddress','City',
        'StateOrProvince','PostalCode','MlsStatus','PropertyType',
        'YearBuilt','ListAgentMlsId','ListOfficeName','ModificationTimestamp'
      ].join(','),
    });

    const listings = (data.value || []).map(p => shape(p));
    return res.status(200).json({
      listings,
      total: data['@odata.count'] ?? listings.length,
      fetchedAt: new Date().toISOString(),
      source: 'live',
    });
  } catch (err) {
    // Fall back to samples on error so the site doesn't go blank
    return res.status(200).json({
      listings: sampleListings,
      total: sampleListings.length,
      fetchedAt: new Date().toISOString(),
      source: 'sample',
      error: err.message,
      note: 'MetroList call failed — serving sample data. Check Vercel function logs.',
    });
  }
}
