-- =============================================================================
-- Legacy Properties — Supabase bootstrap (one-shot)
-- Phase 1A · v1.0
--
-- Paste this entire file into the Supabase SQL Editor and run once.
-- It combines, in the correct order:
--   1) schema.sql
--   2) rls_policies.sql
--   3) seed_sequences.sql
--
-- Safe to re-run: every statement is idempotent (if not exists / drop policy
-- if exists / on conflict do nothing).
-- =============================================================================

begin;

-- ##############################################################
-- # 1 / 3 — SCHEMA
-- ##############################################################

-- Required extensions
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- sequences (drip templates) — created first; leads.sequence_id references it
-- -----------------------------------------------------------------------------
create table if not exists public.sequences (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text not null,
  description   text,
  trigger_type  text check (trigger_type in ('new_lead','open_house','price_drop','radio_silence','manual')),
  steps         jsonb not null default '[]'::jsonb,
  active        boolean not null default true,
  reply_rate    numeric default 0
);

-- -----------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  first_name      text,
  last_name       text,
  email           text unique,
  phone           text,
  source          text check (source in ('website_form','open_house','referral','ihomefinder_idx','manual')),
  journey_stage   text check (journey_stage in ('discovering','narrowing','touring','ready_to_offer')),
  lead_type       text check (lead_type in ('buyer','seller','both','land','relocation')),
  score           integer not null default 0,
  temperature     text check (temperature in ('hot','warm','cold','new')) default 'new',
  assigned_agent  text check (assigned_agent in ('sara','james')) default 'sara',
  pipeline_stage  text check (pipeline_stage in ('new','nurture','touring','offer','close')) default 'new',
  price_min       integer,
  price_max       integer,
  areas           text[],
  must_haves      text[],
  notes           text,
  fub_id          text,
  last_contact_at timestamptz,
  sequence_id     uuid references public.sequences(id) on delete set null,
  sequence_step   integer not null default 0,
  sequence_paused boolean not null default false,
  status          text check (status in ('active','archived','converted')) not null default 'active'
);

create index if not exists leads_email_idx          on public.leads (email);
create index if not exists leads_pipeline_stage_idx on public.leads (pipeline_stage);
create index if not exists leads_temperature_idx    on public.leads (temperature);
create index if not exists leads_last_contact_idx   on public.leads (last_contact_at);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- lead_events
-- -----------------------------------------------------------------------------
create table if not exists public.lead_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  event_type  text not null check (event_type in (
                  'property_saved','property_viewed','search_run','form_submitted',
                  'email_opened','sms_replied','tour_booked','tour_completed',
                  'message_sent','score_change')),
  event_data  jsonb default '{}'::jsonb,
  source      text check (source in ('website','ihomefinder_idx','twilio','mailerlite','manual'))
);

create index if not exists lead_events_lead_idx on public.lead_events (lead_id, created_at desc);
create index if not exists lead_events_type_idx on public.lead_events (event_type);

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  lead_id             uuid not null references public.leads(id) on delete cascade,
  direction           text not null check (direction in ('inbound','outbound')),
  channel             text not null check (channel in ('sms','email')),
  body                text not null,
  subject             text,
  status              text not null check (status in ('draft','pending_approval','approved','sent','delivered','failed')) default 'draft',
  ai_generated        boolean not null default false,
  ai_draft_reasoning  text,
  approved_by         text check (approved_by in ('sara','james')),
  approved_at         timestamptz,
  twilio_sid          text,
  mailerlite_id       text
);

create index if not exists messages_lead_idx   on public.messages (lead_id, created_at desc);
create index if not exists messages_status_idx on public.messages (status);

-- -----------------------------------------------------------------------------
-- properties
-- -----------------------------------------------------------------------------
create table if not exists public.properties (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  mls_number            text unique,
  address               text,
  city                  text,
  state                 text default 'CA',
  zip                   text,
  price                 integer,
  bedrooms              integer,
  bathrooms             numeric,
  sq_ft                 integer,
  lot_acres             numeric,
  year_built            integer,
  property_type         text check (property_type in ('single_family','land','manufactured','condo','ranch','vineyard')),
  status                text check (status in ('active','pending','sold','off_market')) default 'active',
  listed_by             text check (listed_by in ('sara','james','other')),
  description           text,
  features              jsonb default '{}'::jsonb,
  fire_zone             text,
  hoa_monthly           integer,
  property_tax_annual   integer,
  photos                text[],
  ihomefinder_idx_id    text,
  price_history         jsonb default '[]'::jsonb
);

create index if not exists properties_status_idx on public.properties (status);
create index if not exists properties_city_idx   on public.properties (city);
create index if not exists properties_mls_idx    on public.properties (mls_number);

