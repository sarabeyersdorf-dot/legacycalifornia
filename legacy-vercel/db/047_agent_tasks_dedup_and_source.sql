-- 047_agent_tasks_dedup_and_source.sql
-- Fix task churn. Keyed tasks (bulkSync 'brief:*', autoSync 'auto:*') were being
-- wiped every hour by the deals.json sync because they defaulted to
-- source='briefing', which that sync deletes wholesale — so a checked-off task
-- reopened each run. The code now (a) scopes that wipe to null-key rows only and
-- (b) tags auto tasks source='auto'. This migration back-fills existing rows and
-- adds a uniqueness guard so keyed tasks can't duplicate.
--
-- Safe to run repeatedly.

-- 1. Move historical auto tasks out of the 'briefing' lane so the sync stops
--    touching them and they no longer pollute the Cowork read-back.
update public.agent_tasks set source = 'auto'
 where source = 'briefing' and source_key like 'auto:%';

-- 2. Collapse existing duplicate keyed rows, keeping a done copy if one exists.
with ranked as (
  select id,
         row_number() over (partition by source_key
                            order by done desc, created_at desc) as rn
    from public.agent_tasks
   where source_key is not null
)
delete from public.agent_tasks
 where id in (select id from ranked where rn > 1);

-- 3. Enforce uniqueness on non-null keys going forward. Null-key rows (the
--    deals.json briefing tasks) are intentionally unconstrained.
create unique index if not exists agent_tasks_source_key_uniq
  on public.agent_tasks (source_key)
  where source_key is not null;

-- Verify:  select source, count(*) from public.agent_tasks group by 1 order by 1;
