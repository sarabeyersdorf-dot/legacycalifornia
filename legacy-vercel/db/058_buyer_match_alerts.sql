-- 058_buyer_match_alerts.sql
-- Native buyer listing alerts ("homes picked for you"). Tracks which listings
-- each buyer has already been alerted to (so we never repeat a home) and gates
-- how often a buyer is emailed.

create table if not exists public.listing_alert_sends (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  unique (lead_id, property_id)
);
create index if not exists listing_alert_sends_lead_idx on public.listing_alert_sends (lead_id);

alter table public.leads
  add column if not exists last_match_alert_at timestamptz;
