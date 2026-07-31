-- 049_taskflow.sql — CRM Taskflow (the Cowork loop). Additive & safe: every
-- statement is idempotent, nothing is dropped or backfilled, and the app code
-- feature-detects each column, so this can be applied before or after deploy.
--
-- Fix 1 — brief_key: a STABLE per-task key so a check-off / reply survives a
--   title change. Briefing task titles carry live countdowns ("COE 8/3 — 4 days"
--   → "3 days"); the old preserve-map matched on agent|client|title, so the tick
--   was silently dropped the next morning. sync-deals now matches on brief_key
--   when present, falling back to the signature when absent.
-- Fix 3 — deal_id / due_date: optional structured linkage + a real date, plus an
--   index for the open-task lists. Inert until code/briefing populate them.
--
-- NOTE: this does NOT touch source_key. Its NULL is load-bearing (it scopes the
-- hourly wipe at sync-deals.js:708) and must never be backfilled.

alter table public.agent_tasks
  add column if not exists brief_key text,
  add column if not exists deal_id   uuid references public.deals(id) on delete cascade,
  add column if not exists due_date   date;

create index if not exists agent_tasks_brief_key_idx
  on public.agent_tasks (brief_key) where brief_key is not null;
create index if not exists agent_tasks_deal_id_idx
  on public.agent_tasks (deal_id);
create index if not exists agent_tasks_open_idx
  on public.agent_tasks (done) where done = false;
