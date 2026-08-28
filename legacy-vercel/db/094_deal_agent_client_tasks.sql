-- 094_deal_agent_client_tasks.sql
-- SPEC · Supabase-as-master, Phase 2 — promote the portal client to-do list
-- ("What I need from you") to an agent-editable, DB-primary overlay.
--
-- The portal's client task list comes from deals.json (clientTasks / buyerTasks →
-- deals.client_tasks / buyer_tasks), which the hourly sync clobbers. These agent
-- overlays let Sara/James curate that list in the CRM and have it STICK: mapDeal
-- never writes them, so the edit survives the sync; the portal reads the overlay
-- WHEN PRESENT and falls back to Cowork's list otherwise (same pattern as
-- agent_good_to_know / agent_milestones). Side-aware (seller vs buyer).
--
-- Note: these REPLACE the deals.json base list. Individually-tracked agent tasks
-- (db §4.1, agent_tasks source='agent' visibility='client') still render ALONGSIDE
-- this list on the portal — the two mechanisms coexist.

alter table public.deals add column if not exists agent_client_tasks jsonb;
alter table public.deals add column if not exists agent_buyer_tasks  jsonb;
