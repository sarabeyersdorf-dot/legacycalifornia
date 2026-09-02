-- 096_leads_source_related_contact.sql
-- Admit the two source values the code already writes: 'related_contact' and 'deal_auto'.
--
-- Why: `leads_source_check` allowed eight values, but two live insert paths send
-- a ninth and tenth, so every insert through them fails:
--
--   1. api/_lib/handlers/crm-related-contact.js sends source='related_contact'.
--      This is the "add a related contact from a contact card" button. It
--      surfaces the error, so James hit it head-on 2026-08-30 trying to add
--      Jennifer McEvoy — a seller who had signed the 179 Elams Ranch listing
--      agreement that same day — to Josh McEvoy's card. She could not be created
--      in the CRM at all.
--
--   2. api/cron/sync-deals.js sends source='deal_auto' when auto-creating a
--      contact from a deal's client name. That path does `if (insErr || !ins)
--      continue;` — it swallowed the failure, so the hourly cron has been
--      silently unable to spawn contacts from deals. No error was ever surfaced;
--      the only visible symptom was deals whose client never appeared as a
--      contact.
--
-- Widening rather than remapping to 'manual': both values carry real provenance
-- ("this contact came in as someone's relation" / "this contact was inferred
-- from a deal"), which is worth keeping distinct from a contact Sara typed in
-- by hand. The DB confirms nothing was written under either value — leads holds
-- only manual/website_form/inbound_email/ihomefinder_idx/open_house — so there
-- is no existing data to migrate.

alter table public.leads drop constraint if exists leads_source_check;

alter table public.leads add constraint leads_source_check
  check (source = any (array[
    'website_form',
    'open_house',
    'referral',
    'ihomefinder_idx',
    'manual',
    'inbound_text',
    'inbound_email',
    'internal_test',
    'related_contact',   -- added a contact from another contact's card
    'deal_auto'          -- auto-created from a deal's client name by sync-deals
  ]::text[]));
