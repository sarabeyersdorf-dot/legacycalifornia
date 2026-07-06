-- 018_deals_table.sql
-- The `deals` table is the target of the hourly deals.json sync
-- (api/cron/sync-deals.js) and the source for the CRM Deals view
-- (api/crm/listings), every seller/buyer portal (api/seller/portal.js), and
-- deal linking. It was created ad-hoc in an earlier setup and never captured
-- as a migration, so a fresh or reset database has NO `deals` table — every
-- sync insert then fails (caught per-deal) and the table stays empty: the CRM
-- shows 0 deals and portals say "deal not found".
--
-- This migration is the missing schema-as-code. It is fully idempotent:
--   * creates the table if it doesn't exist, and
--   * adds every column the code writes/reads if the table exists but is
--     missing one (a partial ad-hoc table).
-- Safe to run any number of times.

-- 1. The table (no-op if it already exists) ---------------------------------
create table if not exists public.deals (
  id                    uuid primary key default gen_random_uuid(),
  source_key            text,
  address               text,
  city                  text,
  type                  text,
  side                  text,        -- seller | buyer | both
  stage                 text,        -- listing | pending | preparing | closed
  agent                 text,        -- sara | james
  list_price            numeric,
  sale_price            numeric,
  escrow_open_date      date,
  coe_date              date,
  escrow_officer        text,
  title_company         text,
  co_agent              text,
  mls_number            text,
  loan_contingency_days integer,
  notes_internal        text,
  photo_url             text,
  video_url             text,
  matterport_url        text,
  property_id           uuid,        -- optional link to public.properties (IDX)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- 2. Backfill any missing columns on a pre-existing (partial) table ----------
alter table public.deals add column if not exists source_key            text;
alter table public.deals add column if not exists address               text;
alter table public.deals add column if not exists city                  text;
alter table public.deals add column if not exists type                  text;
alter table public.deals add column if not exists side                  text;
alter table public.deals add column if not exists stage                 text;
alter table public.deals add column if not exists agent                 text;
alter table public.deals add column if not exists list_price            numeric;
alter table public.deals add column if not exists sale_price            numeric;
alter table public.deals add column if not exists escrow_open_date      date;
alter table public.deals add column if not exists coe_date              date;
alter table public.deals add column if not exists escrow_officer        text;
alter table public.deals add column if not exists title_company         text;
alter table public.deals add column if not exists co_agent              text;
alter table public.deals add column if not exists mls_number            text;
alter table public.deals add column if not exists loan_contingency_days integer;
alter table public.deals add column if not exists notes_internal        text;
alter table public.deals add column if not exists photo_url             text;
alter table public.deals add column if not exists video_url             text;
alter table public.deals add column if not exists matterport_url        text;
alter table public.deals add column if not exists property_id           uuid;
alter table public.deals add column if not exists created_at            timestamptz not null default now();
alter table public.deals add column if not exists updated_at            timestamptz not null default now();

-- 3. One deal per source_key. The sync does select-by-source_key then
--    update|insert; a unique index keeps that clean and stops duplicate rows
--    from ever nulling the portal's .maybeSingle() lookup.
create unique index if not exists deals_source_key_key on public.deals (source_key);

-- 4. deal_documents — the client-safe files the portal lists. Created here too
--    so a fresh DB has it; doc_url is added by 016 (kept here for completeness).
create table if not exists public.deal_documents (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references public.deals(id) on delete cascade,
  doc_type    text,
  name        text,
  sub         text,
  status      text,
  party_owed  text,
  client_safe boolean not null default true,
  doc_url     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.deal_documents add column if not exists doc_url     text;
alter table public.deal_documents add column if not exists party_owed  text;
alter table public.deal_documents add column if not exists client_safe boolean not null default true;
create index if not exists deal_documents_deal_id_idx on public.deal_documents (deal_id);
