-- 098_leads_ihf_link.sql
-- Link a CRM contact to its iHomefinder lead record.
--
-- Why: iHomefinder's Listing Alerts are the only thing that can watch the whole
-- MLS for a client — iHomefinder confirmed in writing (case 00896993) that they
-- provide no listing data feed, so nothing on our side can. But those alerts
-- only reach people who exist as LEADS in iHomefinder, and as of 2026-08-17
-- their support reported "there are no lead currently in the system". Every
-- active client — Bev, Scot, Brian, Kendra, Roger — lives in this CRM and not
-- there, so none of them can be receiving alerts.
--
-- The one thing iHomefinder's Client API does is create a lead (their words,
-- case 00896894: "we do have a client API that allows you to create a lead, but
-- we do not have an endpoint that allows for you to" read anything back). So the
-- CRM pushes the contact across and records the id it gets back here, which is
-- what stops a second push creating a duplicate person on their side. Read-back
-- is impossible, so this column IS the only record that the push happened.
--
-- ihf_lead_id is text, not uuid: the id is whatever iHomefinder returns, and
-- their documented API is HAL-style REST where resource ids are opaque.
--
-- Safe to run more than once.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS ihf_lead_id  text,
  ADD COLUMN IF NOT EXISTS ihf_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_ihf_lead_id
  ON public.leads (ihf_lead_id) WHERE ihf_lead_id IS NOT NULL;

COMMENT ON COLUMN public.leads.ihf_lead_id IS
  'iHomefinder lead id returned when this contact was pushed via the Client API. Present = already pushed; used to avoid creating a duplicate lead on their side.';
COMMENT ON COLUMN public.leads.ihf_synced_at IS
  'When this contact was last pushed to iHomefinder.';
