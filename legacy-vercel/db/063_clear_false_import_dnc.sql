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
--
-- ⚠ CORRECTED 2026-09-05 — THIS FILE WAS NOT IDEMPOTENT.
-- The header used to claim "the clears are no-ops on re-run". That is true only
-- if nobody has opted out since, which is the one assumption a CRM cannot make.
-- The old deploy workflow re-ran every migration on every push, so from
-- 2026-08-09 this quietly cleared EVERY opt-out in the table on every deploy.
-- It was found when Ronald Jones — unsubscribed at 16:41 on 2026-09-05 after he
-- replied "Stop" to the Ledger — was subscribed again at 16:54 by a deploy.
-- The table held zero opt-outs of any kind at that moment.
--
-- Two things changed:
--   1. db/104 + .github/workflows/db-migrate.yml — each migration now runs ONCE.
--   2. The clears below are now scoped to the rows in the backup table, i.e.
--      exactly the people the 2026-08-09 import touched. Re-running this by hand
--      can no longer reach anyone who has opted out since.

begin;

-- 1. Reversible backup — every lead currently carrying any DNC/opt-out signal.
create table if not exists public.leads_consent_backup_20260809 as
  select id, status, contact_type,
         call_opt_out, sms_opt_out, email_opt_out, not_interested,
         now() as backed_up_at
    from public.leads
   where call_opt_out or sms_opt_out or email_opt_out or not_interested
      or status = 'do_not_contact';

-- 2. Clear the four opt-out booleans — ONLY for the people captured in the
--    backup above, which was taken on the first run and is therefore the record
--    of who the bad import actually affected. Anyone who has opted out since is
--    untouched. (Previously this had no such restriction and cleared the whole
--    table every time it ran.)
update public.leads l
   set call_opt_out   = false,
       sms_opt_out    = false,
       email_opt_out  = false,
       not_interested = false
  from public.leads_consent_backup_20260809 b
 where l.id = b.id
   and (l.call_opt_out or l.sms_opt_out or l.email_opt_out or l.not_interested);

-- 3. Reset leads the import promoted to 'do_not_contact' back to 'active'.
--    (The import's own default is 'active', so this restores that baseline.)
--    Same restriction, for the same reason.
update public.leads l
   set status = 'active'
  from public.leads_consent_backup_20260809 b
 where l.id = b.id
   and l.status = 'do_not_contact';

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
