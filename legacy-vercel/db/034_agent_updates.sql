-- 034_agent_updates.sql
-- A chronological "notes to Claude" log — quick free-text updates Sara or James
-- log from the CRM (texts they received, verbal updates, anything Claude has
-- no other visibility into) so the daily Legacy Morning Briefing (Cowork) can
-- read them and fold them into deals.json / the day's briefing.
--
-- Different from db/029 (deals.agent_notes): that's ONE overwritable note per
-- deal shown in the Command Center. This is an append-only, optionally
-- deal-tagged log, read back by the briefing via a key-authenticated feed
-- (same pattern as agent_tasks / briefing-feedback) and never overwritten.
--
-- Safe to run repeatedly.

create table if not exists public.agent_updates (
  id                  uuid primary key default gen_random_uuid(),
  agent               text not null check (agent in ('sara','james','both')),
  deal                text,              -- optional deals.json source_key / free text tag
  content             text not null,
  created_at          timestamptz not null default now(),
  read_by_briefing    boolean not null default false,
  read_by_briefing_at timestamptz
);

create index if not exists agent_updates_created_at_idx on public.agent_updates (created_at desc);
create index if not exists agent_updates_unread_idx on public.agent_updates (read_by_briefing) where read_by_briefing = false;

alter table public.agent_updates enable row level security;

-- Agent-only, both directions (read the log, add to it). No client access —
-- there is no policy granting anon/authenticated-non-agent rows here at all,
-- matching the internal-only visibility pattern used for agent_tasks (which
-- reuses this same current_role_is_agent() helper against public.users).
drop policy if exists agent_updates_agent_all on public.agent_updates;
create policy agent_updates_agent_all on public.agent_updates
  for all
  using (current_role_is_agent())
  with check (current_role_is_agent());
