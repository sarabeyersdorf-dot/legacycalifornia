-- 029_deal_agent_notes.sql
-- Agent-only internal notes on a deal, shown at the top of the Command Center.
-- Separate from deals.notes (which Cowork writes from deals.json and which shows
-- on the client seller portal) — agent_notes is INTERNAL and independent of the
-- deals.json sync, so it's never overwritten and never reaches a client.
--
-- Safe to run repeatedly.

alter table public.deals add column if not exists agent_notes text;
