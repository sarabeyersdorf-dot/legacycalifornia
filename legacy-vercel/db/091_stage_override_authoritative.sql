-- 091_stage_override_authoritative.sql
-- SPEC · Agent-editable CRM, §4.2 (part 2) — stage becomes authoritative.
--
-- Until now stage_override only took effect while deals.json had the deal at
-- offer/preparing/listing (a self-healing nudge). §4.2 makes an agent's stage
-- edit AUTHORITATIVE for ANY base stage: the app reads coalesce(stage_override,
-- stage) everywhere (CRM Deals, Listings, and the seller/buyer portal), so a
-- stage set in the CRM reflects on the client portal with no Cowork run.
--
-- Two changes:
--   1. Widen the stage_override CHECK to the full §4.2 vocabulary (keeping the
--      legacy 'dead' = offer-fell-through value).
--   2. Widen the effective-stage computation in the stage-history triggers to the
--      same coalesce(stage_override, stage) the app now uses, so deal_stage_events
--      records a transition whenever the EFFECTIVE stage changes — not only when
--      the base stage is offer/preparing.
--
-- Idempotent / safe to re-run.

alter table public.deals drop constraint if exists deals_stage_override_check;
alter table public.deals add constraint deals_stage_override_check
  check (stage_override is null or stage_override in
    ('offer','pending','listing','preparing','closed','dead',
     'cancelled','inactive','buyer-prospect','dispute'));

-- BEFORE: stamp stage_entered_at when the EFFECTIVE stage changes.
create or replace function public.deals_stamp_stage() returns trigger
language plpgsql as $$
declare
  new_stage text;
  old_stage text;
begin
  new_stage := coalesce(NEW.stage_override, NEW.stage);
  if TG_OP = 'INSERT' then
    NEW.stage_entered_at := coalesce(NEW.stage_entered_at, now());
    return NEW;
  end if;
  old_stage := coalesce(OLD.stage_override, OLD.stage);
  if new_stage is distinct from old_stage then
    NEW.stage_entered_at := now();
  end if;
  return NEW;
end $$;

-- AFTER: append a stage event when the EFFECTIVE stage changes.
create or replace function public.deals_log_stage() returns trigger
language plpgsql as $$
declare
  new_stage text;
  old_stage text;
begin
  new_stage := coalesce(NEW.stage_override, NEW.stage);
  if TG_OP = 'INSERT' then
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, coalesce(NEW.stage_entered_at, now()));
    return NEW;
  end if;
  old_stage := coalesce(OLD.stage_override, OLD.stage);
  if new_stage is distinct from old_stage then
    insert into public.deal_stage_events (deal_id, source_key, stage, entered_at)
      values (NEW.id, NEW.source_key, new_stage, coalesce(NEW.stage_entered_at, now()));
  end if;
  return NEW;
end $$;
