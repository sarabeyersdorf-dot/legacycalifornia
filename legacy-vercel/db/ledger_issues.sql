-- db/ledger_issues.sql
-- The Ledger: monthly newsletter issues for legacycalifornia.com
--
-- STATUS: this migration has ALREADY BEEN APPLIED to the live Supabase
-- project (sthfxehojcvfdyatxzlv) on 2026-07-29. It is committed here as the
-- repo's record of the schema, matching how db/transactions.sql works.
-- Running it again is safe (idempotent).
--
-- Convention notes, to match the rest of this database:
--   * RLS is ON.
--   * Public read is scoped to status='published' — drafts are invisible to
--     the anon key, which is what /api/ledger uses.
--   * Writes go through public.current_role_is_agent(), the same helper used
--     by briefs / properties / curated_collections. There is NO profiles
--     table in this schema; do not introduce one.

create table if not exists public.ledger_issues (
  id            uuid primary key default gen_random_uuid(),

  -- archive identity / routing
  slug          text unique not null,              -- '2026-08'
  issue_month   date not null,                     -- always the 1st: 2026-08-01
  volume        text,                              -- 'XXII'
  issue_no      int,                               -- 8
  send_date     date,                              -- the 2nd-Tuesday send date

  -- headline material (first-class so the archive index can query it cheaply)
  title         text not null,
  dek           text,
  hero_image_url text,
  tags          text[] default '{}',
  reading_time  int,

  -- body: JSONB so a new section never needs a migration.
  --   { letter:{kicker,headline,body[]},
  --     numbers:{kicker,headline,note,stats[],spread{}},
  --     happenings:{kicker,headline,note,groups[],markets{},footnotes[]},
  --     recipe:{kicker,headline,intro,serves,ingredients[],steps[],notes[]},
  --     worth_knowing:{kicker,items[]},
  --     a_note:{kicker,body,signoff} }
  content       jsonb not null default '{}'::jsonb,

  -- every published market claim carries its source (compliance / trust)
  sources       jsonb not null default '[]'::jsonb,

  -- workflow
  status        text not null default 'draft'
                  check (status in ('draft','review','published','archived')),
  published_at  timestamptz,
  generated_by  text,                              -- 'cowork-monthly' | 'manual'
  review_notes  text,                              -- what the drafter flagged for Sara

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ledger_issues_month_idx
  on public.ledger_issues (issue_month desc);
create index if not exists ledger_issues_status_idx
  on public.ledger_issues (status, issue_month desc);
create index if not exists ledger_issues_tags_idx
  on public.ledger_issues using gin (tags);

-- keep updated_at honest, and stamp published_at on the draft→published flip
create or replace function public.ledger_issues_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.status = 'published' and (old.status is distinct from 'published')
     and new.published_at is null then
    new.published_at = now();
  end if;
  return new;
end $$;

drop trigger if exists ledger_issues_touch_trg on public.ledger_issues;
create trigger ledger_issues_touch_trg
  before update on public.ledger_issues
  for each row execute function public.ledger_issues_touch();

alter table public.ledger_issues enable row level security;

drop policy if exists ledger_public_read on public.ledger_issues;
create policy ledger_public_read on public.ledger_issues
  for select using (status = 'published');

drop policy if exists ledger_agent_all on public.ledger_issues;
create policy ledger_agent_all on public.ledger_issues
  for all using (public.current_role_is_agent());

comment on table public.ledger_issues is
  'The Ledger monthly newsletter. Cowork writes status=draft each month; Sara flips to published. Public RLS exposes published rows only.';


-- ---------------------------------------------------------------------------
-- To publish an issue (this is the whole publish action):
--
--   update public.ledger_issues set status='published' where slug='2026-08';
--
-- To un-publish:
--
--   update public.ledger_issues set status='draft' where slug='2026-08';
--
-- The `published_at` timestamp is set automatically on the first publish and
-- is not overwritten on re-publish.
-- ---------------------------------------------------------------------------
