-- 013_agent_tasks_and_deal_mls.sql
-- 1) MLS number on deals — the reliable key to match a deal to its IDX listing
--    photo (address matching collides across towns that share a street name).
-- 2) agent_tasks — per-agent to-dos Sara writes in her daily briefing
--    (deals.json "tasks"), surfaced on that agent's Today desk.

-- 1. MLS number on deals -----------------------------------------------------
alter table public.deals add column if not exists mls_number text;

-- 2. Per-agent tasks ---------------------------------------------------------
create table if not exists public.agent_tasks (
  id         uuid primary key default gen_random_uuid(),
  agent      text not null check (agent in ('sara','james','both')),
  title      text not null,
  sub        text,
  due_label  text,
  done       boolean not null default false,
  source     text not null default 'briefing',   -- where it came from
  source_key text,                                -- optional link to a deal
  created_at timestamptz not null default now()
);
create index if not exists agent_tasks_agent_idx on public.agent_tasks (agent);

alter table public.agent_tasks enable row level security;
drop policy if exists agent_tasks_agent_all on public.agent_tasks;
create policy agent_tasks_agent_all on public.agent_tasks
  for all using (public.current_role_is_agent()) with check (public.current_role_is_agent());
