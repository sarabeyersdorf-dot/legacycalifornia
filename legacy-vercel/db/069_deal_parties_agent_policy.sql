-- db/069_deal_parties_agent_policy.sql
-- Fix: "new row violates row-level security policy for table deal_parties".
--
-- deal_parties has RLS ENABLED but no policy → default-DENY, so the agent-only
-- link handler (/api/crm/link-deal-party, which authorizes with isAgent() in
-- code) can't insert a party. The API writes with the server Supabase client,
-- which in this deployment RESPECTS RLS and carries no end-user JWT — so a
-- policy keyed on current_role_is_agent() (auth.uid()) can never be satisfied
-- from the server. Every other table the CRM writes through this client
-- (deals, appointments, deal_documents…) simply has RLS off, and the app's real
-- authorization is the isAgent() gate in each handler.
--
-- Bring deal_parties in line: turn RLS off (it's an internal join table only
-- written by the agent handler; the seller portal reads it via the SECURITY
-- DEFINER portal_items(), which is unaffected either way). Also drop the stray
-- policy name in case a prior attempt created it.
--
-- NOTE: the cleaner long-term posture is to set a real Supabase service-role /
-- secret key in Vercel (SUPABASE_SERVICE_KEY) so the server client bypasses RLS,
-- then re-enable RLS across these tables. Until that's done, this matches the
-- deployment's existing model.

drop policy if exists deal_parties_agent_all on public.deal_parties;
alter table public.deal_parties disable row level security;
