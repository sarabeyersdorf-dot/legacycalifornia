-- 045_appointment_multiday.sql
-- Multi-day / all-day events (e.g. a holiday or a block spanning several days).
-- `all_day` marks the event as spanning whole days; `ends_at` is the last day
-- it covers (inclusive). Single timed events leave both null and behave exactly
-- as before.
--
-- Safe to run more than once.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS all_day boolean DEFAULT false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ends_at  timestamptz;
