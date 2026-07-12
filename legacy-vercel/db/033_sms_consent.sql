-- 033_sms_consent.sql
-- Express SMS opt-IN records (A2P 10DLC compliance). The existing opt-out
-- flags say "stop"; these say "yes, you may text me", with when and where.
alter table public.leads
  add column if not exists sms_consent        boolean not null default false,
  add column if not exists sms_consent_at     timestamptz,
  add column if not exists sms_consent_source text;
