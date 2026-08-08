-- 055_deal_escrows.sql
-- Portal document model, Slice 2: ESCROWS AS CHILD RECORDS of a property.
-- (Companion spec: SPEC_portal_document_model.md — "one property record per
-- property; escrows are child records.")
--
-- Today a single `deals` row conflates the listing (the property/seller arc) with
-- whatever escrow is on it — so when an escrow is cancelled (433 E Hwy 4, 8/5) the
-- property has nowhere to "revert" to and the dead escrow's artifacts linger. This
-- migration adds the child layer so a property can carry a cancelled escrow, an
-- active escrow, and its listing state at the same time.
--
-- The `deals` row stays the PROPERTY record (address, listing, seller client).
-- Each escrow on it becomes a `deal_escrows` row. Transaction-scoped documents and
-- timeline items point at their escrow via `escrow_id`; property-scoped ones leave
-- `escrow_id` NULL (they belong to the property and survive every escrow).
--
-- Additive + idempotent. Nothing reads these columns until sync-deals + the portal
-- are wired (a later step in this slice), so this is safe to run on its own.

create table if not exists public.deal_escrows (
  id               uuid primary key default gen_random_uuid(),
  deal_id          uuid not null references public.deals(id) on delete cascade,
  -- Stable per-property key for the escrow, so the sync can upsert it across runs
  -- (e.g. "433-hwy4:esc1"). Authored in deals.json escrows[].key.
  escrow_key       text not null,
  status           text not null default 'active'
                     check (status in ('active', 'cancelled', 'closed')),
  label            text,                 -- "Escrow #1" / buyer-facing label
  buyer_name       text,
  sale_price       numeric,
  acceptance_date  date,
  escrow_open_date date,
  coe_date         date,
  escrow_number    text,
  cancelled_at     date,
  closed_at        date,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists deal_escrows_deal_key
  on public.deal_escrows (deal_id, escrow_key);
create index if not exists deal_escrows_deal_idx
  on public.deal_escrows (deal_id);

-- At most ONE active escrow per property (SPEC: "exactly one escrow may be active
-- per property"). A partial unique index enforces it without blocking multiple
-- cancelled/closed escrows.
create unique index if not exists deal_escrows_one_active
  on public.deal_escrows (deal_id) where status = 'active';

-- Link transaction-scoped children to their escrow. NULL = property-scoped (the
-- listing / the seller's own disclosures) — survives every escrow.
alter table public.deal_timeline_items
  add column if not exists escrow_id uuid references public.deal_escrows(id) on delete set null;
alter table public.deal_documents
  add column if not exists escrow_id uuid references public.deal_escrows(id) on delete set null;

create index if not exists deal_timeline_items_escrow_idx on public.deal_timeline_items (escrow_id);
create index if not exists deal_documents_escrow_idx on public.deal_documents (escrow_id);
