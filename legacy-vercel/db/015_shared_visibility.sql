-- 015_shared_visibility.sql
-- Shared-visibility foundation (adapted to THIS schema, not the spec's names).
-- One row, filtered views: CRM sees all; a client sees a row only when it is
-- visibility='client' (docs already use client_safe) AND belongs to them.
--
-- Mapping to the spec:
--   spec 'contacts'  -> public.leads      (portal_token + roles added here)
--   spec 'tasks'     -> public.agent_tasks (+ lead_id link, visibility, client_label)
--   spec 'events'    -> public.tours + public.appointments (visibility, client_label)
--   spec 'documents' -> public.deal_documents (client_safe already = visibility; +client_label)
--   spec 'activities'-> public.lead_events / messages  → NEVER shared (untouched)
--
-- Additive + idempotent. No live route changes here. Safe to re-run.

-- 1. Leads become the client "contact": private-link token + roles ----------
alter table public.leads add column if not exists portal_token uuid unique default gen_random_uuid();
alter table public.leads add column if not exists roles text[];

-- Backfill a portal_token for any existing lead that lacks one.
update public.leads set portal_token = gen_random_uuid() where portal_token is null;

-- Backfill roles from what we already know (deal_side + pipeline_stage).
update public.leads set roles = (
  case
    when deal_side = 'both'   then array['buyer','seller']
    when deal_side = 'buyer'  then array['buyer']
    when deal_side = 'seller' then array['seller']
    else array[]::text[]
  end
  || case when pipeline_stage in ('closed','sphere') then array['past_client'] else array[]::text[] end
) where roles is null;

create index if not exists leads_portal_token_idx on public.leads (portal_token);

-- 2. Tasks: link to a client + visibility -----------------------------------
alter table public.agent_tasks add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.agent_tasks add column if not exists visibility text not null default 'internal'
  check (visibility in ('internal','client'));
alter table public.agent_tasks add column if not exists client_label text;

-- 3. Events: tours + appointments -------------------------------------------
alter table public.tours add column if not exists visibility text not null default 'internal'
  check (visibility in ('internal','client'));
alter table public.tours add column if not exists client_label text;

alter table public.appointments add column if not exists visibility text not null default 'internal'
  check (visibility in ('internal','client'));
alter table public.appointments add column if not exists client_label text;

-- 4. Documents already gate on client_safe; add friendlier wording ----------
alter table public.deal_documents add column if not exists client_label text;

-- 5. contact_actions — the dropdown registry (SSOT; add an action = insert) --
create table if not exists public.contact_actions (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,
  action_group       text not null,   -- 'communicate' | 'schedule' | 'market' | 'transact'
  endpoint           text not null,
  roles              text[] not null, -- who sees it: {'seller'}, {'buyer'}, {'buyer','seller','past_client'}
  stages             text[],          -- null = all stages
  default_visibility text not null default 'internal',
  sort_order         int not null default 100,
  active             boolean not null default true
);

-- Seed starter actions (endpoints point at existing routes where they exist;
-- stages left null for v1 to avoid mis-mapping our pipeline keys — refine later).
insert into public.contact_actions (label, action_group, endpoint, roles, default_visibility, sort_order)
select * from (values
  ('Send text',           'communicate', '/api/crm/message',        array['buyer','seller','past_client'], 'internal', 10),
  ('Send email',          'communicate', '/api/crm/message',        array['buyer','seller','past_client'], 'internal', 20),
  ('Log a call',          'communicate', '/api/crm/note',           array['buyer','seller','past_client'], 'internal', 30),
  ('Start sequence',      'communicate', '/api/sequences/enroll',   array['buyer','seller'],               'internal', 40),
  ('Create task',         'schedule',    '/api/crm/create-lead',    array['buyer','seller','past_client'], 'internal', 50),
  ('Book appointment',    'schedule',    '/api/crm/calendar',       array['buyer','seller'],               'client',   60),
  ('Schedule inspection', 'schedule',    '/api/crm/calendar',       array['seller'],                       'client',   70),
  ('Schedule photographer','schedule',   '/api/crm/calendar',       array['seller'],                       'internal', 80),
  ('Generate CMA',        'market',      '/api/curate/valuations',  array['seller'],                       'internal', 90),
  ('Send seller report',  'market',      '/api/crm/message',        array['seller'],                       'client',   100),
  ('Create curated search','market',     '/api/curate/collections', array['buyer'],                        'client',   110),
  ('Assign to agent',     'transact',    '/api/crm/broker',         array['buyer','seller','past_client'], 'internal', 120),
  ('Copy portal link',    'transact',    'copy-portal-link',        array['buyer','seller'],               'internal', 130),
  ('Request review',      'transact',    '/api/crm/message',        array['past_client'],                  'client',   140)
) as v(label, action_group, endpoint, roles, default_visibility, sort_order)
where not exists (select 1 from public.contact_actions);

alter table public.contact_actions enable row level security;
drop policy if exists contact_actions_read on public.contact_actions;
create policy contact_actions_read on public.contact_actions
  for select to authenticated using (true);

-- 6. portal_items(token) — the ONLY read path for the private-link portal.
--    SECURITY DEFINER: filters by token + visibility inside the DB, so an
--    internal row can never surface even if a portal page has a bug. An invalid
--    token returns zero rows (nothing to probe).
create or replace function public.portal_items(p_token uuid)
returns table (item_type text, item_id uuid, title text, when_at timestamptz, meta jsonb)
language sql
security definer
set search_path = public
as $$
  with c as (
    select id from public.leads where portal_token = p_token
  ),
  d as (
    select dp.deal_id from public.deal_parties dp join c on dp.lead_id = c.id
  )
  -- Tasks tied to this client, marked client-visible
  select 'task'::text, t.id, coalesce(t.client_label, t.title), t.created_at,
         jsonb_build_object('done', t.done)
    from public.agent_tasks t join c on t.lead_id = c.id
   where t.visibility = 'client'
  union all
  -- Events: tours
  select 'event', e.id, coalesce(e.client_label, initcap(e.tour_type) || ' tour'), e.scheduled_at,
         jsonb_build_object('status', e.status)
    from public.tours e join c on e.lead_id = c.id
   where e.visibility = 'client'
  union all
  -- Events: appointments
  select 'event', a.id, coalesce(a.client_label, a.title), a.starts_at,
         jsonb_build_object('location', a.location)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
  union all
  -- Documents on this client's deal(s), client-safe only
  select 'document', doc.id, coalesce(doc.client_label, doc.name), doc.updated_at,
         jsonb_build_object('status', doc.status)
    from public.deal_documents doc join d on doc.deal_id = d.deal_id
   where doc.client_safe = true;
$$;

-- The portal calls this with an unguessable token; the function does the
-- filtering, so granting execute is safe.
grant execute on function public.portal_items(uuid) to anon, authenticated;
