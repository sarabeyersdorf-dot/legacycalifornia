-- 103_optout_audit_events.sql
-- Let an opt-out be recorded in lead_events.
--
-- WHY
-- On 2026-09-05 Ronald Jones replied "Stop" to the debut Legacy Ledger. Nothing
-- acted on it — the SMS side has caught STOP since day one, the email side had
-- no equivalent — and Sara honoured it by hand two hours later by following the
-- unsubscribe link. api/cron/email-sync.js now catches the keyword itself and
-- api/unsubscribe.js records what it did, but BOTH write a lead_events row, and
-- lead_events constrains event_type and source to fixed lists that had no value
-- for either. The insert would have failed the check constraint.
--
-- Both writes are deliberately best-effort — an audit row must never make an
-- unsubscribe appear to fail to the person clicking the link — which means a
-- rejected insert would have been swallowed in silence and left exactly no
-- record of an opt-out we are obliged to be able to prove we honoured. So the
-- constraint has to admit these before the code is worth anything.
--
-- Adds:
--   event_type 'email_opt_out'   — the request, with the words they used
--   source     'inbound_email'   — caught from a reply by the sync
--   source     'unsubscribe_link'— the person (or their mail client) clicked it
--
-- Safe to run more than once.

ALTER TABLE public.lead_events DROP CONSTRAINT IF EXISTS lead_events_event_type_check;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'property_saved', 'property_viewed', 'search_run', 'form_submitted',
    'email_opened', 'sms_replied', 'tour_booked', 'tour_completed',
    'message_sent', 'score_change', 'portal_message', 'collection_opened',
    'reaction', 'valuation_interest',
    'email_opt_out'
  ]));

ALTER TABLE public.lead_events DROP CONSTRAINT IF EXISTS lead_events_source_check;
ALTER TABLE public.lead_events ADD CONSTRAINT lead_events_source_check
  CHECK (source = ANY (ARRAY[
    'website', 'ihomefinder_idx', 'twilio', 'mailerlite', 'manual',
    'portal', 'collection',
    'inbound_email', 'unsubscribe_link'
  ]));
