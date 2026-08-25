-- 085_speed_to_lead_sequence.sql
-- The 'speed_to_lead' sequence: a single instant auto-reply sent the moment a new
-- website lead comes in (via /api/leads/intake), so every inquiry gets an
-- immediate, human-sounding acknowledgement while Sara or James follows up
-- personally. Unlike the cron-driven sequences, this one is NOT enrolled and NOT
-- ticked by the hourly cron — the intake handler sends step 1 inline for true
-- speed. This row exists so the copy is editable (and AI-suggestable) in the CRM
-- Sequences editor, exactly like the expired sequence. Idempotent.
--
-- This is a SOLICITED reply to someone who just contacted us, so it uses the warm
-- branded wrapper (signature, no cold "not a solicitation" disclaimer), applied
-- at send time. trigger_type 'new_lead' is the allowed enum value for this.

insert into public.sequences (name, description, trigger_type, steps, active)
select 'speed_to_lead',
       'Speed to Lead — instant auto-reply the moment a new website lead comes in',
       'new_lead',
       $seed$[
  {
    "step_number": 1,
    "delay_hours": 0,
    "channel": "email",
    "mode": "literal",
    "subject_template": "Thanks for reaching out to Legacy Properties",
    "preview_text": "Your message reached Sara and James. A real person will follow up shortly.",
    "body_template": "{{greeting}}\n\nThank you for reaching out through legacycalifornia.com. Your message came straight to Sara and James.\n\nThis is a quick automatic note so you know it arrived safely. One of us will personally follow up shortly, usually within a few hours during the day.\n\nIf it is time sensitive, you can call or text Sara directly at (209) 559-4966. We look forward to helping you."
  }
]$seed$::jsonb,
       true
where not exists (select 1 from public.sequences where name = 'speed_to_lead');

-- Mark it auto (informational; the editor reads send_mode for its labels). This
-- sequence is never cron-ticked, so send_mode has no effect on delivery.
update public.sequences set send_mode = 'auto'
where name = 'speed_to_lead' and coalesce(send_mode, '') <> 'auto';
