-- 032_portal_events.sql
-- The live feed's client-message signal: allow event_type='portal_message'
-- and source='portal' on lead_events (both CHECKs predate Conversations).
alter table public.lead_events drop constraint if exists lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check
  check (event_type in (
    'property_saved','property_viewed','search_run','form_submitted',
    'email_opened','sms_replied','tour_booked','tour_completed',
    'message_sent','score_change','portal_message'));
alter table public.lead_events drop constraint if exists lead_events_source_check;
alter table public.lead_events add constraint lead_events_source_check
  check (source in ('website','ihomefinder_idx','twilio','mailerlite','manual','portal'));
