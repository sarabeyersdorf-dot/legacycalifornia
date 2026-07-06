// api/_lib/handlers/crm-tasks.js
// GET  /api/crm/tasks[?scope=all|james|sara]  → the caller's task/compliance list
// PATCH /api/crm/tasks  { id, done }            → check a task off (or re-open)
//
// Fed by the daily briefing (deals.json "tasks" → agent_tasks). Scoped:
//   - James: sees tasks for 'james' or 'both'
//   - Broker-owner (Sara / admin): sees everything; ?scope filters by agent
// Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const agentKey  = (role) => (role === 'agent_james' ? 'james' : 'sara');
const isBroker  = (p) => p?.role === 'agent_sara' || p?.role === 'admin';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  if (req.method === 'GET')   return list(req, res, profile);
  if (req.method === 'PATCH') return toggle(req, res, profile);
  return fail(res, 405, 'method_not_allowed');
}

async function list(req, res, profile) {
  try {
    const supa = adminClient();
    const scoped = (cols) => {
      let q = supa.from('agent_tasks').select(cols)
        .order('done', { ascending: true })
        .order('created_at', { ascending: true });
      if (isBroker(profile)) {
        const scope = req.query?.scope;
        if (scope === 'james')      q = q.in('agent', ['james', 'both']);
        else if (scope === 'sara')  q = q.in('agent', ['sara', 'both']);
        // else: all
      } else {
        q = q.in('agent', [agentKey(profile.role), 'both']);
      }
      return q;
    };
    // Prefer the feedback columns; fall back if migration 017 hasn't run yet.
    const COLS_FB   = 'id, agent, client, title, sub, note, due_label, done, source_key, created_at, agent_note, attention, agent_note_by, agent_note_at';
    const COLS_BASE = 'id, agent, client, title, sub, note, due_label, done, source_key, created_at';
    let { data, error } = await scoped(COLS_FB);
    if (error) ({ data, error } = await scoped(COLS_BASE));
    if (error) return fail(res, 500, error.message);
    const tasks = data || [];
    return ok(res, {
      tasks,
      open:   tasks.filter((t) => !t.done).length,
      done:   tasks.filter((t) => t.done).length,
      broker: isBroker(profile)
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function toggle(req, res, profile) {
  try {
    const supa = adminClient();
    const body = await readJson(req);
    const id = body?.id;
    if (!id) return fail(res, 400, 'id required');

    const { data: t, error: gErr } = await supa.from('agent_tasks').select('agent').eq('id', id).maybeSingle();
    if (gErr) return fail(res, 500, gErr.message);
    if (!t)   return fail(res, 404, 'task not found');
    if (!isBroker(profile) && ![agentKey(profile.role), 'both'].includes(t.agent)) {
      return fail(res, 403, 'not your task');
    }

    // A PATCH may toggle done, and/or set the agent's note-back-to-briefing and
    // the attention flag. Note/attention are stamped with who + when.
    const patch = {};
    if (body.done      !== undefined) patch.done = !!body.done;
    if (body.agent_note !== undefined) {
      patch.agent_note    = String(body.agent_note || '').slice(0, 1000) || null;
      patch.agent_note_by = agentKey(profile.role);
      patch.agent_note_at = new Date().toISOString();
    }
    if (body.attention !== undefined) {
      patch.attention     = !!body.attention;
      patch.agent_note_by = agentKey(profile.role);
      patch.agent_note_at = new Date().toISOString();
    }
    if (!Object.keys(patch).length) return fail(res, 400, 'nothing to update');

    const { error } = await supa.from('agent_tasks').update(patch).eq('id', id);
    if (error) return fail(res, 500, error.message);
    return ok(res, { id, ...patch });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
