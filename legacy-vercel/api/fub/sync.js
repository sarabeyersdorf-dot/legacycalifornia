// api/fub/sync.js
// Phase 1 ONLY: keep Follow Up Boss in sync with the Supabase leads table.
// Delete this file in January when Sara's FUB contract ends.
//
// Usage:
//   - Direct HTTP: POST /api/fub/sync  body: { lead_id }
//   - From other server code: `import { syncLeadToFUB } from './fub/sync.js'`
//
// FUB REST API docs: https://docs.followupboss.com/

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';

const FUB_API_KEY = process.env.FUB_API_KEY;
const FUB_BASE    = 'https://api.followupboss.com/v1';

function fubConfigured() { return !!FUB_API_KEY; }

function fubHeaders() {
  const auth = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  return {
    'Authorization': `Basic ${auth}`,
    'Content-Type':  'application/json',
    'X-System':      'LegacyProperties',
    'X-System-Key':  'legacy-platform'
  };
}

const FUB_STAGE_MAP = {
  new:     'Lead',
  nurture: 'Nurture',
  touring: 'Hot Prospect',
  offer:   'Active Client',
  close:   'Closed'
};

function leadToFUBContact(lead) {
  return {
    firstName: lead.first_name || '',
    lastName:  lead.last_name  || '',
    emails:    lead.email ? [{ value: lead.email, type: 'home' }] : [],
    phones:    lead.phone ? [{ value: lead.phone, type: 'mobile' }] : [],
    source:    lead.source || 'website_form',
    stage:     FUB_STAGE_MAP[lead.pipeline_stage] || 'Lead',
    assignedUserId: null, // map in production once Sara's FUB user id is known
    customScore: lead.score,
    tags: [
      lead.lead_type        ? `type:${lead.lead_type}`            : null,
      lead.journey_stage    ? `journey:${lead.journey_stage}`     : null,
      lead.temperature      ? `temp:${lead.temperature}`          : null
    ].filter(Boolean)
  };
}

/**
 * Server-side helper. Returns { fub_id } or { skipped: true }.
 */
export async function syncLeadToFUB(lead) {
  if (!fubConfigured()) return { skipped: true, reason: 'FUB_API_KEY not set' };

  const payload = leadToFUBContact(lead);

  // Update if we already have an fub_id, otherwise create.
  let res, json;
  if (lead.fub_id) {
    res = await fetch(`${FUB_BASE}/people/${lead.fub_id}`, {
      method: 'PUT', headers: fubHeaders(), body: JSON.stringify(payload)
    });
  } else {
    res = await fetch(`${FUB_BASE}/people`, {
      method: 'POST', headers: fubHeaders(), body: JSON.stringify(payload)
    });
  }
  json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`FUB sync ${res.status}: ${JSON.stringify(json)}`);
  }

  const fub_id = String(json.id || lead.fub_id || '');
  if (fub_id && fub_id !== lead.fub_id) {
    await adminClient().from('leads').update({ fub_id }).eq('id', lead.id);
  }
  return { fub_id };
}

// HTTP entrypoint — used for manual re-sync from CRM or webhooks.
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { lead_id } = await readJson(req);
    if (!lead_id) return fail(res, 400, 'lead_id required');

    const { data: lead, error } = await adminClient()
      .from('leads').select('*').eq('id', lead_id).single();
    if (error || !lead) return fail(res, 404, 'lead not found');

    const result = await syncLeadToFUB(lead);
    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
