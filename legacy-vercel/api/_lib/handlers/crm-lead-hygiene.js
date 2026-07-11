// api/_lib/handlers/crm-lead-hygiene.js
// GET  /api/crm/lead-hygiene                 → triage report on the active roster
// POST /api/crm/lead-hygiene { action:'archive', bucket, days? } → bulk-archive a bucket
//
// The pipeline count only means something if it's not 90% cold imports. This
// surfaces the noise in explicit buckets and lets the agent archive a bucket
// in one reviewed click. Archiving flips leads.status to 'archived' (allowed
// by the status CHECK); "Past clients" in the brief counts archived+closed
// only, so bulk-archived cold imports never masquerade as past clients.
// Agent-gated; broker sees the whole book, James sees his own.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const DEAL_STAGES = ['consult', 'signed', 'active', 'under_contract', 'closed', 'touring', 'offer', 'close'];
const isBroker = (p) => p?.role === 'agent_sara' || p?.role === 'admin';

function scope(q, profile) {
  if (!isBroker(profile)) q = q.eq('assigned_agent', profile.role === 'agent_james' ? 'james' : 'sara');
  return q;
}

// Dormant: active status, sitting in an early stage, no contact ever or none
// in `days`, and not created recently (so brand-new imports get a grace period).
function dormantFilter(supa, profile, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let q = supa.from('leads')
    .select('id, first_name, last_name, email, source, last_contact_at, created_at')
    .eq('status', 'active')
    .not('pipeline_stage', 'in', `(${DEAL_STAGES.join(',')})`)
    .or(`last_contact_at.is.null,last_contact_at.lt.${cutoff}`)
    .lt('created_at', cutoff);
  return scope(q, profile);
}

function noContactInfoFilter(supa, profile) {
  let q = supa.from('leads')
    .select('id, first_name, last_name, source, created_at')
    .eq('status', 'active')
    .is('email', null).is('phone', null);
  return scope(q, profile);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();
  try {
    if (req.method === 'GET') {
      const days = Math.max(30, Math.min(720, parseInt(req.query?.days, 10) || 180));
      const [{ count: total }, dormant, noInfo] = await Promise.all([
        scope(supa.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'active'), profile),
        dormantFilter(supa, profile, days).order('created_at', { ascending: true }).limit(1000),
        noContactInfoFilter(supa, profile).limit(1000)
      ]);
      const shape = (rows) => (rows.data || []).slice(0, 5).map((l) => ({
        id: l.id, name: [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)',
        source: l.source || null, last_contact_at: l.last_contact_at || null, created_at: l.created_at
      }));
      return ok(res, {
        total_active: total || 0,
        days,
        buckets: {
          dormant:        { count: (dormant.data || []).length, capped: (dormant.data || []).length === 1000, sample: shape(dormant) },
          no_contact_info:{ count: (noInfo.data  || []).length, capped: (noInfo.data  || []).length === 1000, sample: shape(noInfo) }
        }
      });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      if (b?.action !== 'archive') return fail(res, 400, "action must be 'archive'");
      const days = Math.max(30, Math.min(720, parseInt(b?.days, 10) || 180));
      const bucket = b?.bucket;
      if (!['dormant', 'no_contact_info'].includes(bucket)) return fail(res, 400, "bucket must be 'dormant' or 'no_contact_info'");

      // Collect ids first (bounded), then archive by id — no blind bulk UPDATE.
      const sel = bucket === 'dormant' ? dormantFilter(supa, profile, days) : noContactInfoFilter(supa, profile);
      const { data: rows, error: selErr } = await sel.limit(1000);
      if (selErr) return fail(res, 500, selErr.message);
      const ids = (rows || []).map((r) => r.id);
      if (!ids.length) return ok(res, { archived: 0 });

      const { error } = await supa.from('leads').update({ status: 'archived' }).in('id', ids);
      if (error) return fail(res, 500, error.message);
      return ok(res, { archived: ids.length, more: ids.length === 1000 });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
