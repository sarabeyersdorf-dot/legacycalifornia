-- 095_sync_runs.sql
-- A durable, readable record of each sync-deals run.
--
-- Why: /api/cron/sync-deals does ALL its work and only sends its JSON summary at
-- the very end. A heavy run finishes after Cowork's fetch tool times out, so the
-- manual ?key= call comes back with a 0-byte, header-less body — the work
-- committed, but the REPORT of it is lost (Cowork 8/29–8/30). Rather than chase
-- the transport (headers/status are not observable from Cowork at all), the sync
-- writes its summary here at the end of every run, and /api/crm/reconcile surfaces
-- the newest row in its `sync` section (so it rides the briefing-bundle's db_truth,
-- readable via ?sections=db_truth). One SELECT now answers "did it run, and what
-- did it do?" independent of the response body.

create table if not exists public.sync_runs (
  id                      bigint generated always as identity primary key,
  ran_at                  timestamptz not null default now(),
  ok                      boolean     not null default true,
  source_version          text,
  deals_source            text,               -- 'github' (fresh) | 'bundle' (deployed copy)
  deals_upserted          integer,
  deals_pruned            integer,
  tasks_written           integer,
  documents_written       integer,
  timeline_items_retired  integer,
  stage_overrides_cleared integer,
  date_promotions         jsonb,              -- [{deal, field, value}, …]
  error_count             integer,
  summary                 jsonb               -- the full response payload, for detail
);

create index if not exists sync_runs_ran_at_idx on public.sync_runs (ran_at desc);
