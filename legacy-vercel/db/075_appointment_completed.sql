-- 075_appointment_completed.sql
-- Lets a follow-up reminder be marked done so it drops off the daily "Work the
-- day" follow-up list (api/crm/follow-ups). A null completed_at = still open.
-- Appointments have no done/status column today; this adds the minimal one.
-- Safe to run repeatedly.

alter table public.appointments
  add column if not exists completed_at timestamptz;

create index if not exists appointments_followup_open_idx
  on public.appointments (kind, starts_at)
  where completed_at is null;
