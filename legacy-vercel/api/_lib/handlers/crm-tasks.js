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
  if (req.method === 'POST') return bulkSync(req, res);
  if (req.method === 'GET' && req.query?.op === 'sync') return autoSync(req, res);
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  if (req.method === 'GET')   return list(req, res, profile);
  if (req.method === 'PATCH') return toggle(req, res, profile);
  return fail(res, 405, 'method_not_allowed');
}

// POST /api/crm/tasks?key=<SYNC_SECRET> — bulk sync from the automated morning
// briefing. Insert-only, deduped by stable source_key ('brief:<item-id>'), so
// the same action tomorrow doesn't duplicate, and a task Sara checked off stays
// done (the briefing already excludes done=true items when composing the day).
// This makes agent_tasks the single task store: the HTML checklist and
// deals.json task arrays become views, not sources.
export async function bulkSync(req, res) {
  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (!secret || req.query?.key !== secret) return fail(res, 401, 'bad key');
  const supa = adminClient();
  const b = await readJson(req);
  const rows = Array.isArray(b?.tasks) ? b.tasks.slice(0, 60) : [];
  const clean = rows
    .filter((r) => r && typeof r.title === 'string' && r.title.trim() && typeof r.source_key === 'string' && r.source_key.trim())
    .map((r) => ({
      agent: ['sara', 'james', 'both'].includes(r.agent) ? r.agent : 'sara',
      client: (r.client || '').toString().slice(0, 120) || null,
      title: r.title.toString().slice(0, 200),
      sub: (r.sub || '').toString().slice(0, 120) || null,
      note: (r.note || '').toString().slice(0, 600) || null,
      due_label: (r.due_label || 'Today').toString().slice(0, 40),
      done: false,
      source_key: r.source_key.toString().slice(0, 120)
    }));
  if (!clean.length) return ok(res, { created: 0, skipped: rows.length });
  const keys = clean.map((r) => r.source_key);
  const { data: existing } = await supa.from('agent_tasks').select('source_key').in('source_key', keys);
  const have = new Set((existing || []).map((e) => e.source_key));
  const fresh = clean.filter((r) => !have.has(r.source_key));
  if (fresh.length) {
    const { error } = await supa.from('agent_tasks').insert(fresh);
    if (error) return fail(res, 500, error.message);
  }
  return ok(res, { created: fresh.length, already_present: have.size });
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


// GET /api/crm/tasks?op=sync&key=<SYNC_SECRET> — server-side daily task
// derivation for the morning briefing (whose environment can only follow
// fixed GET URLs). Insert-only with stable source_keys, same dedupe contract
// as bulkSync: a task Sara checked off stays checked, nothing duplicates.
export async function autoSync(req, res) {
  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (!secret || req.query?.key !== secret) return fail(res, 401, 'bad key');
  const supa = adminClient();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  // Items with a pending proposal already have evidence filed — the decision
  // nudge (block 3) covers them; an extra "Overdue" task would double-count.
  const { data: pendingProps } = await supa.from('deal_timeline_proposals')
    .select('item_id').eq('status', 'pending');
  const proposed = new Set((pendingProps || []).map((r) => r.item_id));

  // 1. Overdue timeline items (due, not done) → one task per item, ever.
  const { data: overdue } = await supa.from('deal_timeline_items')
    .select('id, title, due_date, status, deals(source_key, address, agent)')
    .lt('due_date', today).not('status', 'in', '("done","waived","na")').limit(40);
  for (const it of overdue || []) {
    if (!it.deals || proposed.has(it.id)) continue;
    rows.push({
      agent: /james/i.test(it.deals.agent || '') ? 'james' : 'sara',
      client: it.deals.address, title: 'Overdue: ' + it.title,
      sub: 'timeline item due ' + it.due_date, due_label: 'Overdue',
      done: false, source_key: 'auto:tl:' + it.id
    });
  }

  // 2. Deals closing inside 7 days → one closing-prep task per deal.
  const weekOut = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
  const { data: closing } = await supa.from('deals')
    .select('id, address, coe_date, agent').eq('stage', 'pending')
    .gte('coe_date', today).lte('coe_date', weekOut);
  for (const d of closing || []) {
    rows.push({
      agent: /james/i.test(d.agent || '') ? 'james' : 'sara',
      client: d.address, title: 'Closing prep — ' + d.address,
      sub: 'closes ' + d.coe_date, due_label: 'This week',
      done: false, source_key: 'auto:coe:' + d.id
    });
  }

  // 3. Timeline proposals pending more than 24h → nudge to decide.
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const { data: props } = await supa.from('deal_timeline_proposals')
    .select('id, address, item_key, created_at').eq('status', 'pending').lt('created_at', dayAgo).limit(20);
  for (const p2 of props || []) {
    rows.push({
      agent: 'sara', client: p2.address,
      title: 'Decide timeline proposal — ' + (p2.item_key || 'item'),
      sub: 'waiting since ' + String(p2.created_at).slice(0, 10), due_label: 'Today',
      done: false, source_key: 'auto:prop:' + p2.id
    });
  }

  // Self-healing sweep — auto tasks complete themselves when the underlying
  // condition resolves: item done/waived, proposal decided, deal closed.
  let autoCompleted = 0;
  const { data: openAuto } = await supa.from('agent_tasks')
    .select('id, source_key').eq('done', false).like('source_key', 'auto:%').limit(200);
  const wanted = new Set([...(rows.map((r) => r.source_key)), ...(overdue || []).filter((it) => proposed.has(it.id)).map((it) => 'auto:tl:' + it.id)]);
  for (const t of openAuto || []) {
    if (wanted.has(t.source_key)) continue;          // condition still current
    let resolved = false;
    if (t.source_key.startsWith('auto:tl:')) {
      const { data: it } = await supa.from('deal_timeline_items').select('status').eq('id', t.source_key.slice(8)).maybeSingle();
      resolved = !it || ['done', 'waived', 'na'].includes(it.status);
    } else if (t.source_key.startsWith('auto:prop:')) {
      const { data: p2 } = await supa.from('deal_timeline_proposals').select('status').eq('id', t.source_key.slice(10)).maybeSingle();
      resolved = !p2 || p2.status !== 'pending';
    } else if (t.source_key.startsWith('auto:coe:')) {
      const { data: d2 } = await supa.from('deals').select('stage').eq('id', t.source_key.slice(9)).maybeSingle();
      resolved = !d2 || d2.stage !== 'pending';
    }
    if (resolved) {
      await supa.from('agent_tasks').update({ done: true }).eq('id', t.id);
      autoCompleted++;
    }
  }

  const keys = rows.map((r) => r.source_key);
  const { data: existing } = keys.length
    ? await supa.from('agent_tasks').select('source_key').in('source_key', keys)
    : { data: [] };
  const have = new Set((existing || []).map((e) => e.source_key));
  const fresh = rows.filter((r) => !have.has(r.source_key));
  if (fresh.length) {
    const { error } = await supa.from('agent_tasks').insert(fresh);
    if (error) return fail(res, 500, error.message);
  }
  return ok(res, { created: fresh.length, considered: rows.length, auto_completed: autoCompleted,
    breakdown: { overdue: rows.filter((r) => r.source_key.startsWith('auto:tl:')).length,
                 closing: rows.filter((r) => r.source_key.startsWith('auto:coe:')).length,
                 proposals: rows.filter((r) => r.source_key.startsWith('auto:prop:')).length },
    titles: fresh.map((r) => r.title).slice(0, 20) });
}
