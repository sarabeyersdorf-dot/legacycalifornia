-- 066_deal_agent_overrides.sql
-- Agent-authored field overrides for a deal, so James & Sara can fix a blank or
-- wrong price / close date / address / etc. from inside the CRM and have it STICK.
--
-- Why an override layer (not a direct edit): deals are authored by Cowork in
-- data/deals.json and loaded by the hourly sync (api/cron/sync-deals.js), which
-- UPDATEs the mapped columns (list_price, sale_price, address, coe_date, …) every
-- run. A value typed straight onto those columns would be overwritten within the
-- hour. The sync only writes the columns it maps, so a NEW column it never touches
-- survives — the same trick already used by deals.stage_override (db/024) and
-- deals.photo_override (db/026).
--
-- Shape: one jsonb blob of { field: value } pairs. A key present wins over the
-- synced column in the read paths (crm-deals.js); a key absent falls back to
-- Cowork's value, so clearing an override reverts to the source of truth.
-- Editable keys (enforced in api/_lib/handlers/crm-deal-edit.js): list_price,
-- sale_price, address, city, coe_date, mls_number, side, agent.
--
-- Idempotent / safe to re-run.

alter table public.deals add column if not exists agent_overrides jsonb;

comment on column public.deals.agent_overrides is
  'CRM agent field overrides ({field:value} jsonb). Wins over the deals.json sync in the read paths; the hourly sync never writes this column. See db/066.';
