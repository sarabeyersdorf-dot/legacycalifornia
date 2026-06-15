-- =============================================================================
-- Legacy Properties — Row Level Security policies
-- Run AFTER schema.sql.
--
-- Policy model:
--   - Agents (sara/james) can read/write everything.
--   - Buyers can read/write only their own lead row + related rows
--     (lead_events, messages, saved_properties, tours where lead_id == their lead).
--   - Sellers can read only their own property (where listed_by matches their
--     mapped user role) and related offers/tours.
--
-- The service-role key (used in server-side Vercel functions) bypasses RLS,
-- so all server endpoints continue to work with full access.
-- =============================================================================

-- Enable RLS on every public table
alter table public.sequences         enable row level security;
alter table public.leads             enable row level security;
alter table public.lead_events       enable row level security;
alter table public.messages          enable row level security;
alter table public.properties        enable row level security;
alter table public.saved_properties  enable row level security;
alter table public.tours             enable row level security;
alter table public.offers            enable row level security;
alter table public.users             enable row level security;

-- -----------------------------------------------------------------------------
-- Helper: is the current auth.uid() an agent?
-- -----------------------------------------------------------------------------
create or replace function public.current_role_is_agent()
returns boolean as $$
  select exists (
    select 1 from public.users
    where id = auth.uid()
      and role in ('agent_sara','agent_james','admin')
  );
$$ language sql stable security definer;

create or replace function public.current_lead_id()
returns uuid as $$
  select lead_id from public.users where id = auth.uid();
$$ language sql stable security definer;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
drop policy if exists users_self_read   on public.users;
drop policy if exists users_self_update on public.users;
drop policy if exists users_agent_all   on public.users;

create policy users_self_read   on public.users for select using (auth.uid() = id);
create policy users_self_update on public.users for update using (auth.uid() = id);
create policy users_agent_all   on public.users for all    using (public.current_role_is_agent());

-- -----------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------
drop policy if exists leads_agent_all on public.leads;
drop policy if exists leads_self_rw   on public.leads;

create policy leads_agent_all on public.leads for all
  using (public.current_role_is_agent());

create policy leads_self_rw on public.leads for all
  using (id = public.current_lead_id())
  with check (id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- lead_events
-- -----------------------------------------------------------------------------
drop policy if exists lead_events_agent_all on public.lead_events;
drop policy if exists lead_events_self_read on public.lead_events;

create policy lead_events_agent_all on public.lead_events for all
  using (public.current_role_is_agent());

create policy lead_events_self_read on public.lead_events for select
  using (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
drop policy if exists messages_agent_all on public.messages;
drop policy if exists messages_self_read on public.messages;

create policy messages_agent_all on public.messages for all
  using (public.current_role_is_agent());

create policy messages_self_read on public.messages for select
  using (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- properties (public read of active, agent-only write)
-- -----------------------------------------------------------------------------
drop policy if exists properties_public_read on public.properties;
drop policy if exists properties_agent_all   on public.properties;

create policy properties_public_read on public.properties for select using (true);
create policy properties_agent_all   on public.properties for all
  using (public.current_role_is_agent());

-- -----------------------------------------------------------------------------
-- saved_properties
-- -----------------------------------------------------------------------------
drop policy if exists saved_agent_all on public.saved_properties;
drop policy if exists saved_self_rw   on public.saved_properties;

create policy saved_agent_all on public.saved_properties for all
  using (public.current_role_is_agent());

create policy saved_self_rw on public.saved_properties for all
  using (lead_id = public.current_lead_id())
  with check (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- tours
-- -----------------------------------------------------------------------------
drop policy if exists tours_agent_all on public.tours;
drop policy if exists tours_self_rw   on public.tours;

create policy tours_agent_all on public.tours for all
  using (public.current_role_is_agent());

create policy tours_self_rw on public.tours for all
  using (lead_id = public.current_lead_id())
  with check (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- offers (agent-only write; sellers can read offers on their property)
-- -----------------------------------------------------------------------------
drop policy if exists offers_agent_all   on public.offers;
drop policy if exists offers_seller_read on public.offers;

create policy offers_agent_all on public.offers for all
  using (public.current_role_is_agent());

-- Sellers see offers tied to properties where their user.lead_id maps to the
-- seller's property listing record. (Detailed seller→property mapping refined
-- in Phase 1F; for now, agent-only.)

-- -----------------------------------------------------------------------------
-- sequences (read-only for everyone authenticated; agent write)
-- -----------------------------------------------------------------------------
drop policy if exists sequences_authed_read on public.sequences;
drop policy if exists sequences_agent_all   on public.sequences;

create policy sequences_authed_read on public.sequences for select
  using (auth.uid() is not null);

create policy sequences_agent_all on public.sequences for all
  using (public.current_role_is_agent());
