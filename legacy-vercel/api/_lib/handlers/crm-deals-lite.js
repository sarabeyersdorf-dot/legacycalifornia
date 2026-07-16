// api/_lib/handlers/crm-deals-lite.js
// GET /api/crm/deals-lite
//
// A minimal, fast deals list for populating pickers (e.g. the Notes tab's
// "Tag a deal" dropdown). Unlike /api/crm/listings, this does NOT hit
// MetroList for photos or do any address matching — just the bare id/label
// fields, so it's safe to call on every page/tab load.
//
// Open deals (anything not 'closed') sort first, each side alphabetically by
// address; closed deals trail at the end. Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { profile } = await getCallerProfile(req, res);
  if (!isAgent(profile)) return fail(res, 401, 'agents only');

  try {
    const supa = adminClient();
    const { data, error } = await supa
      .from('deals')
      .select('id, source_key, address, city, stage, side, agent')
      .order('address', { ascending: true });
    if (error) return fail(res, 500, error.message);

    // `address` is inconsistent at the source (deals.json) — some rows are
    // just the street ("1111 Dunbar Rd"), others already have city/state
    // baked in ("0 Vacant Land, Angels Camp, CA 95222"). Only append `city`
    // to the label when the address doesn't already end with it, so the
    // dropdown never shows a city twice.
    const labelFor = (address, city) => {
      if (!city) return address || '';
      if (!address) return city;
      return address.toLowerCase().trim().endsWith(city.toLowerCase().trim())
        ? address
        : `${address}, ${city}`;
    };

    const deals = (data || [])
      .slice()
      .sort((a, b) => {
        const aClosed = a.stage === 'closed', bClosed = b.stage === 'closed';
        if (aClosed !== bClosed) return aClosed ? 1 : -1;
        return (a.address || '').localeCompare(b.address || '');
      })
      .map((d) => ({
        id:         d.id,
        source_key: d.source_key,
        address:    d.address,
        city:       d.city,
        stage:      d.stage,
        side:       d.side,
        agent:      d.agent,
        label:      labelFor(d.address, d.city)
      }));

    return ok(res, { deals });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
