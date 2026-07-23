-- 027_deal_stage_override_dead.sql
-- Extend the stage_override check constraint (db/024) to allow 'dead' — the
-- value the CRM sets when an offer FELL THROUGH.
--
-- Like every stage_override, it only applies while deals.json still has the
-- deal at stage 'offer' (see api/_lib/handlers/crm-listings.js): an offer that
-- collapses is soft-archived (moved out of the active pipeline into the CRM's
-- "Archived" list) without deleting the record, and it self-heals if Cowork
-- ever re-advances the deal in deals.json. The docs live in Zipforms, so we
-- keep only the thin deal row — no document retention here. Reversible: a
-- "Restore" clears the override and the offer comes back.
--
-- db/024 created the constraint with `if not exists`, so a plain re-run won't
-- widen it. Drop and re-add with the extra value. Safe to run repeatedly.

alter table public.deals add column if not exists stage_override text;

alter table public.deals drop constraint if exists deals_stage_override_check;

alter table public.deals add constraint deals_stage_override_check
  check (stage_override is null or stage_override in
    ('offer','pending','listing','preparing','closed','dead'));
