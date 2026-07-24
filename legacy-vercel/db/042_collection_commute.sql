-- 042_collection_commute.sql
-- Per-collection commute option for curated searches. When show_commute is on
-- and commute_dest (the client's work/school address) is set, the client's
-- curated page shows each listing's drive time to that destination — powered by
-- /api/commute (Sara's real-log times for the foothill towns, or a routing
-- provider statewide once a key is configured).

alter table public.curated_collections add column if not exists show_commute boolean not null default false;
alter table public.curated_collections add column if not exists commute_dest  text;

comment on column public.curated_collections.show_commute is 'Show per-listing drive time to commute_dest on the client curated page.';
comment on column public.curated_collections.commute_dest is 'Client commute destination (work/school address) for the curated commute readout.';
