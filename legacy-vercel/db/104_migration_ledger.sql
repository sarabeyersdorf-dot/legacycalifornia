-- 104_migration_ledger.sql
-- Make a migration run ONCE. Until now the deploy workflow re-ran every file in
-- this folder on every push that touched any of them.
--
-- WHAT THAT COST, TODAY
-- 2026-09-05 16:41 — Sara unsubscribed Ronald Jones after he replied "Stop".
-- 2026-09-05 16:54 — a migration shipped, the workflow re-ran all 103 files, and
--                    db/063_clear_false_import_dnc.sql ran again. Its job, back
--                    on 2026-08-09, was to clear opt-out flags a bad consent-CSV
--                    import had set on 693 people. It does that with:
--
--                      update public.leads set email_opt_out = false, ...
--                       where call_opt_out or sms_opt_out or email_opt_out
--                          or not_interested;
--
--                    — every row carrying any opt-out, not just the import's.
--                    Thirteen minutes after Sara honoured it, Ronald was
--                    subscribed again. Nobody would have seen it.
--
-- It had been happening since 2026-08-09. At the moment this was found there
-- were ZERO opt-outs of any kind left in the table. That file's own header
-- claims "the clears are no-ops on re-run", which is true only if nobody has
-- opted out since — the one assumption a CRM cannot make.
--
-- THE FIX
-- A ledger of what has already been applied. The workflow consults it, runs only
-- what is new, and records each success. Standard practice, and the reason this
-- class of bug is normally impossible.
--
-- Everything up to and including this file is seeded as ALREADY APPLIED. That is
-- the point: the historical one-shot data repairs (063 here, but also 074's lead
-- re-import, and 081/084/085/086 which overwrite sequence copy Sara may have
-- edited since) must never run a second time. They have already done their work.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

COMMENT ON TABLE public.schema_migrations IS
  'One row per applied migration file. .github/workflows/db-migrate.yml skips any file listed here. Seeded on the workflow''s first run with every file then on disk as already applied — those include one-shot data repairs that must not run twice (see db/063).';

-- The SEEDING is done by the workflow, not here, because it is the workflow
-- that knows the real filenames on disk. On its first run against an empty
-- ledger it records every file in this folder as already applied and stops —
-- which is correct, since the old always-run workflow had applied them all
-- many times over. From then on it applies only what is new.
