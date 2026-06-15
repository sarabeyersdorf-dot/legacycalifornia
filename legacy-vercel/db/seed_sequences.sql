-- =============================================================================
-- Legacy Properties — Seed the 7 default drip sequences
-- Run AFTER schema.sql + rls_policies.sql.
--
-- Each sequence's `steps` is a jsonb array of:
--   { step_number, delay_hours, channel, subject_template, body_template }
--
-- Templates use mustache-style {{placeholders}} that the AI welcome /
-- draft-reply endpoint fills using lead context.
-- =============================================================================

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
