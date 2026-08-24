-- db/082_showcase.sql
-- Showcase: a curated, swappable case-study gallery at /showcase.
--
-- Sara picks which of her real CRM deals to feature (Showcase tab in the CRM),
-- marks one as the hero, and orders them. The public /showcase page reads these
-- rows joined to the live `deals` row for address/price/photo, and the cold
-- Expired Listing email's {{CASE_STUDY_URL}} points here.
--
-- Agent-owned data: this table is NEVER written by the hourly deals crons, so
-- selections survive the sync cycle (same class as agent_overrides / party_details).
-- It only references `deals` — the display facts (address, city, prices, photo)
-- are read live from the deal at request time, so a re-synced deal stays correct.

create table if not exists showcase_deals (
  id             uuid        primary key default gen_random_uuid(),
  deal_id        uuid        references deals(id) on delete cascade,
  source_key     text,                         -- deal's stable business key (redundant anchor)
  featured       boolean     not null default false,   -- the hero case study (at most one)
  sort_order     integer     not null default 0,        -- display order within its group
  status         text,                          -- 'active' | 'sold'; null → derive from deal.stage
  blurb          text,                          -- one-line case-study story (agent-authored)
  photo_override text,                          -- optional hero photo (else deal photo)
  microsite_path text,                          -- e.g. '/433-e-highway-4-murphys'; null → sample portal
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One showcase entry per deal.
create unique index if not exists showcase_deals_deal_id_key on showcase_deals(deal_id);

-- Read path filters/sorts by these.
create index if not exists showcase_deals_featured_idx on showcase_deals(featured);
create index if not exists showcase_deals_order_idx    on showcase_deals(sort_order);

-- Seed the 433 E Highway 4 case study if that deal exists and isn't already
-- showcased — it already has a full marketing microsite to link to. Idempotent.
insert into showcase_deals (deal_id, source_key, featured, sort_order, status, blurb, microsite_path)
select d.id, d.source_key, true, 0,
       case when d.stage = 'closed' then 'sold' else 'active' end,
       null,
       '/433-e-highway-4-murphys'
from deals d
where (d.source_key ilike '%433%' or d.address ilike '433 %E%Highway 4%' or d.address ilike '433 %Hwy 4%')
  and not exists (select 1 from showcase_deals s where s.deal_id = d.id)
limit 1;
