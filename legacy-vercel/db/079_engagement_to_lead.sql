-- 079_engagement_to_lead.sql
-- Wire client collection engagement to the LEAD, so opens/reactions/views show
-- up on the lead timeline and count in the funnel (audit item 2, 2026-08-24).
--
-- Context: collection engagement is written server-side with the service role
-- (api/c/[token].js), so RLS never blocked it — but collection_events carried
-- no lead_id and nothing propagated into lead_events, which is what feeds the
-- timeline, funnel and scoring. This adds the link + a last_engagement_at stamp
-- and backfills what is derivable. The endpoint change (same PR) starts writing
-- lead_id on new events and mirroring each into lead_events.
--
-- Idempotent: safe to re-run (the db-migrate workflow may re-apply it after a
-- manual apply during development).

-- 1. Link engagement rows to the collection's recipient lead.
alter table public.collection_events
  add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.collection_reactions
  add column if not exists lead_id uuid references public.leads(id) on delete set null;

create index if not exists collection_events_lead_idx    on public.collection_events (lead_id);
create index if not exists collection_reactions_lead_idx on public.collection_reactions (lead_id);

-- 2. A single "when did this lead last engage" stamp for temperature/scoring.
alter table public.leads
  add column if not exists last_engagement_at timestamptz;

-- 2b. lead_events carries CHECK constraints on event_type + source (db/032).
-- Extend them for the collection engagement signals, or every mirrored insert
-- would silently fail the check and nothing would reach the timeline/funnel.
alter table public.lead_events drop constraint if exists lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check
  check (event_type in (
    'property_saved','property_viewed','search_run','form_submitted',
    'email_opened','sms_replied','tour_booked','tour_completed',
    'message_sent','score_change','portal_message',
    'collection_opened','reaction','valuation_interest'));
alter table public.lead_events drop constraint if exists lead_events_source_check;
alter table public.lead_events add constraint lead_events_source_check
  check (source in ('website','ihomefinder_idx','twilio','mailerlite','manual','portal','collection'));

-- 3. Backfill lead_id from the collection's recipient (curated_collections.client_lead_id).
update public.collection_events e
   set lead_id = c.client_lead_id
  from public.curated_collections c
 where c.id = e.collection_id
   and e.lead_id is null
   and c.client_lead_id is not null;

update public.collection_reactions r
   set lead_id = c.client_lead_id
  from public.curated_collections c
 where c.id = r.collection_id
   and r.lead_id is null
   and c.client_lead_id is not null;

-- 4. Seed last_engagement_at from the most recent engagement we can attribute.
update public.leads l
   set last_engagement_at = greatest(coalesce(l.last_engagement_at, 'epoch'::timestamptz), e.mx)
  from (
    select lead_id, max(created_at) as mx
      from public.collection_events
     where lead_id is not null
     group by lead_id
  ) e
 where e.lead_id = l.id;