drop trigger if exists properties_set_updated_at on public.properties;
create trigger properties_set_updated_at
before update on public.properties
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- saved_properties
-- -----------------------------------------------------------------------------
create table if not exists public.saved_properties (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  lead_id         uuid not null references public.leads(id) on delete cascade,
  property_id     uuid not null references public.properties(id) on delete cascade,
  tag             text check (tag in ('favorite','maybe','for_james','too_pricey')),
  view_count      integer not null default 1,
  last_viewed_at  timestamptz not null default now(),
  unique (lead_id, property_id)
);

create index if not exists saved_properties_lead_idx on public.saved_properties (lead_id);

-- -----------------------------------------------------------------------------
-- tours
-- -----------------------------------------------------------------------------
create table if not exists public.tours (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  lead_id           uuid not null references public.leads(id) on delete cascade,
  property_id       uuid references public.properties(id) on delete set null,
  scheduled_at      timestamptz,
  duration_minutes  integer not null default 30,
  tour_type         text check (tour_type in ('in_person','video')) default 'in_person',
  status            text check (status in ('requested','confirmed','completed','cancelled')) default 'requested',
  agent             text check (agent in ('sara','james')) default 'sara',
  notes             text
);

create index if not exists tours_lead_idx       on public.tours (lead_id);
create index if not exists tours_scheduled_idx  on public.tours (scheduled_at);

-- -----------------------------------------------------------------------------
-- offers
-- -----------------------------------------------------------------------------
create table if not exists public.offers (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  property_id       uuid references public.properties(id) on delete set null,
  buyer_lead_id     uuid references public.leads(id) on delete set null,
  amount            integer,
  down_payment_pct  numeric,
  close_days        integer,
  contingencies     jsonb default '[]'::jsonb,
  status            text check (status in ('received','countered','accepted','rejected','withdrawn')) default 'received',
  lender            text,
  pre_approved      boolean default false,
  notes             text
);

create index if not exists offers_property_idx on public.offers (property_id);

-- -----------------------------------------------------------------------------
-- users (mirrors auth.users for app-level role)
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  role          text check (role in ('agent_sara','agent_james','buyer','seller','admin')) default 'buyer',
  lead_id       uuid references public.leads(id) on delete set null,
  display_name  text,
  avatar_url    text
);

