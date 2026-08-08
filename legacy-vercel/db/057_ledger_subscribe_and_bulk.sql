-- 057_ledger_subscribe_and_bulk.sql
-- Real Ledger subscription + CRM bulk/newsletter email.
--
-- Everyone (leads, clients, sphere, and now newsletter subscribers) is a row
-- in public.leads. This adds:
--   * tags[]            — free-form labels for segmenting (e.g. 'ledger').
--   * unsubscribe_token — per-contact token behind the one-click unsubscribe
--                         link required on every bulk / newsletter email.
--   * ledger_sends      — records which subscriber received which issue, so the
--                         auto-send cron is idempotent and resumable across the
--                         hourly Vercel budget.
--   * ledger_issues.emailed_at — stamped once an issue has gone to everyone.

alter table public.leads
  add column if not exists tags              text[] not null default '{}',
  add column if not exists unsubscribe_token uuid   not null default gen_random_uuid();

create unique index if not exists leads_unsub_token_idx on public.leads (unsubscribe_token);
-- GIN index makes `where 'ledger' = any(tags)` / tag overlap fast.
create index if not exists leads_tags_idx on public.leads using gin (tags);

create table if not exists public.ledger_sends (
  id          uuid primary key default gen_random_uuid(),
  issue_slug  text        not null,
  lead_id     uuid        not null references public.leads(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  unique (issue_slug, lead_id)
);
create index if not exists ledger_sends_slug_idx on public.ledger_sends (issue_slug);

alter table public.ledger_issues
  add column if not exists emailed_at timestamptz;
