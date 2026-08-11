-- 065_deal_stage_history.sql
-- Per-stage history for deals, so the pipeline board can show a real
-- "N days in this stage" and a board-wide "average time in stage" instead of
-- the updated_at proxy the first re-skin used.
--
-- Model: one append-only row per stage entry (deal_stage_events) plus a
-- denormalised stage_entered_at on deals for the cheap "days in stage" read.
-- The effective stage mirrors crm-deals.js / crm-listings.js exactly:
--   effective = (stage in ('offer','preparing') and stage_override is not null)
--               ? stage_override : stage
-- A BEFORE trigger stamps stage_entered_at and appends an event whenever the
-- effective stage changes (including the agent's accept-offer override and the
-- hourly deals.json sync advancing a deal). Idempotent / safe to re-run.

create table if not exists public.deal_stage_events (
  id          bigint generated always as identity primary key,
  deal_id     uuid references public.deals(id) on delete cascade,
  source_key  text,
  stage       text,
  entered_at  timestamptz not null default now()
);
create index if not exists deal_stage_events_deal_idx
  on public.deal_stage_events (deal_id, entered_at desc);

alter table public.deals add column if not exists stage_entered_at timestamptz;

create or replace function public.deals_track_stage() returns trigger
language plpgsql as $$
declare
  new_stage text;
  old_stage text;
begin
  new_stage := case
    when NEW.stage in ('offer','preparing') and NEW.stage_override is not null
      then NEW.stage_override else NEW.stage end;

  if TG_OP = 'INSERT' then
    NEW.stage_entered_at := coalesce(NEW.stage_entered_at, now());
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, NEW.stage_entered_at);
    return NEW;
  end if;

  old_stage := case
    when OLD.stage in ('offer','preparing') and OLD.stage_override is not null
      then OLD.stage_override else OLD.stage end;

  if new_stage is distinct from old_stage then
    NEW.stage_entered_at := now();
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, now());
  end if;
  return NEW;
end $$;

drop trigger if exists deals_track_stage_trg on public.deals;
create trigger deals_track_stage_trg
  before insert or update on public.deals
  for each row execute function public.deals_track_stage();

-- Backfill existing rows: seed stage_entered_at from the best timestamp we have
-- and give every deal one opening event so "days in stage" and averages have a
-- floor to compute from. (First observation, not true history — real history
-- accrues from here forward.)
update public.deals
   set stage_entered_at = coalesce(stage_entered_at, updated_at, created_at, now())
 where stage_entered_at is null;

insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
  select d.id, d.source_key,
         case when d.stage in ('offer','preparing') and d.stage_override is not null
              then d.stage_override else d.stage end,
         coalesce(d.stage_entered_at, d.updated_at, d.created_at, now())
    from public.deals d
   where not exists (
     select 1 from public.deal_stage_events e where e.deal_id = d.id
   );
