-- 092_deal_agent_good_to_know.sql
-- SPEC · Supabase-as-master, Phase 2 (§5.4) — promote the deals.json-authored
-- "Good to know" context to an agent-editable, DB-primary overlay.
--
-- The portal's "Good to know" bullets come from deals.json (goodToKnow /
-- buyerGoodToKnow → deals.good_to_know / buyer_good_to_know), which the hourly sync
-- clobbers. These agent overlays let Sara/James author or correct those bullets in
-- the CRM and have the edit STICK: mapDeal never writes them, so they survive the
-- sync, and the portal/CRM read the overlay WHEN PRESENT, falling back to Cowork's
-- value otherwise (same pattern as agent_overrides / origin:'crm' notes).
--
-- Additive and side-aware (seller vs buyer), so existing readers are unchanged.

alter table public.deals add column if not exists agent_good_to_know       jsonb;
alter table public.deals add column if not exists agent_buyer_good_to_know jsonb;
