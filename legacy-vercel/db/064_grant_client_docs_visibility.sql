-- 064_grant_client_docs_visibility.sql
-- Companion to the sync-deals fix (clientDocuments default to client-visible).
--
-- The seller/buyer portal reads document visibility from
-- deal_document_governance; no grant = agent_only = hidden. Curated
-- `clientDocuments` (deals.json) never carried a visibility, so they seeded no
-- grant and the client saw 0 documents (324 Augusta). The code fix defaults them
-- to the client side of the deal on every sync (insert-only). This migration is
-- the ONE-TIME backfill for docs already in the table, so they don't have to
-- wait for the next hourly sync.
--
-- SAFE:
--   * only transaction-scoped docs (the clientDocuments path's default scope);
--     property-scoped compliance disclosures are NOT touched.
--   * only docs with NO existing governance row — an agent's explicit choice
--     (including a deliberate agent_only) is never overwritten.
--   * visibility follows the deal side (seller for listing/seller, buyer for
--     buyer, both for dual) — exactly what the code seeds.
-- Idempotent (re-running inserts nothing new).

insert into public.deal_document_governance (deal_id, doc_key, visibility, doc_fingerprint)
select dd.deal_id,
       dd.doc_key,
       case
         when d.side = 'buyer' then 'buyer'
         when d.side = 'both'  then 'both'
         else                       'seller'
       end as visibility,
       lower(btrim(dd.name)) as doc_fingerprint
from public.deal_documents dd
join public.deals d on d.id = dd.deal_id
where dd.scope = 'transaction'
  and dd.doc_key is not null
  and not exists (
    select 1 from public.deal_document_governance g
    where g.deal_id = dd.deal_id and g.doc_key = dd.doc_key
  );
