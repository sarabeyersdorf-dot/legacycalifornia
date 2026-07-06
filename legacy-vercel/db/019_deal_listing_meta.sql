-- 019_deal_listing_meta.sql
-- Listing roster metadata for the CRM "Listings" view: the fields off the
-- brokerage's listing sheet that aren't first-class deal columns (client name,
-- APN, beds/baths, sqft, lot, year, date listed, expiration, commission,
-- disclosure package link, branded video). Kept as one JSON blob on the deal so
-- the schema stays flexible — the sync writes deals.json's `listing` object here
-- verbatim and the Listings view renders from it.
--
-- Safe to run repeatedly.

alter table public.deals add column if not exists listing_meta jsonb;
