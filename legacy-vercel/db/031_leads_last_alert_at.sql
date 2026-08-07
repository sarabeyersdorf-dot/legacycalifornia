-- 031_leads_last_alert_at.sql
-- Throttle state for consumer-engagement alerts.
--
-- Both agents get SMS + email when a consumer engages (website intake + IDX
-- behavioral webhook). High-signal events (saved search, saved property, form)
-- always ping; passive views ping only on first-touch per window, so repeat
-- browsing doesn't bury the agents. This column records when we last alerted on
-- a lead, so the throttle knows whether we're inside the quiet window.
--
-- Safe to run repeatedly.

alter table public.leads add column if not exists last_alert_at timestamptz;
