-- 035_agent_updates_tags.sql
-- Adds proper deal/contact tagging to agent_updates (the Notes tab log).
-- Previously "Tag a deal or client" was a single free-text input (the `deal`
-- column). This adds real foreign keys so a note can be tagged with an
-- actual deal (picked from a dropdown) and/or an actual contact (picked via
-- typeahead against leads, or created on the spot) — both stay live-linked
-- to the real records instead of a typed string that can drift or typo.
--
-- The legacy `deal` text column is left in place untouched for older rows
-- that only ever had free text and no deal_id.
--
-- Safe to run repeatedly.

alter table public.agent_updates add column if not exists deal_id uuid references public.deals(id) on delete set null;
alter table public.agent_updates add column if not exists lead_id uuid references public.leads(id) on delete set null;

create index if not exists agent_updates_deal_id_idx on public.agent_updates (deal_id);
create index if not exists agent_updates_lead_id_idx on public.agent_updates (lead_id);
