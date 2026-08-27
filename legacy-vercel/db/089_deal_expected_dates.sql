-- 089_deal_expected_dates.sql
-- SPEC · Cowork → Claude Code · 2026-08-27 · Agent-editable CRM, §3 (confirmed vs expected dates)
--
-- A two-tier truth model for client-facing dates. An agent often KNOWS a date has
-- moved days before the executed document exists; today there is nowhere to put
-- that knowledge but a note, so it is lost or — worse — reaches a client page
-- unverified.
--
--   confirmed  = the base column (coe_date, acceptance_date). Executed document on
--                file. The current meaning today. Unchanged — every existing reader
--                (seller/buyer portals, the calendar/contingency math, ~8 consumers)
--                keeps working with NO migration, because this is purely ADDITIVE.
--   expected   = an agent believes it. Carries who, when, and why.
--
-- ABSOLUTE RULES (enforced in code, documented here):
--   1. A client portal renders CONFIRMED values only. An _expected value NEVER
--      reaches a seller or buyer page. Portal queries do not select these columns.
--   2. The internal agenda / briefing use _expected where present, labelled with
--      source ("COE 9/12 — expected, James 8/27, lender verbal").
--   3. Promotion: when the confirmed value catches up to the expected value (the
--      executed doc landed and sync wrote coe_date), sync-deals CLEARS the expected
--      overlay and logs the promotion. Disagreement (confirmed != expected) is kept
--      as a discrepancy for the agenda, never a silent overwrite.
--
-- AGENT-OWNED: like agent_overrides / party_details, these columns are NEVER written
-- by mapDeal / sync-deals' upsert, so they survive the hourly rebuild. Only the
-- /api/crm/deal-dates endpoint (agent session) writes them, and only the promotion
-- pass clears them.

alter table public.deals
  add column if not exists coe_date_expected             date,
  add column if not exists coe_date_expected_by          text,
  add column if not exists coe_date_expected_at          timestamptz,
  add column if not exists coe_date_expected_note        text,
  add column if not exists acceptance_date_expected      date,
  add column if not exists acceptance_date_expected_by   text,
  add column if not exists acceptance_date_expected_at   timestamptz,
  add column if not exists acceptance_date_expected_note text;

-- Audit trail (SPEC §5.2). deal_activity is a display feed; this is the real log —
-- who changed what, from what, when — so "who set this COE and when" is answerable.
-- Append-only, agent-only, NEVER shown to a client.
create table if not exists public.deal_audit (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid references public.deals(id) on delete cascade,
  field       text not null,          -- e.g. 'coe_date_expected'
  old_value   text,
  new_value   text,
  changed_by  text,                   -- 'sara' | 'james' | 'system'
  source      text,                   -- 'crm' | 'promotion' | 'sync'
  note        text,
  changed_at  timestamptz not null default now()
);
create index if not exists deal_audit_deal_idx on public.deal_audit(deal_id, changed_at desc);
