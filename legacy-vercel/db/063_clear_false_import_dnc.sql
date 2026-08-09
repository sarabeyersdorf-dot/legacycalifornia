-- 063_clear_false_import_dnc.sql
-- Sara (2026-08-09): the "do not contact / DNC" flags were set en masse by a bad
-- consent-CSV import (api/_lib/handlers/crm-import-leads.js → applyConsent) and
-- are false. Clear them across all leads.
--
-- The import set FIVE things, all cleared here:
--   call_opt_out, sms_opt_out, email_opt_out, not_interested  (booleans)
--   status = 'do_not_contact'                                  (promoted when all
--                                                               three channels off
--                                                               OR not_interested)
-- It did NOT set contact_type, so a manually-chosen "Do Not Contact" category is
-- left alone (see the optional block at the bottom if you want that cleared too).
--
-- SAFETY: a full snapshot of every affected row is taken FIRST, so this is
-- reversible (rollback query at the bottom). Run the diagnostic in the PR/chat
-- notes before this if you want to see the counts.
-- Idempotent: the backup is captured once (first run), the clears are no-ops on
-- re-run.

begin;

-- 1. Reversible backup — every lead currently carrying any DNC/opt-out signal.
create table if not exists public.leads_consent_backup_20260809 as
  select id, status, contact_type,
         call_opt_out, sms_opt_out, email_opt_out, not_interested,
         now() as backed_up_at
    from public.leads
   where call_opt_out or sms_opt_out or email_opt_out or not_interested
      or status = 'do_not_contact';

-- 2. Clear the four opt-out booleans.
update public.leads
   set call_opt_out   = false,
       sms_opt_out    = false,
       email_opt_out  = false,
       not_interested = false
 where call_opt_out or sms_opt_out or email_opt_out or not_interested;

-- 3. Reset leads the import promoted to 'do_not_contact' back to 'active'.
--    (The import's own default is 'active', so this restores that baseline.)
update public.leads
   set status = 'active'
 where status = 'do_not_contact';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL — also clear a manually-chosen "Do Not Contact" *category*
-- (contact_type). The import never set this, so only run it if you also want to
-- wipe DNC categories you or James may have picked by hand:
--
-- update public.leads set contact_type = null where contact_type = 'do_not_contact';
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK — restore the pre-clear state from the backup, if any were real:
--
-- update public.leads l
--    set status         = b.status,
--        contact_type   = b.contact_type,
--        call_opt_out   = b.call_opt_out,
--        sms_opt_out    = b.sms_opt_out,
--        email_opt_out  = b.email_opt_out,
--        not_interested = b.not_interested
--   from public.leads_consent_backup_20260809 b
--  where l.id = b.id;
