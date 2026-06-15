-- =============================================================================
-- Legacy Properties — Supabase schema
-- Phase 1A · v1.0
--
-- Run order in Supabase SQL editor:
--   1) schema.sql           (this file)
--   2) rls_policies.sql
--   3) seed_sequences.sql
--
-- Notes:
--   - All primary keys are uuid (default gen_random_uuid()).
--   - timestamptz everywhere; default now().
--   - `sequences` is created BEFORE `leads` because leads.sequence_id references it.
-- =============================================================================

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
