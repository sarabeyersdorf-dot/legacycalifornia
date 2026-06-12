// api/listing.js
// ─────────────────────────────────────────────────────────────
// GET /api/listing?id=224018712
// Returns one listing by MLS ListingId, with full photo array
// and a richer remarks field.
// ─────────────────────────────────────────────────────────────

import { isConfigured, apiGet, shape, setCors } from './_metrolist.js';
import sampleListings from './_sample-listings.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  if (!isConfigured()) {
    const match = sampleListings.find(l => l.id === id || l.id === String(id));
    if (!match) return res.status(404).json({ error: 'Not found in sample data' });
    return res.status(200).json({ listing: match, source: 'sample' });
  }

  try {
    const data = await apiGet(`/Property('${encodeURIComponent(id)}')`, {
      '$expand': 'Media',
      '$select': [
        'ListingId','ListPrice','BedroomsTotal','BathroomsTotalInteger',
        'LivingArea','LotSizeAcres','UnparsedAddress','City',
        'StateOrProvince','PostalCode','MlsStatus','PropertyType',
        'YearBuilt','ListAgentMlsId','ListOfficeName','PublicRemarks',
        'ModificationTimestamp'
      ].join(','),
    });
    return res.status(200).json({ listing: shape(data), source: 'live' });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
