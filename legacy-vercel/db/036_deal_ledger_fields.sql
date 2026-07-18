-- 036_deal_ledger_fields.sql
-- Additive fields for the Deal Ledger view (crm.html "deals" section).
--
-- These are agent-set display/control fields with NO equivalent in
-- deals.json, so api/cron/sync-deals.js's update payload never touches them
-- (it only writes the specific columns it maps — see mapDeal() in
-- api/cron/sync-deals.js) — safe from being clobbered by the daily sync,
-- same reasoning as stage_override in db/024.
--
-- client_label  — plain display name for "whose deal is this" on the Ledger.
--                 Deliberately NOT the deal_parties/leads link (that's the
--                 identity chain behind client portal login — see db/015 +
--                 crm-link-deal-party.js) — this is display-only.
-- waiting_on    — who the ball is in the court of, agent-set (no default
--                 guess). One of: you | lender | inspector | coagent |
--                 client | escrowco | null (unset).
-- portal_shared — simple per-deal "share on client portal" flag, set from
--                 the Ledger. Independent of the granular per-item
--                 visibility system (db/015, crm-deal-visibility.js) — that
--                 system requires a linked client (deal_parties) to know
--                 what to share; this flag doesn't, so it stays honest for
--                 deals with no client linked yet. Wiring this into the
--                 actual client-facing portal read path is future work
--                 (the Command Center / Shared Visibility screens).
--
-- Additive + idempotent. No live route changes here. Safe to re-run.

alter table public.deals add column if not exists client_label text;
alter table public.deals add column if not exists waiting_on text
  check (waiting_on in ('you','lender','inspector','coagent','client','escrowco') or waiting_on is null);
alter table public.deals add column if not exists portal_shared boolean not null default false;
