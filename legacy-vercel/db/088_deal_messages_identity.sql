-- 088_deal_messages_identity.sql
-- Give deal_messages a stable identity so email ingestion can dedupe.
--
-- Before this, email-sync INSERTed one row per message per mailbox: Sara and
-- James are both on most deal threads, so each message landed twice (~1s apart),
-- and a message re-seen on a later sync landed again — 96 exact-duplicate groups
-- out of 782 inbound rows, and no stable key to dedupe on (Cowork 2026-08-27).
--
--   message_id  — the RFC-5322 Message-ID header. Unique per message across
--                 mailboxes and re-syncs, so it's the natural dedupe key.
--   sent_at     — parsed from the Date header. The only timestamp today is
--                 created_at (ingest time), which collapses a 15-min poll batch
--                 onto one instant; sent_at is when the message was actually sent.
--                 NULL when the header can't be parsed (a wrong time is worse
--                 than a missing one).
--   seen_by     — which mailboxes ingested this message ('sara' / 'james'). When
--                 both are on a thread we record both here instead of a 2nd row.
--
-- Safe to run repeatedly.

alter table public.deal_messages add column if not exists message_id text;
alter table public.deal_messages add column if not exists sent_at     timestamptz;
alter table public.deal_messages add column if not exists seen_by     text[] not null default '{}';

-- One row per real message. Partial so the ~734 legacy rows (message_id NULL)
-- are unaffected; new ingests upsert on this.
create unique index if not exists deal_messages_message_id_uniq
  on public.deal_messages (message_id) where message_id is not null;

create index if not exists deal_messages_sent_at_idx on public.deal_messages (sent_at desc);
