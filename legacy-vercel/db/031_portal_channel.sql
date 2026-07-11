-- 031_portal_channel.sql
-- Conversations: client <-> agent messages exchanged on the client's own pages
-- (seller portal, curated collections) thread through public.messages with
-- channel='portal'. Widen the CHECK. Idempotent.
alter table public.messages drop constraint if exists messages_channel_check;
alter table public.messages add constraint messages_channel_check
  check (channel in ('sms','email','portal'));
