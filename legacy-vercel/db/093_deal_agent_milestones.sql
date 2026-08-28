-- 093_deal_agent_milestones.sql
-- SPEC · Supabase-as-master, Phase 2 — the road-to-closing (milestones) editable
-- in the CRM.
--
-- The portal's "road to closing" is driven, for a live deal, by deals.json
-- `milestones` / `buyerMilestones` (→ deals.milestones / buyer_milestones), which
-- the hourly sync clobbers and only Cowork can author. These agent overlays let
-- Sara/James author or correct the road IN the CRM and have it STICK: mapDeal never
-- writes them, so they survive the sync, and the portal reads the overlay WHEN
-- PRESENT (winning over the brief's version), falling back otherwise. Same shape as
-- deals.json milestones — a list of { date, label, desc, status, badge, col } — so
-- the portal renders them with no other change. Side-aware.

alter table public.deals add column if not exists agent_milestones       jsonb;
alter table public.deals add column if not exists agent_buyer_milestones jsonb;
