-- =============================================================================
-- Phase 1F — Seller Portal
-- =============================================================================
-- Adds the tables and columns needed for /api/seller/portal:
--   * properties.seller_lead_id  → links the property to its seller lead
--   * listing_stats              → per-day traffic numbers (manual entry stub)
--   * listing_checklist          → pre-listing checklist with per-row state
--
-- Documents are read straight from Supabase Storage (bucket: seller-docs,
-- prefix: <property_id>/). No DB table required.
--
-- Run after schema.sql, rls_policies.sql, seed_sequences.sql, 002_briefs_table.sql.
-- =============================================================================

-- 1. Link a property to its seller lead -------------------------------------
alter table public.properties
  add column if not exists seller_lead_id uuid
  references public.leads(id) on delete set null;

create index if not exists properties_seller_lead_idx
  on public.properties (seller_lead_id);

-- 2. Daily traffic snapshot (manual entry while IDX webhook is not live) ----
create table if not exists public.listing_stats (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  brief_date      date not null default current_date,
  page_views      integer not null default 0,
  unique_viewers  integer not null default 0,
  saves           integer not null default 0,
  source          text check (source in ('manual','ihomefinder_idx','website')) default 'manual',
  unique (property_id, brief_date)
);

create index if not exists listing_stats_property_idx
  on public.listing_stats (property_id, brief_date desc);

-- 3. Pre-listing checklist --------------------------------------------------
create table if not exists public.listing_checklist (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  sort_order    integer not null default 0,
  label         text not null,
  due_label     text,                       -- e.g. "Apr 14", "Today"
  completed_at  timestamptz
);

create index if not exists listing_checklist_property_idx
  on public.listing_checklist (property_id, sort_order);
