-- 028_saved_search_auto_push.sql
-- Let a saved search auto-deliver new matches to its linked client.
--
-- The flag-matches cron already re-runs each saved search after every MLS sync
-- and flags NEW listings (new_match_count). These columns let a search, when the
-- agent opts in, go one step further: add those new matches to a per-search
-- curated collection and email them to the client automatically — no manual push.
--
--   auto_push          — agent opted this search in to hands-off client delivery
--   collection_id      — the dedicated collection the cron maintains for it
--   last_auto_push_at  — when we last emailed the client (audit / dedupe)
--
-- Off by default, so existing searches never start emailing a client on their
-- own. Requires client_lead_id set (someone to email). Safe to run repeatedly.

alter table public.saved_searches add column if not exists auto_push boolean not null default false;
alter table public.saved_searches add column if not exists collection_id uuid references public.curated_collections(id) on delete set null;
alter table public.saved_searches add column if not exists last_auto_push_at timestamptz;
