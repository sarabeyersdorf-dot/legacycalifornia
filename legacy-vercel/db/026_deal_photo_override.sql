-- 026_deal_photo_override.sql
-- Agent-uploaded listing photo. The CRM "Command Center" lets Sara drop a photo
-- onto a listing; it's stored in Supabase Storage and its URL is saved here.
-- Independent of the deals.json sync (which owns `photo_url`), so an uploaded
-- photo is never wiped by a sync.
--
-- Photo priority in the CRM: photo_override (this) → deals.photo_url (Cowork's
-- "photo" in deals.json) → MLS/IDX → YouTube-tour thumbnail → placeholder.
--
-- Safe to run repeatedly.

alter table public.deals add column if not exists photo_override text;

-- Public bucket for the uploaded photos (public read so the <img> loads via the
-- public URL; writes go through the service-role upload endpoint only).
insert into storage.buckets (id, name, public)
values ('deal-photos', 'deal-photos', true)
on conflict (id) do nothing;
