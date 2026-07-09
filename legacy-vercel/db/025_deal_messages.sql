-- 025_deal_messages.sql
-- Phase 2C — Twilio deal communications inbox.
--
-- Inbound/outbound SMS + call events from Twilio. A row is written for every
-- event; if the phone number matches an existing lead it lands 'active' and
-- linked; if not it lands 'pending_review' with no contact, for the agent to
-- triage (new lead vs. personal call). Surfaced in the morning brief once
-- 'active'. INTERNAL / agent-only — never exposed to buyer/seller portals.
--
-- Safe to run repeatedly.

begin;

create table if not exists public.deal_messages (
  id                    uuid primary key default gen_random_uuid(),
  -- Nullable until an unmatched number is triaged into a lead. There is no
  -- `contacts` table in this schema — the people table is `leads`.
  contact_id            uuid references public.leads(id) on delete set null,
  direction             text not null check (direction in ('inbound','outbound')),
  channel               text not null check (channel in ('sms','call')),
  content               text,                       -- message body; null for calls
  call_duration_seconds integer,                    -- calls only
  -- Always retained, even after contact_id resolves, so the raw number is never
  -- lost (re-matching, audit, dedupe).
  raw_phone_number      text not null,
  status                text not null default 'pending_review'
                          check (status in ('pending_review','active','dismissed')),
  created_at            timestamptz not null default now()
);

create index if not exists deal_messages_status_created_idx
  on public.deal_messages (status, created_at desc);
create index if not exists deal_messages_contact_idx
  on public.deal_messages (contact_id);
create index if not exists deal_messages_phone_idx
  on public.deal_messages (raw_phone_number);

-- RLS — same internal/agent-only pattern as briefs/messages. Only the agent
-- role (public.current_role_is_agent()) may read or write. No self/client
-- policy exists, so nothing client-facing (buyer/seller magic-link sessions)
-- can ever read a row — pending_review or otherwise.
alter table public.deal_messages enable row level security;

drop policy if exists deal_messages_agent_all on public.deal_messages;
create policy deal_messages_agent_all on public.deal_messages for all
  using (public.current_role_is_agent());

-- Let the review queue tag auto-created leads with an accurate source. The
-- existing CHECK doesn't allow 'inbound_text'; widen it (drop + re-add).
alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('website_form','open_house','referral','ihomefinder_idx','manual','inbound_text'));

commit;

-- Verify:  select count(*) from public.deal_messages;  -- expect 0 the first time
