-- 060_agent_tasks_dedup.sql
-- Bug 10 — agent_tasks accumulated duplicates because nothing at the DB level
-- enforced idempotency; the sync code pre-filtered by hand, so a race or a
-- second writer (the briefing bulk-sync pool vs. the deals.json pool) could land
-- the same task twice with no way to detect it.
--
-- Note on the report's framing: it suggested moving deals.json tasks[].key into
-- `source_key`. In this schema `source_key` already carries the DEAL id (the
-- deal console links tasks to a deal through it), and the unique per-task key
-- already lives in `brief_key`. So the right guard is uniqueness on the keys as
-- they are actually used — not a repurpose that would break deal linkage.
--
-- Two partial unique indexes make both writer pools idempotent:
--   * (source, source_key) for the keyed pools (bulkSync 'brief:*', 'auto:*',
--     'checklist:*') — matches the pre-filter the sync already relies on.
--   * (source, brief_key)  for the deals.json briefing pool's per-task key.
-- Existing duplicates are collapsed (keep the most recently touched, preferring
-- a done row so a check-off is never lost) before the indexes are built.

begin;

-- ── Collapse duplicate keyed rows (keep newest; prefer done) ────────────────
delete from public.agent_tasks a
 using (
   select id,
          row_number() over (
            partition by source, source_key
            order by done desc, coalesce(agent_note_at, created_at) desc nulls last, id desc
          ) as rn
   from public.agent_tasks
   where source_key is not null
 ) r
 where a.id = r.id and r.rn > 1;

create unique index if not exists agent_tasks_source_sourcekey_uniq
  on public.agent_tasks (source, source_key)
  where source_key is not null;

-- ── Same for the briefing pool's per-task brief_key, if that column exists ──
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'agent_tasks' and column_name = 'brief_key'
  ) then
    delete from public.agent_tasks a
     using (
       select id,
              row_number() over (
                partition by source, brief_key
                order by done desc, coalesce(agent_note_at, created_at) desc nulls last, id desc
              ) as rn
       from public.agent_tasks
       where brief_key is not null
     ) r
     where a.id = r.id and r.rn > 1;

    create unique index if not exists agent_tasks_source_briefkey_uniq
      on public.agent_tasks (source, brief_key)
      where brief_key is not null;
  end if;
end$$;

commit;
