-- =============================================================================
-- Migration 002 — Phase 1D persistent briefs
-- Run this ONCE in the Supabase SQL editor after the original bootstrap.
--
-- Adds the `briefs` table that stores the AI-generated morning brief narrative
-- for each day, so reload of crm.html doesn't burn an Anthropic call every
-- time. The handler upserts one row per (agent, brief_date).
-- =============================================================================

begin;

create table if not exists public.briefs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  agent       text check (agent in ('sara','james')) not null default 'sara',
  brief_date  date not null default current_date,
  narrative   text,
  snapshot    jsonb default '{}'::jsonb,
  unique (agent, brief_date)
);

create index if not exists briefs_agent_date_idx on public.briefs (agent, brief_date desc);

drop trigger if exists briefs_set_updated_at on public.briefs;
create trigger briefs_set_updated_at
before update on public.briefs
for each row execute function public.set_updated_at();

alter table public.briefs enable row level security;

drop policy if exists briefs_agent_all on public.briefs;
create policy briefs_agent_all on public.briefs for all
  using (public.current_role_is_agent());

commit;

-- Verify with:  select count(*) from public.briefs;  -- expect 0 the first time
