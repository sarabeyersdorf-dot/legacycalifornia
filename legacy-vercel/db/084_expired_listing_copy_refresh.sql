-- 084_expired_listing_copy_refresh.sql
-- Refreshed STARTING copy for the 'expired_listing' 4-email sequence.
-- Same structure and timing as db/080 (Day 0 / 3.5 / 7 / 13, all email,
-- mode:"literal"), tightened into Sara's voice — short sentences, no em-dashes,
-- no hype — and aligned to the current 433 E Highway 4 showcase. Email 1 still
-- holds for approval; 2-4 auto-send, stopping on any reply. The branded wrapper
-- (logo header, headshot, CAN-SPAM + not-a-solicitation footer) is added at send
-- time by coldEmailHtml, so the copy carries no signature or disclaimer.
--
-- SAFE / NON-CLOBBERING. This rewrites the copy ONLY while it is still the
-- untouched original db/080 seed, detected by a phrase unique to that seed
-- ("buyer-specific pitches, professional photography and film"). The moment Sara
-- edits any Email 1 in the CRM, that phrase is gone and this update is skipped,
-- so re-running the full migration set never overwrites her wording. It is also
-- idempotent: after it applies once, the phrase is gone and later runs are no-ops.

update public.sequences
set steps = $seed$[
  {
    "step_number": 1,
    "delay_hours": 0,
    "channel": "email",
    "mode": "literal",
    "subject_template": "What happened with {{property_address}}?",
    "preview_text": "Not another 'I can sell your home' email. An actual example of the work.",
    "body_template": "{{greeting}}\n\nI saw that {{property_address}} recently came off the market without selling.\n\nIn {{city}}, that usually isn't about the house. It's about what happened around it, or didn't. The marketing, the reach, the story a buyer needed and never got.\n\nSo instead of introducing myself, I'd rather just show you the work. Here is a real campaign I built for a home right here in the area: a cinematic film, its own website, an investor packet, and buyer-specific briefs, all pointed at the right buyer.\n\nTake a look: {{CASE_STUDY_URL}}\n\nIf your last listing didn't get this kind of push, I'd like to show you what I'd build for yours. No pressure. If it isn't for you, no hard feelings."
  },
  {
    "step_number": 2,
    "delay_hours": 84,
    "channel": "email",
    "mode": "literal",
    "subject_template": "The film that got 94,000 views",
    "preview_text": "Most listing videos get a few hundred. This one didn't.",
    "body_template": "{{greeting}}\n\nFollowing up on my last note with one piece of that campaign worth seeing on its own: the property film.\n\nIt's past 94,000 views. That is reach a yard sign and a set of MLS photos simply can't touch.\n\nThe same case study shows the investor packet and the buyer briefs I wrote for that listing. One for investors, one for a hospitality buyer, one for a lifestyle buyer. One property, three pitches, because no two buyers read a home the same way.\n\nWorth five minutes: {{CASE_STUDY_URL}}\n\nIf {{property_address}} is still sitting with you, I'd walk it and tell you honestly what I'd do differently."
  },
  {
    "step_number": 3,
    "delay_hours": 168,
    "channel": "email",
    "mode": "literal",
    "subject_template": "Here's what you'd see as my seller",
    "preview_text": "The live seller portal I built. Documents, timeline, and marketing stats in one place.",
    "body_template": "{{greeting}}\n\nOne more thing I wanted you to see, because it is the complaint I hear most about the last agent: not knowing what is actually happening.\n\nI built my own seller portal. Every document, the full closing timeline, exactly what's needed from you and when, and your marketing numbers across every platform. All in one place, updated in real time. No chasing emails to find out where things stand.\n\nYou can walk through a live sample here: {{CASE_STUDY_URL}}. Scroll down and click \"Open a sample portal.\"\n\nIf {{property_address}} didn't sell, part of it may have simply been not knowing where things stood. That isn't how I work."
  },
  {
    "step_number": 4,
    "delay_hours": 312,
    "channel": "email",
    "mode": "literal",
    "subject_template": "Should I stop reaching out?",
    "preview_text": "A short, no-pressure close. Either a yes, or a clean goodbye.",
    "body_template": "{{greeting}}\n\nI've sent a few notes about {{property_address}}, and I don't want to clutter your inbox, so this is my last one for now.\n\nIf you're open to it, I'd like 15 minutes, by phone or in person, to walk the property, tell you honestly what I'd change, and show you the exact plan I'd build for it.\n\nIf the timing isn't right, that is completely fine. Reply \"not now\" and I won't follow up again until you're ready.\n\nYou can also reach me directly at (209) 559-4966 any time. A real conversation beats an email thread."
  }
]$seed$::jsonb
where name = 'expired_listing'
  and (steps -> 0 ->> 'body_template') like '%buyer-specific pitches, professional photography and film%';
