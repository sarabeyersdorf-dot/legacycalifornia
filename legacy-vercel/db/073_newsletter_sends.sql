-- db/073_newsletter_sends.sql
-- Idempotency + audit ledger for the SendGrid monthly newsletter
-- (supabase/functions/newsletter). One row per (issue, recipient) once an email
-- has been accepted by SendGrid, so re-invoking the function during a warm-up
-- ramp never double-sends: each batch selects only contactable recipients that
-- do NOT already have a row here for the issue.
--
-- Distinct from ledger_sends (the retired Resend "Ledger" path) so the two send
-- channels never entangle.

create table if not exists public.newsletter_sends (
  issue_slug text not null,
  lead_id    uuid not null references public.leads(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  message_id text,
  primary key (issue_slug, lead_id)
);

create index if not exists newsletter_sends_issue_idx on public.newsletter_sends (issue_slug);

-- Only the edge function (service role, which bypasses RLS) writes/reads this.
-- Enable RLS with no policy so the anon/public API can never reach it.
alter table public.newsletter_sends enable row level security;
