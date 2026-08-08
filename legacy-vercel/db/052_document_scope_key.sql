-- 052_document_scope_key.sql
-- Portal document model, part 1: SCOPE + a STABLE KEY on every document row.
-- (Companion spec: SPEC_portal_document_model.md.)
--
-- Two additive columns on deal_documents:
--
--   * scope   — 'property' | 'transaction'. File-authored in deals.json and
--               carried through the hourly rebuild. A `property` doc (RLA, MOT,
--               TDS, SPQ, NHD, FIRPTA…) survives a failed escrow and follows the
--               property to the next buyer; a `transaction` doc (RPA, counters,
--               addenda, CR, commission demand) is archived with its escrow.
--               Default 'transaction' is the CONSERVATIVE choice: an
--               unclassified doc is archived with the escrow, never wrongly
--               persisted onto a future buyer's file.
--
--   * doc_key — a STABLE per-document key, `<deal>-<slug>` (e.g. 433-tds,
--               baldwin-rpa), the same convention as the Taskflow Contract's
--               task keys. This is the join handle the hourly rebuild currently
--               lacks: deal_documents is a blind DELETE+INSERT with a fresh row
--               id each run, so without a stable key there is nothing to hang
--               agent-owned governance (visibility) off of. See db/053.
--
-- Both are additive and idempotent. Safe to re-run.

alter table public.deal_documents
  add column if not exists scope text not null default 'transaction'
    check (scope in ('property', 'transaction'));

alter table public.deal_documents
  add column if not exists doc_key text;

-- The (deal_id, doc_key) pair is how governance rows and the read path find a
-- document across the hourly rebuild. Not UNIQUE here on purpose: a document may
-- legitimately appear as two versions (a property-scope original and a
-- transaction-scope acknowledgment) sharing a key — see the versioning work in
-- a later migration. The governance table is what enforces one grant per key.
create index if not exists deal_documents_deal_key_idx
  on public.deal_documents (deal_id, doc_key);
