-- 038_deal_milestones_notes.sql
-- One shared timeline per deal + an agent-authored client note, both driven from
-- deals.json (like `timeline` in 021 and 030). Kept as jsonb so the shape stays
-- flexible and the sync can write them verbatim.
--
--   milestones : ordered array of At-a-Glance steps, each
--                { date, label, status: done|next|upcoming|key, col, desc }
--                where col groups the step into an At-a-Glance column:
--                complete | week | contingencies | closing
--   agent_note : the client-facing note, author-attributed and approval-gated
--                { author: 'sara'|'james', status: draft|approved|published,
--                  updated, body }.  Only status === 'published' is ever shown
--                to a client (seller portal / buyer dashboard); draft/approved
--                stay agent-only until Sara or James publishes it in the CRM.
--
-- Additive and idempotent — safe to run repeatedly.

alter table public.deals add column if not exists milestones jsonb;
alter table public.deals add column if not exists agent_note jsonb;
