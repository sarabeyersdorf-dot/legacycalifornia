-- 027_appointment_event_types.sql
-- Richer CRM calendar events. Widens appointments.kind for the agent's real
-- event types and adds an inspection sub-type.
--
-- New kinds: listing_appt, showing, follow_up, inspection (kept alongside the
-- existing call/block/open/meeting). `sub_kind` holds the inspection type —
-- 'Home' | 'Pest' | 'Roof' | 'Well & Septic', or free text for "Other" — and is
-- null for every other kind.
--
-- Safe to run repeatedly.

-- 1. Drop any existing CHECK on `kind` (name-agnostic — the table was created
--    ad-hoc, so we don't assume the constraint's name), then re-add a widened
--    one. If no such constraint exists this simply does nothing.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class      rel on rel.oid = con.conrelid
      join pg_namespace  nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'appointments'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.appointments drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.appointments
  add constraint appointments_kind_check
  check (kind in (
    'call', 'block', 'open', 'meeting',
    'listing_appt', 'showing', 'follow_up', 'inspection'
  ));

-- 2. Inspection sub-type (nullable; free text so "Other" can carry a label).
alter table public.appointments add column if not exists sub_kind text;

-- Verify:  select kind, sub_kind, count(*) from public.appointments group by 1,2;
