-- 046_appointment_kinds_walkthrough_appraisal.sql
-- Adds two calendar event types the agents asked for: 'walkthrough' (final
-- buyer walkthrough) and 'appraisal'. Widens the appointments.kind CHECK to
-- include them alongside the existing set from 027.
--
-- Safe to run repeatedly.

-- Drop any existing CHECK on `kind` (name-agnostic — same approach as 027),
-- then re-add the widened one.
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
    'listing_appt', 'showing', 'follow_up', 'inspection',
    'walkthrough', 'appraisal'
  ));

-- Verify:  select kind, count(*) from public.appointments group by 1 order by 1;
