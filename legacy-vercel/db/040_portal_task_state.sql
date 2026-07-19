-- 040_portal_task_state.sql
-- Agent-managed state layered on top of the deals.json-driven client tasks +
-- an agent→Cowork note, both editable from the seller portal (agent preview
-- only) and surfaced to the daily briefing.
--
--   client_task_done   : jsonb array of clientTask LABELS the agent has ticked
--                        complete on the portal. Completed tasks drop off the
--                        client's "What I need from you" list; the agent still
--                        sees them (struck) and can un-tick.
--   portal_seller_note : { body, updated_at, by } — a private note the agent
--                        writes on the portal for the daily briefing (Cowork).
--                        Never shown to the client; read back via
--                        /api/crm/briefing-feedback so Cowork can act on it.
--
-- These are NOT written by sync-deals (mapDeal never sets them, and the sync's
-- UPDATE only touches mapped columns), so they survive every deals.json re-sync.
--
-- Additive and idempotent — safe to run repeatedly.

alter table public.deals add column if not exists client_task_done   jsonb;
alter table public.deals add column if not exists portal_seller_note jsonb;
