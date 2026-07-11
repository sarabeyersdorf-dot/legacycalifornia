-- 030_deal_timeline.sql
-- Client-facing contractual timeline for escrow deals + the approval queue
-- that gates every automatic update.
--
-- deal_timeline_items: one row per thing the seller sees on "The road to
-- closing" — milestones, contingencies, disclosures, seller tasks. Seeded
-- from the standard CA RPA template (dates computed by api/_lib/deal-timeline.js)
-- and editable per deal.
--
-- deal_timeline_proposals: NOTHING client-facing changes by itself. The daily
-- scan (api/cron/timeline-scan.js) and Cowork file proposals here; the agent
-- approves or rejects them from the morning brief; approval applies the change.
--
-- Run in the Supabase SQL editor. Idempotent.

create table if not exists public.deal_timeline_items (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references public.deals(id) on delete cascade,
  key             text not null,                -- template key ('emd','nhd',…) or 'custom:<slug>'
  kind            text not null check (kind in ('milestone','contingency','disclosure','task','document')),
  title           text not null,
  plain           text,                         -- plain-English "what this is" (no legalese)
  owner           text not null default 'seller' check (owner in ('seller','buyer','escrow','agent','both')),
  due_date        date,
  status          text not null default 'upcoming' check (status in ('upcoming','action','done','waived','na')),
  done_at         timestamptz,
  detail          text,                         -- optional per-deal note shown to the client
  client_visible  boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists deal_timeline_items_deal_key on public.deal_timeline_items (deal_id, key);
create index if not exists deal_timeline_items_deal_idx on public.deal_timeline_items (deal_id);

create table if not exists public.deal_timeline_proposals (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references public.deals(id) on delete cascade,
  item_id         uuid references public.deal_timeline_items(id) on delete cascade,
  item_key        text,
  address         text,                         -- denormalized for the brief
  change          jsonb not null,               -- e.g. {"status":"done","done_at":"2026-07-06"}
  reason          text,                         -- human sentence: why this is believed satisfied
  source          text not null default 'cron' check (source in ('cron','cowork','agent','system')),
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists deal_timeline_proposals_status_idx on public.deal_timeline_proposals (status);
create index if not exists deal_timeline_proposals_deal_idx on public.deal_timeline_proposals (deal_id);

-- RLS on, no anon policies: only the service-role API (Vercel functions) can
-- touch these — same posture as the rest of the schema.
alter table public.deal_timeline_items     enable row level security;
alter table public.deal_timeline_proposals enable row level security;
