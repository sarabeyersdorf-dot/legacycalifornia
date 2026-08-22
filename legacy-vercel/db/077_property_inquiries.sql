-- 077_property_inquiries.sql
-- Investor-packet / property-inquiry captures from the public marketing pages
-- (first use: the 433 E Highway 4 showcase). One row per inquiry, carrying the
-- marketing ATTRIBUTION (utm_* + referrer + landing path) so we can tell which
-- tagged link actually produced a lead. Linked to the leads row the intake
-- endpoint creates.
--
-- Writes come from the server-side intake API (service role), never the browser,
-- so — exactly like leads / valuation_requests — RLS grants access to AGENTS
-- ONLY, with no public/anon read or write. That is stricter than an anon
-- insert-only policy and, importantly, it means bots can't POST straight to
-- Supabase around the API's honeypot + rate limit.

create table if not exists public.property_inquiries (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  lead_id      uuid references public.leads(id) on delete set null,
  property     text,          -- e.g. '433-e-highway-4-murphys'
  name         text,
  email        text,
  phone        text,
  message      text,
  utm_source   text,          -- marketing attribution, captured from the URL
  utm_medium   text,
  utm_campaign text,
  referrer     text,          -- document.referrer at submit time
  landing_path text,          -- path + query the visitor was on
  status       text not null default 'new'
);

create index if not exists property_inquiries_created_idx  on public.property_inquiries (created_at desc);
create index if not exists property_inquiries_property_idx on public.property_inquiries (property);

alter table public.property_inquiries enable row level security;

-- Agents (the CRM) can read/manage; mirrors leads_agent_all. No anon policy on
-- purpose — inserts arrive via the service-role API, which bypasses RLS, so the
-- table stays completely closed to the public.
drop policy if exists property_inquiries_agent_all on public.property_inquiries;
create policy property_inquiries_agent_all on public.property_inquiries
  for all using (public.current_role_is_agent()) with check (public.current_role_is_agent());
