// api/_lib/handlers/crm-broker.js
// /api/crm/broker   (BROKER-ONLY — role agent_sara or admin)
//
//   GET                         → oversight snapshot: each agent's leads by
//                                 stage, hot count, active deals, last activity;
//                                 plus recent leads for reassignment.
//   POST { op:'reassign', lead_id, to_agent }   → move a lead to the other agent
//   POST { op:'provision-agent', agent_key, email, password?, display_name? }
//                               → create (or password-reset) an agent's login and
//                                 set their role. Ends the manual Supabase step.
//
// Broker supervision is a DRE compliance need: the broker-owner (Sara) sees and
// controls every agent's leads. James (agent) does not get this endpoint.

import { adminClient } from '../supabase.js';
import { getCallerProfile } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const AGENTS = ['sara', 'james'];
const NAME = { sara: 'Sara Cooper', james: 'James Beyersdorf' };
const isBroker = (p) => !!p && (p.role === 'agent_sara' || p.role === 'admin');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)            return fail(res, 401, 'not authenticated');
  if (!isBroker(profile)) return fail(res, 403, 'broker access only');

  const supa = adminClient();
  try {
    if (req.method === 'GET')  return overview(supa, res);
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (b?.op === 'reassign')        return reassign(supa, b, res);
      if (b?.op === 'provision-agent') return provisionAgent(supa, b, res);
      return fail(res, 400, `unknown op: ${b?.op}`);
    }
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function overview(supa, res) {
  const { data: leads } = await supa
    .from('leads')
    .select('id, first_name, last_name, email, assigned_agent, pipeline_stage, temperature, status, updated_at, last_contact_at')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  const { data: deals } = await supa
    .from('deals').select('id, agent, stage').in('stage', ['pending', 'listing']);

  const agents = {};
  for (const k of AGENTS) agents[k] = { agent_key: k, name: NAME[k], leads_total: 0, by_stage: {}, hot: 0, active_deals: 0, last_activity: null };

  for (const l of (leads || [])) {
    const a = agents[l.assigned_agent];
    if (!a) continue;
    a.leads_total++;
    a.by_stage[l.pipeline_stage] = (a.by_stage[l.pipeline_stage] || 0) + 1;
    if (l.temperature === 'hot') a.hot++;
    const t = l.last_contact_at || l.updated_at;
    if (t && (!a.last_activity || t > a.last_activity)) a.last_activity = t;
  }
  for (const d of (deals || [])) { if (agents[d.agent]) agents[d.agent].active_deals++; }

  const recent = (leads || []).slice(0, 50).map((l) => ({
    id: l.id,
    name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || '—',
    assigned_agent: l.assigned_agent,
    pipeline_stage: l.pipeline_stage,
    temperature: l.temperature
  }));

  return ok(res, {
    agents: AGENTS.map((k) => agents[k]),
    recent,
    totals: { leads: (leads || []).length, active_deals: (deals || []).length }
  });
}

async function reassign(supa, b, res) {
  if (!b.lead_id || !AGENTS.includes(b.to_agent)) return fail(res, 400, 'lead_id and a valid to_agent required');
  const { error } = await supa.from('leads').update({ assigned_agent: b.to_agent }).eq('id', b.lead_id);
  if (error) return fail(res, 500, error.message);
  return ok(res, { reassigned: true, lead_id: b.lead_id, to_agent: b.to_agent });
}

// Create an agent's sign-in (or reset their password) and set their role.
async function provisionAgent(supa, b, res) {
  const agent_key = b.agent_key === 'james' ? 'james' : (b.agent_key === 'sara' ? 'sara' : null);
  if (!agent_key) return fail(res, 400, "agent_key must be 'sara' or 'james'");
  const email = (b.email || '').toString().trim().toLowerCase();
  const password = (b.password || '').toString();
  if (!email) return fail(res, 400, 'email required');
  if (password && password.length < 8) return fail(res, 400, 'password must be at least 8 characters');

  const role = agent_key === 'james' ? 'agent_james' : 'agent_sara';

  // Create the auth user, or find + optionally reset if they already exist.
  let userId = null, action = 'created';
  const { data: created } = await supa.auth.admin.createUser({ email, password: password || undefined, email_confirm: true });
  if (created?.user) {
    userId = created.user.id;
  } else {
    const { data: list } = await supa.auth.admin.listUsers();
    const existing = (list?.users || []).find((u) => (u.email || '').toLowerCase() === email);
    if (!existing) return fail(res, 500, 'could not create or locate that user');
    userId = existing.id; action = 'updated';
    if (password) await supa.auth.admin.updateUserById(userId, { password });
  }

  // Set their app role (the users row is auto-created as 'buyer' by trigger).
  const { error: upErr } = await supa.from('users')
    .upsert({ id: userId, role, display_name: b.display_name || NAME[agent_key] }, { onConflict: 'id' });
  if (upErr) return fail(res, 500, `role set: ${upErr.message}`);

  return ok(res, { provisioned: true, action, email, role, password_set: !!password });
}