-- Auto-provision public.users row when a new auth.users row is created
create or replace function public.handle_new_auth_user()
returns trigger as $$
begin
  insert into public.users (id, role, display_name)
  values (new.id, 'buyer', coalesce(new.raw_user_meta_data->>'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- ##############################################################
-- # 2 / 3 — ROW LEVEL SECURITY POLICIES
-- ##############################################################

-- Enable RLS on every public table
alter table public.sequences         enable row level security;
alter table public.leads             enable row level security;
alter table public.lead_events       enable row level security;
alter table public.messages          enable row level security;
alter table public.properties        enable row level security;
alter table public.saved_properties  enable row level security;
alter table public.tours             enable row level security;
alter table public.offers            enable row level security;
alter table public.users             enable row level security;

-- -----------------------------------------------------------------------------
-- Helper: is the current auth.uid() an agent?
-- -----------------------------------------------------------------------------
create or replace function public.current_role_is_agent()
returns boolean as $$
  select exists (
    select 1 from public.users
    where id = auth.uid()
      and role in ('agent_sara','agent_james','admin')
  );
$$ language sql stable security definer;

create or replace function public.current_lead_id()
returns uuid as $$
  select lead_id from public.users where id = auth.uid();
$$ language sql stable security definer;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
drop policy if exists users_self_read   on public.users;
drop policy if exists users_self_update on public.users;
drop policy if exists users_agent_all   on public.users;

create policy users_self_read   on public.users for select using (auth.uid() = id);
create policy users_self_update on public.users for update using (auth.uid() = id);
create policy users_agent_all   on public.users for all    using (public.current_role_is_agent());

-- -----------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------
drop policy if exists leads_agent_all on public.leads;
drop policy if exists leads_self_rw   on public.leads;

create policy leads_agent_all on public.leads for all
  using (public.current_role_is_agent());

create policy leads_self_rw on public.leads for all
  using (id = public.current_lead_id())
  with check (id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- lead_events
-- -----------------------------------------------------------------------------
drop policy if exists lead_events_agent_all on public.lead_events;
drop policy if exists lead_events_self_read on public.lead_events;

create policy lead_events_agent_all on public.lead_events for all
  using (public.current_role_is_agent());

create policy lead_events_self_read on public.lead_events for select
  using (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------
drop policy if exists messages_agent_all on public.messages;
drop policy if exists messages_self_read on public.messages;

create policy messages_agent_all on public.messages for all
  using (public.current_role_is_agent());

create policy messages_self_read on public.messages for select
  using (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- properties (public read of active, agent-only write)
-- -----------------------------------------------------------------------------
drop policy if exists properties_public_read on public.properties;
drop policy if exists properties_agent_all   on public.properties;

create policy properties_public_read on public.properties for select using (true);
create policy properties_agent_all   on public.properties for all
  using (public.current_role_is_agent());

-- -----------------------------------------------------------------------------
-- saved_properties
-- -----------------------------------------------------------------------------
drop policy if exists saved_agent_all on public.saved_properties;
drop policy if exists saved_self_rw   on public.saved_properties;

create policy saved_agent_all on public.saved_properties for all
  using (public.current_role_is_agent());

create policy saved_self_rw on public.saved_properties for all
  using (lead_id = public.current_lead_id())
  with check (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- tours
-- -----------------------------------------------------------------------------
drop policy if exists tours_agent_all on public.tours;
drop policy if exists tours_self_rw   on public.tours;

create policy tours_agent_all on public.tours for all
  using (public.current_role_is_agent());

create policy tours_self_rw on public.tours for all
  using (lead_id = public.current_lead_id())
  with check (lead_id = public.current_lead_id());

-- -----------------------------------------------------------------------------
-- offers (agent-only write; sellers can read offers on their property)
-- -----------------------------------------------------------------------------
drop policy if exists offers_agent_all   on public.offers;
drop policy if exists offers_seller_read on public.offers;

create policy offers_agent_all on public.offers for all
  using (public.current_role_is_agent());

-- Sellers see offers tied to properties where their user.lead_id maps to the
-- seller's property listing record. (Detailed seller→property mapping refined
-- in Phase 1F; for now, agent-only.)

-- -----------------------------------------------------------------------------
-- sequences (read-only for everyone authenticated; agent write)
-- -----------------------------------------------------------------------------
drop policy if exists sequences_authed_read on public.sequences;
drop policy if exists sequences_agent_all   on public.sequences;

create policy sequences_authed_read on public.sequences for select
  using (auth.uid() is not null);

create policy sequences_agent_all on public.sequences for all
  using (public.current_role_is_agent());

-- ##############################################################
-- # 3 / 3 — SEED DEFAULT SEQUENCES
-- ##############################################################

insert into public.sequences (name, description, trigger_type, steps, active)
values
-- 1. New buyer · slow drip — 7 steps · 14 days · Email + SMS
(
  'new_buyer_slow_drip',
  'New buyer · slow drip — 7 steps · 14 days · Email + SMS',
  'new_lead',
  '[
    {"step_number":1,"delay_hours":0,    "channel":"email","subject_template":"Welcome to Legacy, {{first_name}}","body_template":"Warm welcome, ask one open question about timing and area."},
    {"step_number":2,"delay_hours":24,   "channel":"sms",  "subject_template":null,"body_template":"Friendly nudge. One sentence. Ask what they have been looking at."},
    {"step_number":3,"delay_hours":72,   "channel":"email","subject_template":"A few worth a look","body_template":"Share 2-3 listings that fit their brief. Editorial framing, not a database dump."},
    {"step_number":4,"delay_hours":120,  "channel":"email","subject_template":"What I am hearing in {{area}}","body_template":"A short market read for their area of interest."},
    {"step_number":5,"delay_hours":168,  "channel":"sms",  "subject_template":null,"body_template":"Check in. Ask if a weekend tour makes sense."},
    {"step_number":6,"delay_hours":240,  "channel":"email","subject_template":"The honest part","body_template":"Sara voice: what to watch out for in their target town. No fluff."},
    {"step_number":7,"delay_hours":336,  "channel":"email","subject_template":"Still here when you are","body_template":"Soft close. No pressure. Door open."}
  ]'::jsonb,
  true
),
-- 2. Open house follow-up — 4 steps · 5 days · Email
(
  'open_house_follow_up',
  'Open house follow-up — 4 steps · 5 days · Email',
  'open_house',
  '[
    {"step_number":1,"delay_hours":4,   "channel":"email","subject_template":"Thanks for stopping in","body_template":"Thank-you, recap one specific thing about the home or them."},
    {"step_number":2,"delay_hours":24,  "channel":"email","subject_template":"The numbers on {{property_address}}","body_template":"Send price-per-sqft, comps, days-on-market in plain prose."},
    {"step_number":3,"delay_hours":72,  "channel":"email","subject_template":"Two more like it","body_template":"Two comparable active listings. One line each."},
    {"step_number":4,"delay_hours":120, "channel":"email","subject_template":"Worth another look?","body_template":"Offer a second showing or video walkthrough."}
  ]'::jsonb,
  true
),
-- 3. Past client · annual check-in — 3 steps · 365 days · Email
(
  'past_client_annual',
  'Past client · annual check-in — 3 steps · 365 days · Email',
  'manual',
  '[
    {"step_number":1,"delay_hours":0,    "channel":"email","subject_template":"A year in","body_template":"Anniversary of close. Personal note, no ask."},
    {"step_number":2,"delay_hours":4320, "channel":"email","subject_template":"Your home today","body_template":"Send an updated CMA / estimated value snapshot."},
    {"step_number":3,"delay_hours":8760, "channel":"email","subject_template":"Still your neighbor","body_template":"Annual touch. Mention something specific about their town."}
  ]'::jsonb,
  true
),
-- 4. Out-of-state buyer visit prep — 5 steps · 21 days · Email + SMS
(
  'out_of_state_visit_prep',
  'Out-of-state buyer visit prep — 5 steps · 21 days · Email + SMS',
  'new_lead',
  '[
    {"step_number":1,"delay_hours":0,   "channel":"email","subject_template":"Planning the visit","body_template":"Confirm dates, ask about flight times, what they want to see."},
    {"step_number":2,"delay_hours":72,  "channel":"email","subject_template":"Your draft itinerary","body_template":"Day-by-day plan with 6-8 homes blocked into half-day routes."},
    {"step_number":3,"delay_hours":240, "channel":"sms",  "subject_template":null,"body_template":"Quick logistics nudge. Lodging suggestion."},
    {"step_number":4,"delay_hours":408, "channel":"email","subject_template":"What to wear / drive","body_template":"Practical prep for mountain roads, fire-zone visits, etc."},
    {"step_number":5,"delay_hours":504, "channel":"sms",  "subject_template":null,"body_template":"Day-before confirm. Pickup or meet point."}
  ]'::jsonb,
  true
),
-- 5. Seller pre-listing nurture — 6 steps · 30 days · Email
(
  'seller_pre_listing_nurture',
  'Seller pre-listing nurture — 6 steps · 30 days · Email',
  'new_lead',
  '[
    {"step_number":1,"delay_hours":0,    "channel":"email","subject_template":"What your home is worth today","body_template":"Initial value range with two-line reasoning."},
    {"step_number":2,"delay_hours":120,  "channel":"email","subject_template":"What buyers are actually paying for","body_template":"Three concrete features driving offers in their town this quarter."},
    {"step_number":3,"delay_hours":240,  "channel":"email","subject_template":"Two weeks of prep work","body_template":"Pre-list checklist. Specific items. No platitudes."},
    {"step_number":4,"delay_hours":360,  "channel":"email","subject_template":"The cost of waiting","body_template":"Show seasonality / inventory math for their micro-market."},
    {"step_number":5,"delay_hours":480,  "channel":"email","subject_template":"How Legacy lists differently","body_template":"Editorial-first listing positioning. Concrete examples."},
    {"step_number":6,"delay_hours":720,  "channel":"email","subject_template":"Ready when you are","body_template":"Soft close. Offer 30-min walkthrough call."}
  ]'::jsonb,
  true
),
-- 6. Price-drop revival — 2 steps · 1 day · SMS-first
(
  'price_drop_revival',
  'Price-drop revival — 2 steps · 1 day · SMS-first',
  'price_drop',
  '[
    {"step_number":1,"delay_hours":0,  "channel":"sms",  "subject_template":null,"body_template":"Brief SMS: the home they saved just dropped to {{new_price}}. One line."},
    {"step_number":2,"delay_hours":18, "channel":"email","subject_template":"{{property_address}} — new number","body_template":"Re-share listing with new price + comp framing."}
  ]'::jsonb,
  true
),
-- 7. Cold buyer · 90-day re-engage — 3 steps · 14 days · Email
(
  'cold_buyer_reengage',
  'Cold buyer · 90-day re-engage — 3 steps · 14 days · Email',
  'radio_silence',
  '[
    {"step_number":1,"delay_hours":0,   "channel":"email","subject_template":"Still looking?","body_template":"Honest, no-pressure check-in. One specific question about timing."},
    {"step_number":2,"delay_hours":168, "channel":"email","subject_template":"{{area}} in the last 90 days","body_template":"What sold, what stalled. Short read."},
    {"step_number":3,"delay_hours":336, "channel":"email","subject_template":"Last note","body_template":"Polite final touch. Door open if and when."}
  ]'::jsonb,
  true
)
on conflict do nothing;

commit;

-- Done. Verify with:  select count(*) from public.sequences;  -- expect 7
