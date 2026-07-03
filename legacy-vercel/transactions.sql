-- =============================================================================
-- Legacy Properties — TRANSACTIONS & COMPLIANCE (additive migration)
-- Reconciled against the live Phase 1A schema (leads / properties / messages /
-- offers / tours / users). This ADDS the deal-management + compliance layer the
-- current DB is missing. It does NOT recreate anything that already exists —
-- people are `leads`, listings are `properties`, the "note from Sara" is a
-- `messages` row. Run AFTER schema.sql / rls_policies.sql.
--
-- Naming: all new tables are prefixed `deal_` (except `deals`) to sit clearly
-- beside the existing lead-centric tables.
-- =============================================================================

-- ---------- deals / transactions (the thing deals.json describes) ----------
create table if not exists public.deals (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  source_key            text unique,                 -- deals.json "id" (e.g. '433-hwy4')
  address               text not null,
  city                  text,
  property_id           uuid references public.properties(id) on delete set null,
  type                  text,                        -- residential / mixed-use / land / commercial
  side                  text check (side in ('buyer','seller','both')),
  stage                 text,                        -- pending / listing / closed / preparing / dispute
  agent                 text check (agent in ('sara','james')) default 'sara',
  list_price            integer,
  sale_price            integer,
  acceptance_date       date,                        -- Day 0 for deadline math
  escrow_open_date      date,
  coe_date              date,                        -- weekend-rolled close of escrow
  escrow_company        text,
  escrow_officer        text,
  escrow_order          text,
  title_company         text,
  co_agent              text,
  mls                   text,
  loan_contingency_days integer default 17,          -- 25 for 433 E Hwy 4
  notes_internal        text                          -- NEVER client-visible
);
create index if not exists deals_stage_idx  on public.deals (stage);
create index if not exists deals_source_idx on public.deals (source_key);

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at before update on public.deals
  for each row execute function public.set_updated_at();   -- reuse existing fn

-- ---------- who is on the deal (reuse `leads` as the person) ----------
create table if not exists public.deal_parties (
  deal_id   uuid references public.deals(id) on delete cascade,
  lead_id   uuid references public.leads(id) on delete cascade,
  role      text check (role in ('seller','co-seller','buyer','co-buyer')),
  primary key (deal_id, lead_id)
);

-- ---------- timeline milestones ("road to closing") ----------
create table if not exists public.deal_milestones (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references public.deals(id) on delete cascade,
  label       text not null,
  event_date  date,
  status      text check (status in ('done','next','upcoming','key')),
  description text,
  sort_order  integer default 0
);

-- ---------- contingencies (drive KPIs + road) ----------
create table if not exists public.deal_contingencies (
  id        uuid primary key default gen_random_uuid(),
  deal_id   uuid references public.deals(id) on delete cascade,
  kind      text,                                    -- inspection/appraisal/loan/title/insurance
  due_date  date,
  status    text default 'open' check (status in ('open','removed','waived'))
);

-- ---------- documents (fed by the Ex-folder compliance scan) ----------
create table if not exists public.deal_documents (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references public.deals(id) on delete cascade,
  doc_type    text,
  name        text not null,
  sub         text,
  status      text check (status in ('signed','on_file','to_sign','with_seller','sent','pending')),
  party_owed  text,
  client_safe boolean default true,                  -- commission/prequal/etc = false
  updated_at  timestamptz not null default now()
);

-- ---------- client to-dos ("what I need from you") ----------
create table if not exists public.deal_tasks (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid references public.deals(id) on delete cascade,
  label         text not null,
  status        text default 'open' check (status in ('open','in_process','done')),
  when_label    text,
  assigned_role text check (assigned_role in ('seller','buyer')),
  sort_order    integer default 0
);

-- ---------- activity feed ----------
create table if not exists public.deal_activity (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references public.deals(id) on delete cascade,
  text        text not null,
  occurred_at timestamptz not null default now(),
  emphasis    text default 'normal'
);

-- ---------- "Note from Sara": REUSE the existing messages table ----------
-- The weekly note is a messages row (status draft -> pending_approval ->
-- approved -> sent), targeted at the seller/buyer lead. Add an optional link
-- so a message can be tied to a specific deal:
alter table public.messages
  add column if not exists deal_id uuid references public.deals(id) on delete set null;

-- =============================================================================
-- RLS — a signed-in buyer/seller sees only their own deal
-- (users.lead_id links auth.uid() -> a lead; deal_parties links lead -> deal)
-- =============================================================================
alter table public.deals              enable row level security;
alter table public.deal_milestones    enable row level security;
alter table public.deal_contingencies enable row level security;
alter table public.deal_documents     enable row level security;
alter table public.deal_tasks         enable row level security;
alter table public.deal_activity      enable row level security;

create or replace view public.my_deal_ids as
  select dp.deal_id
  from public.deal_parties dp
  join public.users u on u.lead_id = dp.lead_id
  where u.id = auth.uid();

create policy deal_read_own on public.deals
  for select using (id in (select deal_id from public.my_deal_ids));
create policy deal_ms_read on public.deal_milestones
  for select using (deal_id in (select deal_id from public.my_deal_ids));
create policy deal_ct_read on public.deal_contingencies
  for select using (deal_id in (select deal_id from public.my_deal_ids));
create policy deal_doc_read on public.deal_documents
  for select using (deal_id in (select deal_id from public.my_deal_ids) and client_safe = true);
create policy deal_task_read on public.deal_tasks
  for select using (deal_id in (select deal_id from public.my_deal_ids));
create policy deal_act_read on public.deal_activity
  for select using (deal_id in (select deal_id from public.my_deal_ids));

-- Agents (role agent_sara / agent_james in public.users) get full access via
-- your existing agent policies / service role — wire alongside rls_policies.sql.

-- =============================================================================
-- The portal endpoint GET /api/seller/portal should SELECT from:
--   deals (hero/status/kpis) + deal_milestones (road) + deal_documents (docs)
--   + deal_tasks (what I need) + deal_activity + offers/tours (existing)
--   + latest published messages row where deal_id = :id  (the note)
-- and return { portal: <deals_to_portal.py payload shape> }.
-- =============================================================================
