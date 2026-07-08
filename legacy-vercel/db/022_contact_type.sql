-- 022_contact_type.sql
-- A single "Side / category" for a contact, editable from Lead details & contact
-- prefs. Independent of pipeline_stage (which the kanban drives) — this is the
-- broad bucket Sara sorts her book into. buyer/seller/both also mirror to
-- deal_side (which drives portal/side logic) in the API.
--
-- Values: buyer, seller, both, closed, past_client, sphere, nurture, has_agent,
-- showing_homes, making_offers, do_not_call. (The "Trash" option in the UI
-- deletes the contact and is never stored.)
--
-- Safe to run repeatedly.

alter table public.leads add column if not exists contact_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_contact_type_check'
  ) then
    alter table public.leads add constraint leads_contact_type_check
      check (contact_type is null or contact_type in (
        'buyer','seller','both','closed','past_client','sphere','nurture',
        'has_agent','showing_homes','making_offers','do_not_call'
      ));
  end if;
end $$;
