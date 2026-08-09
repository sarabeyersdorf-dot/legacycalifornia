-- 061_leads_source_internal_test.sql
-- Bug 9 — the intake handler tags a team-address submission source='internal_test'
-- so it skips scoring/drafts/nurture. The leads_source_check constraint didn't
-- allow that value, so the tag (and the guarded insert) would fail. Add it.
alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source = any (array[
    'website_form','open_house','referral','ihomefinder_idx',
    'manual','inbound_text','inbound_email','internal_test'
  ]));
