-- db/087_email_queue.sql
-- Bulk-email send queue. Instead of blasting a whole segment synchronously
-- (which outran Resend's ~2/sec rate limit and daily cap — 200 sent, 800
-- failed on a 1,000 send), a "Schedule" enqueues one row per recipient here,
-- and api/cron/email-queue drains it at a safe pace, stopping at a daily cap
-- and spilling the rest to the next day. Idempotent + resumable.

create table if not exists email_queue (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  lead_id     uuid references leads(id) on delete set null,
  to_email    text not null,
  to_name     text,
  subject     text not null,
  body        text,
  template    jsonb,
  agent       text not null default 'sara',
  status      text not null default 'queued',   -- queued | sent | failed | skipped
  attempts    int  not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

-- One row per (campaign, lead) so a retried Schedule call can't double-queue.
create unique index if not exists email_queue_campaign_lead_uq
  on email_queue (campaign_id, lead_id) where lead_id is not null;

-- Drain index: the cron pulls the oldest still-queued rows.
create index if not exists email_queue_drain_idx
  on email_queue (created_at) where status = 'queued';

-- Campaign rollups for the CRM status poll.
create index if not exists email_queue_campaign_idx on email_queue (campaign_id);
