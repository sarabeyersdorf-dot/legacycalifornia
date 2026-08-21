-- 076_fix_deal_stage_events_insert.sql
-- Fix: sync-deals fails with a foreign-key violation on every NEWLY-added deal:
--   insert or update on "deal_stage_events" violates "deal_stage_events_deal_id_fkey"
--
-- Root cause (db/065): deals_track_stage() is a BEFORE INSERT OR UPDATE trigger,
-- and its INSERT branch inserts a deal_stage_events row referencing NEW.id. At
-- BEFORE-INSERT time the parent deals row does not exist yet, so the child's FK
-- to deals(id) fails. Existing deals survived because they arrive as UPDATEs
-- (parent already present); only a genuinely new deal hits the INSERT branch and
-- errors — which is why the fault reproduces on any newly-added deal.
--
-- Fix: split the work by timing.
--   * BEFORE INSERT OR UPDATE  — only STAMP NEW.stage_entered_at (can mutate NEW).
--   * AFTER  INSERT OR UPDATE  — APPEND the deal_stage_events row (NEW.id now
--                                exists in deals, so the FK is satisfied).
-- Behaviour is otherwise identical to 065: one opening event per new deal, and a
-- new event whenever the effective stage changes. Idempotent / safe to re-run.

-- BEFORE: stamp stage_entered_at only. No child insert here.
create or replace function public.deals_stamp_stage() returns trigger
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
    return NEW;
  end if;

  old_stage := case
    when OLD.stage in ('offer','preparing') and OLD.stage_override is not null
      then OLD.stage_override else OLD.stage end;

  if new_stage is distinct from old_stage then
    NEW.stage_entered_at := now();
  end if;
  return NEW;
end $$;

-- AFTER: append the stage event (parent row is committed to the table now, so
-- deal_stage_events.deal_id -> deals(id) resolves).
create or replace function public.deals_log_stage() returns trigger
language plpgsql as $$
declare
  new_stage text;
  old_stage text;
begin
  new_stage := case
    when NEW.stage in ('offer','preparing') and NEW.stage_override is not null
      then NEW.stage_override else NEW.stage end;

  if TG_OP = 'INSERT' then
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, coalesce(NEW.stage_entered_at, now()));
    return NEW;
  end if;

  old_stage := case
    when OLD.stage in ('offer','preparing') and OLD.stage_override is not null
      then OLD.stage_override else OLD.stage end;

  if new_stage is distinct from old_stage then
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, coalesce(NEW.stage_entered_at, now()));
  end if;
  return NEW;
end $$;

-- Swap the single BEFORE trigger (065) for a BEFORE stamp + an AFTER log.
drop trigger if exists deals_track_stage_trg on public.deals;
drop trigger if exists deals_stamp_stage_trg on public.deals;
drop trigger if exists deals_log_stage_trg  on public.deals;

create trigger deals_stamp_stage_trg
  before insert or update on public.deals
  for each row execute function public.deals_stamp_stage();

create trigger deals_log_stage_trg
  after insert or update on public.deals
  for each row execute function public.deals_log_stage();

-- The old combined function is now unused. Drop it (CASCADE is not needed — no
-- trigger references it after the swap above).
drop function if exists public.deals_track_stage();

-- Backfill: any deal that never got an opening event because its INSERT errored
-- under the old trigger. Give each one an opening event now so "days in stage"
-- and stage averages have a floor. (Same shape as the 065 backfill.)
insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
  select d.id, d.source_key,
         case when d.stage in ('offer','preparing') and d.stage_override is not null
              then d.stage_override else d.stage end,
         coalesce(d.stage_entered_at, d.updated_at, d.created_at, now())
    from public.deals d
   where not exists (
     select 1 from public.deal_stage_events e where e.deal_id = d.id
   );
