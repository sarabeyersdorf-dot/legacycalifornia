-- 016_document_urls.sql
-- Link seller-portal documents to their executed files.
--
-- deal_documents gains a doc_url column holding the URL of the executed
-- (signed) document. The seller portal renders a View / Download link for any
-- document that has one. Documents without a url still show as before (name +
-- status), just without a link.
--
-- The URL should point at the executed file (a signed link into your
-- transaction/e-sign system, or a file in storage). Because the portal is
-- behind an unguessable private-link token and only client_safe documents
-- surface, prefer signed/expiring URLs for anything sensitive.
--
-- Safe to run multiple times.

alter table public.deal_documents add column if not exists doc_url text;
