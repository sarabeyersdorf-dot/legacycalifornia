-- 020_deals_rls_policy.sql
-- deals / deal_documents were never added to rls_policies.sql, but RLS got
-- enabled on them (Supabase enables RLS by default on dashboard-created
-- tables). With RLS ON and NO policy, every read through the app's role returns
-- ZERO rows — which is why the CRM Deals/Listings views showed 0 even though
-- the sync wrote 25 (the sync + seller portal use the service role, which
-- bypasses RLS). This adds the same agent policy the other tables have, so the
-- CRM can read deals exactly like it reads leads.
--
-- Access model (matches leads/messages/etc.):
--   * agents (current_role_is_agent()) — full access
--   * the client portal already reads server-side via the service role, which
--     bypasses RLS, so no per-client policy is required here.
--
-- Safe to run repeatedly.

-- deals ----------------------------------------------------------------------
alter table public.deals enable row level security;
drop policy if exists deals_agent_all on public.deals;
create policy deals_agent_all on public.deals for all
  using (public.current_role_is_agent());

-- deal_documents -------------------------------------------------------------
alter table public.deal_documents enable row level security;
drop policy if exists deal_documents_agent_all on public.deal_documents;
create policy deal_documents_agent_all on public.deal_documents for all
  using (public.current_role_is_agent());
