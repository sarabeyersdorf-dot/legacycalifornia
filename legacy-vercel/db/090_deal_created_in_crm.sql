-- 090_deal_created_in_crm.sql
-- SPEC · Agent-editable CRM, §4.2 — "Add a deal" from the CRM.
--
-- A deal typed straight into the CRM has no entry in deals.json, so the hourly
-- sync-deals orphan-prune (delete every deals row whose source_key is not in the
-- active deals.json set) would DELETE it on the next run. This flag marks a
-- CRM-authored deal so the prune skips it. Agent-owned, never written by the sync
-- (mapDeal only ever touches deals that exist in deals.json).
--
-- These deals carry a source_key prefixed 'crm-' and are otherwise ordinary deals
-- rows the Listings/Deals views and portals read exactly as any other.

alter table public.deals add column if not exists created_in_crm boolean not null default false;

create index if not exists deals_created_in_crm_idx on public.deals(created_in_crm) where created_in_crm;
