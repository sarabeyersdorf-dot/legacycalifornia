// api/_lib/handlers/crm-briefing-feedback.js
// GET /api/crm/briefing-feedback?key=<SYNC_SECRET>
//
// The read-back channel for the daily briefing (Cowork). Returns every briefing
// task with what the agents did to it: done state, the note they wrote back,
// and whether they flagged it for attention. Cowork fetches this at the start
// of its run and tunes the next agenda in deals.json.
//
// Key-protected (not agent-session auth) so Cowork can pull it headlessly.
// Reuses SYNC_SECRET; if no secret is configured the endpoint is open.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';
import { checkSyncKey } from '../sync-key.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  // This feeds a morning-briefing agent and must ALWAYS reflect live data —
  // never let Vercel's edge/CDN (or any intermediary) serve a stale payload.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  if (!checkSyncKey(req.query?.key).ok) return fail(res, 401, 'bad key');

  // Drop the DONE rows by default so the payload can't outgrow the consumer's
  // fetch limit. The whole file was serialising all ~240 tasks (most of them
  // done), which pushed the response past ~94K and truncated it mid-JSON —
  // silently dropping rejected_proposals off the end. `?all=1` restores the full
  // set for anyone who needs the history.
  const openOnly = !/^(1|true|yes)$/i.test(String(req.query?.all || ''));

  try {
    const supa = adminClient();
    const COLS = 'agent, client, title, sub, due_label, done, agent_note, attention, agent_note_by, agent_note_at, source_key, brief_key, created_at';
    const baseQ = () => {
      let q = supa.from('agent_tasks').select(COLS).eq('source', 'briefing');
      if (openOnly) q = q.eq('done', false);
      return q.order('created_at', { ascending: true });
    };
    let { data, error } = await baseQ();
    // Fall back gracefully if brief_key / feedback columns aren't migrated yet.
    if (error) {
      let q = supa.from('agent_tasks')
        .select('agent, client, title, sub, due_label, done, source_key, created_at')
        .eq('source', 'briefing');
      if (openOnly) q = q.eq('done', false);
      ({ data, error } = await q.order('created_at', { ascending: true }));
    }
    if (error) return fail(res, 500, error.message);

    const tasks = (data || []).map((t) => ({
      agent:      t.agent,
      client:     t.client || null,
      title:      t.title,
      done:       !!t.done,
      needs_attention: !!t.attention,
      agent_note: t.agent_note || null,
      note_by:    t.agent_note_by || null,
      note_at:    t.agent_note_at || null,
      deal:       t.source_key || null,
      // Stable per-task dedup key (populated by sync-deals). Dedup on THIS, not
      // on `deal` (which is null for deal-less tasks) or `title` (which carries a
      // volatile countdown). Survives rewording and day-to-day countdown changes.
      key:        t.brief_key || null
    }));

    // Seller-portal feedback (db/040): the note the agent wrote for the briefing
    // and the client-tasks they ticked complete on the portal, per deal. Cowork
    // acts on these — reword/answer the note, and drop the completed tasks from
    // deals.json clientTasks. Fail-soft if migration 040 hasn't run.
    let deal_portal_notes = [];
    try {
      const { data: dRows, error: dErr } = await supa.from('deals')
        .select('source_key, agent, address, portal_seller_note, client_task_done')
        .or('portal_seller_note.not.is.null,client_task_done.not.is.null');
      if (!dErr && Array.isArray(dRows)) {
        deal_portal_notes = dRows
          .map((d) => {
            const note = d.portal_seller_note && typeof d.portal_seller_note === 'object' ? d.portal_seller_note : null;
            const completed = Array.isArray(d.client_task_done) ? d.client_task_done : [];
            if (!note && !completed.length) return null;
            return {
              deal: d.source_key, agent: d.agent || null, address: d.address || null,
              note: note ? (note.body || null) : null,
              note_by: note ? (note.by || null) : null,
              note_at: note ? (note.updated_at || null) : null,
              completed_tasks: completed
            };
          })
          .filter(Boolean);
      }
    } catch (_) { /* migration 040 not run yet */ }

    // Unread agent_updates (db/034): the free-text "notes to Claude" Sara & James
    // log from the CRM (a text they got, a verbal update, anything the briefing has
    // no other visibility into). These have their OWN read-back (?op=feed) that
    // marks them read as it reads them — but that URL has to be called explicitly,
    // and Cowork only ever calls THIS endpoint. So since 2026-07-31 nothing
    // consumed them and they piled up unread (695 Feather's HELOC update, Eva
    // Mifsud "not a lead", 1789 Love Creek "wants to list in Sept" — all lost for
    // weeks). Fold the unread ones in here — the pull Cowork already makes every
    // run — and mark them read in the same call, exactly like ?op=feed does.
    // Crucially this is NOT deal-scoped, so a note with deal:null (which
    // deal_portal_notes can never surface) finally reaches the briefing. This
    // endpoint is key-gated and only Cowork calls it, so the read-flip only fires
    // on a real briefing pull; nothing is deleted, so notes stay in the CRM log.
    let agent_updates = [];
    try {
      const { data: uRows } = await supa.from('agent_updates')
        .select('id, agent, deal, content, created_at, ' +
          'tagged_deal:deals(source_key, address), tagged_lead:leads(first_name, last_name, email)')
        .eq('read_by_briefing', false)
        .order('created_at', { ascending: true })
        .limit(100);
      if (Array.isArray(uRows) && uRows.length) {
        agent_updates = uRows.map((u) => ({
          id:      u.id,
          agent:   u.agent,
          deal:    (u.tagged_deal && u.tagged_deal.source_key) || u.deal || null,
          address: (u.tagged_deal && u.tagged_deal.address) || null,
          lead:    u.tagged_lead
                     ? ([u.tagged_lead.first_name, u.tagged_lead.last_name].filter(Boolean).join(' ') || u.tagged_lead.email || null)
                     : null,
          content: u.content,
          at:      u.created_at
        }));
        const ids = uRows.map((u) => u.id);
        // Mark read server-side — Cowork's environment can't UPDATE, so it can't
        // do this itself; without it the same notes re-report every morning.
        await supa.from('agent_updates')
          .update({ read_by_briefing: true, read_by_briefing_at: new Date().toISOString() })
          .in('id', ids)
          .then(() => {}, () => {});
      }
    } catch (_) { /* agent_updates absent — never break the feedback pull over it */ }

    // Rejected timeline proposals (db/048): when the agent rejects a proposed
    // update, that's Cowork's cue it got a contract/scan wrong. Return the recent
    // rejections with the agent's correction note so Cowork fixes it (e.g. sets
    // the deal's timeline.remaining/removed, or re-reads the doc). Fail-soft.
    let rejected_proposals = [];
    try {
      const since = new Date(Date.now() - 21 * 86400000).toISOString();
      const { data: pRows, error: pErr } = await supa.from('deal_timeline_proposals')
        .select('item_key, address, change, reason, decision_note, decided_by, decided_at')
        .eq('status', 'rejected').gte('decided_at', since)
        .order('decided_at', { ascending: false }).limit(50);
      if (!pErr && Array.isArray(pRows)) {
        rejected_proposals = pRows.map((p) => ({
          item_key:     p.item_key || null,
          address:      p.address || null,
          proposed:     p.change || null,            // what Cowork/cron had proposed
          reason:       p.reason || null,            // its original evidence sentence
          agent_note:   p.decision_note || null,     // the agent's correction
          rejected_by:  p.decided_by || null,
          rejected_at:  p.decided_at || null
        }));
      }
    } catch (_) { /* db/048 not run yet */ }

    // Data-freshness signal (Bug 3 / SPEC Rule 3). The endpoint itself always
    // regenerates (no-store above), but its CONTENT is only as fresh as the last
    // sync that wrote the briefing tasks — if sync is broken the tasks silently
    // age (on 8/7 this served a briefing whose newest row was ~15h old while
    // presenting as live). Surface the age of the underlying data so the
    // consumer can say so out loud instead of trusting it blindly.
    const stamps = [];
    for (const t of (data || [])) { if (t.created_at) stamps.push(t.created_at); if (t.agent_note_at) stamps.push(t.agent_note_at); }
    for (const p of rejected_proposals) { if (p.rejected_at) stamps.push(p.rejected_at); }
    const dataGeneratedAt = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
    const cacheAgeSeconds = dataGeneratedAt ? Math.max(0, Math.floor((Date.now() - new Date(dataGeneratedAt).getTime()) / 1000)) : null;
    // stale reflects how long since the NEWEST task/note/rejection stamp — not
    // sync health. A quiet stretch (no agent activity for an hour, e.g. overnight)
    // is normal, so a 1h threshold false-positived on every healthy run (Cowork
    // saw cache_age ~3695s flagged stale). Raised to 1.5h, matching reconcile's
    // sync_stale, so only a genuinely idle-too-long feed trips it.
    const stale = cacheAgeSeconds != null && cacheAgeSeconds > 5400;

    // Counts over the FULL set, independent of the ?open filter (so `done`/`total`
    // stay meaningful even though `tasks` below is open-only by default). Cheap
    // head-only counts; falls back to the returned-rows tally if the feedback
    // columns aren't migrated.
    let counts = {
      total: tasks.length, done: 0, open: tasks.length,
      with_notes: tasks.filter((t) => t.agent_note).length,
      attention: tasks.filter((t) => t.needs_attention).length,
      rejected_proposals: rejected_proposals.length
    };
    try {
      const [tot, dn, wn, att] = await Promise.all([
        supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source', 'briefing'),
        supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source', 'briefing').eq('done', true),
        supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source', 'briefing').not('agent_note', 'is', null),
        supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source', 'briefing').eq('attention', true)
      ]);
      const total = tot.count || 0;
      counts = {
        total, done: dn.count || 0, open: total - (dn.count || 0),
        with_notes: wn.count || 0, attention: att.count || 0,
        rejected_proposals: rejected_proposals.length
      };
    } catch (_) { /* pre-feedback-cols schema — keep the returned-rows tally */ }

    // Field order matters: counts, rejected_proposals and needs_review come
    // BEFORE the large `tasks` array so that if the payload is ever truncated by
    // a downstream fetch cap, the small high-value fields survive (the old order
    // put rejected_proposals last, so truncation silently dropped it).
    return ok(res, {
      generated_at: new Date().toISOString(),
      data_generated_at: dataGeneratedAt,
      cache_age_seconds: cacheAgeSeconds,
      stale,
      open_only: openOnly,   // done rows omitted unless ?all=1
      counts: { ...counts, agent_updates: agent_updates.length },
      rejected_proposals,
      // Unread free-text notes from Sara/James, now marked read as of this pull.
      // High-value and small — placed before the big `tasks` array so a downstream
      // fetch cap can never truncate it off the end.
      agent_updates,
      // The list Cowork should act on first: flagged or annotated.
      needs_review: tasks.filter((t) => t.needs_attention || t.agent_note),
      deal_portal_notes,
      tasks
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
