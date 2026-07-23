// api/_lib/handlers/crm-deal-stage.js
// POST /api/crm/deal-stage
//
// Agent-only. Sets a per-deal stage_override (db/024, db/027) so the agent can
// flip an offer to "in escrow" (pending) the moment it's accepted — before
// Cowork moves the deal in deals.json — or soft-archive an offer that fell
// through. The override only takes effect while deals.json still has the deal
// at stage 'offer' (see crm-listings.js), so it self-heals once Cowork advances
// the deal; it never clobbers the deals.json source of truth.
//
// Body: { source_key: string, accepted?: boolean, fell_through?: boolean }
//   accepted:true      → stage_override = 'pending'  (offer accepted → escrow)
//   fell_through:true  → stage_override = 'dead'      (offer collapsed → archived)
//   accepted:false / fell_through:false / neither → stage_override = null (restore)

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sourceKey = String(body.source_key || '').trim();
    if (!sourceKey) return fail(res, 400, 'source_key required');
    // 'dead' (fell through) takes precedence, then 'pending' (accepted);
    // anything else clears the override (restore to the deals.json stage).
    const override = body.fell_through ? 'dead' : body.accepted ? 'pending' : null;

    const supa = adminClient();
    const { data, error } = await supa
      .from('deals')
      .update({ stage_override: override })
      .eq('source_key', sourceKey)
      .select('source_key, stage, stage_override');

    if (error) {
      // Constraint too narrow for 'dead' — db/027 not run yet.
      if (/deals_stage_override_check|check constraint/i.test(error.message || '')) {
        return fail(res, 409, 'stage_override constraint out of date — run db/027_deal_stage_override_dead.sql');
      }
      // Column not migrated yet (db/024). Report clearly rather than 500.
      if (/stage_override|schema cache|column/i.test(error.message || '')) {
        return fail(res, 409, 'stage_override column missing — run db/024_deal_stage_override.sql');
      }
      return fail(res, 500, error.message);
    }
    if (!data || !data.length) return fail(res, 404, `no deal with source_key ${sourceKey}`);

    return ok(res, {
      updated:  data.length,
      deal:     data[0],
      // Effective stage the Deals view will bucket by.
      effective_stage: (data[0].stage === 'offer' && data[0].stage_override) ? data[0].stage_override : data[0].stage
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
