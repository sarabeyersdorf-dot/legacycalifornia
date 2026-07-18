-- 037_deal_ledger_hidden.sql
-- "Remove from Ledger" support. Deliberately a soft hide, not a real delete:
--   - deals.json / api/cron/sync-deals.js is the source of truth for the deal
--     rows themselves — a hard DELETE here would just come back on the next
--     sync if the deal is still in deals.json, silently undoing the removal.
--   - deals has real child data (deal_timeline_items, deal_documents,
--     deal_messages, deal_parties, deal_activity, deal_tasks) that a cascade
--     delete would destroy. A CRM shouldn't lose transaction history because
--     someone cleaned up a list view.
-- ledger_hidden just filters a deal out of the Ledger's own query — nothing
-- else reads it, so this has no effect anywhere else in the app.
--
-- Additive + idempotent. No live route changes here. Safe to re-run.

alter table public.deals add column if not exists ledger_hidden boolean not null default false;
