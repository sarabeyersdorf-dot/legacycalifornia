-- 080_expired_listing_sequence.sql
-- Per-lead subject-property fields + the 'expired_listing' sequence (4 verbatim
-- emails, delays Day 0 / 3.5 / 7 / 13, trigger_type='manual', mode:"literal").
-- The email's premium branded wrapper (logo header + headshot signature +
-- CAN-SPAM footer) is applied at send time by coldEmailHtml, so the copy no
-- longer carries a text signature. Idempotent.

alter table public.leads add column if not exists property_address text;
alter table public.leads add column if not exists property_city    text;

insert into public.sequences (name, description, trigger_type, steps, active)
select 'expired_listing',
       'Expired Listing outreach — 4 emails · 13 days · verbatim copy',
       'manual',
       $seed$[
  {
    "step_number": 1,
    "delay_hours": 0,
    "channel": "email",
    "mode": "literal",
    "subject_template": "What happened to {{property_address}}?",
    "preview_text": "Not another 'I can sell your home' email — an actual example.",
    "body_template": "{{greeting}}\n\nI noticed {{property_address}} came off the market recently. Homes in {{city}} don't usually go unsold because of the house — it's almost always what happened (or didn't happen) around it.\n\nRather than just introduce myself, I'd rather show you something: the real marketing campaign I built for a property in Murphys — an investor packet, buyer-specific pitches, professional photography and film, all working together instead of a sign in the yard.\n\nTake a look here: {{CASE_STUDY_URL}}\n\nIf your last listing didn't get this kind of push, I'd like to show you what I'd build for yours.\n\nP.S. No pressure — just take a look. If it's not for you, no hard feelings."
  },
  {
    "step_number": 2,
    "delay_hours": 84,
    "channel": "email",
    "mode": "literal",
    "subject_template": "The video that got 94,000 views",
    "preview_text": "Most listing videos get a few hundred views. Here's one that didn't.",
    "body_template": "{{greeting}}\n\nFollowing up on my last note — one piece of that campaign I wanted to point you to directly is the property film. It's sitting at over 94,000 views, which is the kind of reach a single yard sign or an MLS photo dump just can't touch.\n\nThe full case study also shows the investor packet and buyer-specific briefs I wrote for that listing — one for investors, one for a hospitality buyer, one for a lifestyle buyer. Same property, three different pitches, because no two buyers read a listing the same way.\n\nWorth five minutes: {{CASE_STUDY_URL}}\n\nIf {{property_address}} is still sitting with you, I'd like to walk it and tell you honestly what I'd do differently."
  },
  {
    "step_number": 3,
    "delay_hours": 168,
    "channel": "email",
    "mode": "literal",
    "subject_template": "Here's what you'd see as my seller",
    "preview_text": "A look at the seller portal I built myself — documents, timeline, and marketing stats in one place.",
    "body_template": "{{greeting}}\n\nOne more thing I wanted you to see, because it's usually the biggest complaint I hear about the last agent: not knowing what's actually happening.\n\nI built my own seller portal — every document, the full closing timeline, exactly what's needed from you and when, and marketing performance across every platform, all in one place, updated in real time. No chasing emails, no wondering how many people have actually seen your listing.\n\nYou can walk through a live sample here: {{CASE_STUDY_URL}} — scroll down and click \"Open a sample portal.\"\n\nIf {{property_address}} didn't sell, part of it may have simply been not knowing where things stood. That's not how I work."
  },
  {
    "step_number": 4,
    "delay_hours": 312,
    "channel": "email",
    "mode": "literal",
    "subject_template": "Should I stop reaching out?",
    "preview_text": "A quick, no-pressure close — either a yes or a clean goodbye.",
    "body_template": "{{greeting}}\n\nI've sent a few notes about {{property_address}} and don't want to clutter your inbox, so this is my last one for now.\n\nIf you're open to it, I'd like 15 minutes — by phone or in person — to walk the property, tell you honestly what I'd change, and show you the exact marketing plan I'd build for it.\n\nIf the timing's just not right, that's completely fine — reply \"not now\" and I won't follow up again until you're ready.\n\nP.S. You can reach me directly at (209) 559-4966 any time — real conversations beat email threads."
  }
]$seed$::jsonb,
       true
where not exists (select 1 from public.sequences where name = 'expired_listing');
