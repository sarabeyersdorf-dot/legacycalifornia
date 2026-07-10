-- 028_deal_photos_storage_policy.sql
-- Fixes "new row violates row-level security policy" when uploading a listing
-- photo.
--
-- 026 created the `deal-photos` bucket but no policy on storage.objects. RLS is
-- on for storage.objects, so the CRM's server role — which satisfies
-- public.current_role_is_agent() and is subject to RLS (that's why 020 was
-- needed for deals) — is denied the write with no matching policy. Add the same
-- agent gate the deals / leads / lead_notes tables use, plus public read for the
-- <img> URLs. Uploads still only happen through the agent-only server endpoint.
--
-- Safe to run repeatedly.

-- Ensure the bucket exists and stays public (idempotent with 026).
insert into storage.buckets (id, name, public)
values ('deal-photos', 'deal-photos', true)
on conflict (id) do update set public = true;

-- Public read of listing photos so the public URL loads in an <img>.
drop policy if exists deal_photos_public_read on storage.objects;
create policy deal_photos_public_read on storage.objects
  for select using (bucket_id = 'deal-photos');

-- Agents may add / replace / remove listing photos. Same gate as the CRM tables.
drop policy if exists deal_photos_agent_write on storage.objects;
create policy deal_photos_agent_write on storage.objects
  for all
  using      (bucket_id = 'deal-photos' and public.current_role_is_agent())
  with check (bucket_id = 'deal-photos' and public.current_role_is_agent());

-- Verify:  select name from storage.objects where bucket_id = 'deal-photos' limit 5;
