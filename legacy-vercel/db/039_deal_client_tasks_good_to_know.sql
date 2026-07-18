-- 039_deal_client_tasks_good_to_know.sql
-- v1.5 client-portal content, driven from deals.json (like milestones in 038).
-- Kept as jsonb so the sync writes them verbatim and the shape stays flexible.
--
--   client_tasks : the "What I need from you" list the seller/buyer sees —
--                  [{ label, when, status }]. Renders instead of deriving the
--                  list only from owed documents (which left deals with real
--                  to-dos showing the empty state).
--   good_to_know : the "Good to know" block — [{ title, body }]. Shown IN
--                  ADDITION to the agent note, matching the timeline pages.
--
-- (milestone `badge` + `desc` need no new column — milestones is already a jsonb
-- blob written verbatim from deals.json, so those fields ride along.)
--
-- Additive and idempotent — safe to run repeatedly.

alter table public.deals add column if not exists client_tasks jsonb;
alter table public.deals add column if not exists good_to_know jsonb;
