-- 014_task_compliance_fields.sql
-- The CRM Tasks / compliance board, fed by the daily briefing. Idempotent and
-- self-contained: safe to run whether or not 013 was already applied.

-- MLS on deals (photo match) — no-op if already added.
alter table public.deals add column if not exists mls_number text;

-- Per-agent tasks table (creates it if 013 wasn't run).
create table if not exists public.agent_tasks (
  id         uuid primary key default gen_random_uuid(),
  agent      text not null check (agent in ('sara','james','both')),
  title      text not null,
  sub        text,
  due_label  text,
  done       boolean not null default false,
  source     text not null default 'briefing',
  source_key text,
  created_at timestamptz not null default now()
);

-- New compliance fields (added whether the table is fresh or pre-existing).
alter table public.agent_tasks add column if not exists client text;   -- badge, e.g. "Wendell"
alter table public.agent_tasks add column if not exists note   text;   -- the "+ note" text

create index if not exists agent_tasks_agent_idx on public.agent_tasks (agent);

alter table public.agent_tasks enable row level security;
drop policy if exists agent_tasks_agent_all on public.agent_tasks;
create policy agent_tasks_agent_all on public.agent_tasks
  for all using (public.current_role_is_agent()) with check (public.current_role_is_agent());
