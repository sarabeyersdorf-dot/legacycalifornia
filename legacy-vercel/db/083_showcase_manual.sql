-- db/083_showcase_manual.sql
-- Manual / external showcase entries.
--
-- Some case studies don't map to a single CRM deal — e.g. a full relocation
-- (sold one home AND bought another), or a listing whose marketing page lives on
-- an external host (Netlify, etc.) rather than a /showcase/<slug> microsite.
-- These carry their own display fields and leave deal_id NULL. The unique index
-- on deal_id already permits many NULLs (a unique index treats NULLs as distinct
-- in Postgres), so no index change is needed.
--
-- For a manual entry: deal_id NULL, address/city/price_label filled here, the
-- photo in photo_override, the link in microsite_path (an absolute https URL is
-- allowed and opens in a new tab on the public page). Idempotent.

alter table public.showcase_deals add column if not exists address     text;  -- display title, e.g. "7094 Heaton Moor"
alter table public.showcase_deals add column if not exists city        text;  -- eyebrow, e.g. "Relocation · Murphys"
alter table public.showcase_deals add column if not exists price_label text;  -- freeform, e.g. "Sold + bought in Murphys"
