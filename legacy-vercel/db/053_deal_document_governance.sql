-- 053_deal_document_governance.sql
-- Portal document model, part 2: VISIBILITY governance that the hourly rebuild
-- CANNOT touch. (Companion spec: SPEC_portal_document_model.md.)
--
-- The problem this solves:
--   deal_documents is rebuilt every hour by sync-deals — a blind
--   DELETE WHERE deal_id + INSERT (sync-deals.js). Its client_safe flag (the
--   visibility gate today, from db/015) DEFAULTS TRUE — i.e. it fails OPEN — and
--   is recomputed from the file on every run. So if an agent set visibility in
--   the CRM, the next sync would silently overwrite it, and a document could
--   silently become seller-visible again. A document going seller-visible by
--   accident is a compliance incident; going agent_only by accident is a shrug.
--   The design MUST fail closed.
--
-- The fix:
--   Visibility lives in THIS table, which sync-deals never writes. The read path
--   LEFT JOINs on (deal_id, doc_key) and DEFAULTS TO agent_only on any miss.
--   The rebuild physically cannot flip a document open, because it cannot write
--   here. Widening visibility is an explicit CRM action (crm/document-visibility)
--   or an insert-only seed authored in deals.json — never an inference.
--
-- Fail-open guard (the ONE way this design could leak — key reuse):
--   If a retired doc_key is later assigned to a DIFFERENT document, that document
--   would inherit the old key's governance row and its visibility. We guard with
--   a content fingerprint captured at grant time: the read path honors a grant
--   only when the current document's fingerprint still matches. A reused key
--   pointing at a differently-named document fails the match → agent_only.
--
-- Additive + idempotent. No data migration: the ABSENCE of a governance row IS
-- "agent_only", so on deploy every existing document defaults to agent_only
-- (the SPEC's "migrate everything to agent_only, re-grant deliberately"). No
-- client is on a portal yet, so nothing breaks; grants are added deliberately.

create table if not exists public.deal_document_governance (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references public.deals(id) on delete cascade,
  doc_key         text not null,
  visibility      text not null default 'agent_only'
                    check (visibility in ('agent_only', 'seller', 'buyer', 'both')),
  -- Normalized name captured when the grant was made. The read path requires it
  -- to still match the current document, so a reused key can't inherit a grant.
  doc_fingerprint text,
  -- 'agent' (a CRM toggle) or 'seed' (an insert-only deals.json seed). A seed
  -- never overwrites an agent grant; an agent grant always wins.
  set_by          text not null default 'agent',
  set_at          timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- One grant per (deal, doc_key). Widening/narrowing UPDATEs this row.
create unique index if not exists deal_document_governance_key
  on public.deal_document_governance (deal_id, doc_key);

create index if not exists deal_document_governance_deal_idx
  on public.deal_document_governance (deal_id);

-- Retired keys are permanently burned (Taskflow Contract convention). Recording
-- a retirement lets a later guard flag an attempt to reuse a key for a new doc.
create table if not exists public.retired_document_keys (
  deal_id    uuid not null,
  doc_key    text not null,
  retired_at timestamptz not null default now(),
  primary key (deal_id, doc_key)
);
