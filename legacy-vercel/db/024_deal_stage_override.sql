-- 024_deal_stage_override.sql
-- A per-deal stage override the AGENT sets from the CRM, independent of the
-- deals.json sync (which owns `stage`). Its one job today: let Sara flip an
-- offer to "in escrow" (pending) the moment it's accepted, before Cowork
-- moves the deal in deals.json.
--
-- The override only applies while deals.json still has the deal at stage
-- 'offer' (see api/_lib/handlers/crm-listings.js). Once Cowork advances the
-- deal to 'pending' in deals.json, `stage` itself becomes 'pending' and the
-- override is ignored — it self-heals, no clobbering of the source of truth.
--
-- Safe to run repeatedly.

alter table public.deals add column if not exists stage_override text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_stage_override_check') then
    alter table public.deals add constraint deals_stage_override_check
      check (stage_override is null or stage_override in
        ('offer','pending','listing','preparing','closed'));
  end if;
end $$;
