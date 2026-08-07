-- 050_deal_documents_status_raw.sql
-- deal_documents.status is constrained to a fixed enum
--   CHECK (status = ANY (ARRAY['signed','on_file','to_sign','with_seller','sent','pending']))
-- but data/deals.json stores each doc's status as free-text prose. sync-deals.js
-- now maps that prose to the enum for `status` and keeps the ORIGINAL string in
-- this `status_raw` column, so nothing is lost and the seller portal never sees
-- prose in the column it branches on. A not-on-file doc is stored as
-- status='pending' with status_raw='missing' (the enum has no 'missing' value);
-- the CRM health rollup reads status_raw='missing' to count file gaps.
--
-- Safe to run repeatedly. Matches the column already present in the live DB
-- (added out-of-band alongside the fix_sync_deals_crashes triggers).

alter table public.deal_documents add column if not exists status_raw text;
