-- 051_drift_runs.sql
-- History for the hourly drift-check cron (api/cron/drift-check.js). Each run
-- logs the severity counts and the set of CRITICAL finding keys ("check:deal").
-- The cron alerts both agents only when a NEW critical key appears vs the prior
-- run, so persistent drift doesn't re-page every hour — it's loud on the way in,
-- quiet while unchanged. Also a plain audit trail of how much drift there is
-- over time (which tells you whether the Supabase-as-master flip is urgent).
--
-- Safe to run repeatedly.

create table if not exists public.drift_runs (
  id         uuid primary key default gen_random_uuid(),
  ran_at     timestamptz not null default now(),
  critical   int  not null default 0,
  warn       int  not null default 0,
  info       int  not null default 0,
  crit_keys  text[] not null default '{}',   -- "check:deal" for every critical finding
  alerted    boolean not null default false
);
create index if not exists drift_runs_ran_at_idx on public.drift_runs (ran_at desc);
