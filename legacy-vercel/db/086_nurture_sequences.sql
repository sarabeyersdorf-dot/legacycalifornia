-- 086_nurture_sequences.sql
-- Three editable nurture drips, modeled on the expired sequence so they show up
-- in the CRM Sequences editor with per-email AI suggestions:
--   buyer_nurture      — for new buyer leads          (Day 0 / 2 / 5 / 10)
--   seller_nurture     — for seller / pre-listing leads (Day 0 / 3 / 7 / 12)
--   new_lead_nurture   — general, type unknown          (Day 0 / 3 / 7 / 12)
-- All email, mode:"literal" (Sara's exact copy, merge fields filled), send_mode
-- 'auto_after_first' (Email 1 waits for approval; 2..4 auto-send, stop on reply).
-- trigger_type 'manual' — Sara enrolls leads (auto-by-type can be added later).
-- Merge tokens used are only ones the send engine always fills safely:
-- {{greeting}}, {{first_name}}, {{area}}, {{CASE_STUDY_URL}} (no subject property,
-- so buyer/seller leads are never paused for lacking one). Idempotent.

-- ── buyer_nurture ──────────────────────────────────────────────────────────
insert into public.sequences (name, description, trigger_type, steps, active)
select 'buyer_nurture',
       'Buyer nurture — 4 emails · ~10 days · for new buyer leads',
       'manual',
       $seed$[
  {"step_number":1,"delay_hours":0,"channel":"email","mode":"literal",
   "subject_template":"Welcome, from a real person (not a robot)",
   "preview_text":"A quick hello, and how I'll actually help you find the right home.",
   "body_template":"{{greeting}}\n\nThanks for reaching out about buying in {{area}}. I'm Sara Cooper, broker-owner of Legacy Properties, and this is a real note from me.\n\nHere is how I work. I listen first, then send you homes that actually fit, not everything that hits the market. When something special comes up, often before it is public, you will hear about it early.\n\nTell me what matters most to you right now and I will point you in the right direction. What are you hoping to find?"},
  {"step_number":2,"delay_hours":48,"channel":"email","mode":"literal",
   "subject_template":"How homes really move in {{area}}",
   "preview_text":"The good ones go fast and quiet. Here is how to be first.",
   "body_template":"{{greeting}}\n\nOne thing worth knowing about {{area}}: the best homes often sell quietly, before they ever reach the big sites.\n\nI hear about a lot of them early, through other agents and past clients. When I know what you are looking for, I can flag those for you first, while there is still room to act.\n\nIf your search has shifted at all, just reply and tell me. The more specific you are, the better I can watch for the right one."},
  {"step_number":3,"delay_hours":120,"channel":"email","mode":"literal",
   "subject_template":"The part most buyers wish they knew sooner",
   "preview_text":"A few simple first steps make everything easier later.",
   "body_template":"{{greeting}}\n\nWhen buyers feel stressed, it is almost always because of surprises they could have seen coming. So here is the simple version.\n\nGet a real pre-approval before you fall in love with a home, know your true monthly number, and have someone in your corner who reads contracts for a living. That is most of it.\n\nI am happy to walk you through any of it, no pressure and no cost. Want me to set that up?"},
  {"step_number":4,"delay_hours":240,"channel":"email","mode":"literal",
   "subject_template":"Still here whenever you are ready",
   "preview_text":"No pressure. Just an open door.",
   "body_template":"{{greeting}}\n\nI do not want to crowd your inbox, so this is my last note for now.\n\nWhenever you are ready to look seriously, or you just have a question, I am one reply away. There is no clock and no obligation.\n\nIf the timing is not right, tell me \"not now\" and I will check back down the road instead."}
]$seed$::jsonb, true
where not exists (select 1 from public.sequences where name = 'buyer_nurture');

-- ── seller_nurture ─────────────────────────────────────────────────────────
insert into public.sequences (name, description, trigger_type, steps, active)
select 'seller_nurture',
       'Seller nurture — 4 emails · ~12 days · for seller / pre-listing leads',
       'manual',
       $seed$[
  {"step_number":1,"delay_hours":0,"channel":"email","mode":"literal",
   "subject_template":"Thinking about selling? Start here",
   "preview_text":"What selling with Legacy actually looks like.",
   "body_template":"{{greeting}}\n\nThanks for reaching out about selling. I'm Sara Cooper, broker-owner of Legacy Properties, and I wanted to introduce myself properly.\n\nRather than tell you I am different, I would rather show you. Here is a real campaign I built for a home in the area: a cinematic film, its own website, an investor packet, and buyer-specific briefs, all working together.\n\nTake a look: {{CASE_STUDY_URL}}\n\nWhen you are ready, I would love to tell you what I would build for your home."},
  {"step_number":2,"delay_hours":72,"channel":"email","mode":"literal",
   "subject_template":"What goes into a Legacy campaign",
   "preview_text":"Not a sign in the yard. A full marketing package.",
   "body_template":"{{greeting}}\n\nMost listings get a few photos and a sign. That is not how I work.\n\nEvery home I take on gets professional photography and film, its own web page, and marketing aimed at the specific buyers most likely to fall in love with it. The goal is simple: make the right buyer pay attention.\n\nYou can see the whole thing here: {{CASE_STUDY_URL}}\n\nIf you are curious what that would look like for your home, just reply."},
  {"step_number":3,"delay_hours":168,"channel":"email","mode":"literal",
   "subject_template":"You would always know where things stand",
   "preview_text":"The live seller portal I built, so you are never in the dark.",
   "body_template":"{{greeting}}\n\nThe biggest complaint I hear about past agents is not knowing what is happening.\n\nSo I built my own seller portal. Every document, the full timeline, exactly what is needed from you and when, and your marketing numbers, all in one place and updated in real time. No chasing, no wondering.\n\nYou can walk through a live sample here: {{CASE_STUDY_URL}}"},
  {"step_number":4,"delay_hours":288,"channel":"email","mode":"literal",
   "subject_template":"A free plan for your home, no strings",
   "preview_text":"An honest read on price and a marketing plan, on the house.",
   "body_template":"{{greeting}}\n\nWhenever you are ready, I would be glad to put together a plan for your home: an honest read on price, and exactly how I would market it.\n\nIt is free, and there is no obligation to list with me. Worst case, you get useful information.\n\nIf you would like that, just reply and we will find a time. If now is not right, tell me \"not now\" and I will follow up later."}
]$seed$::jsonb, true
where not exists (select 1 from public.sequences where name = 'seller_nurture');

-- ── new_lead_nurture ───────────────────────────────────────────────────────
insert into public.sequences (name, description, trigger_type, steps, active)
select 'new_lead_nurture',
       'New lead nurture — 4 emails · ~12 days · when buyer/seller is not yet known',
       'manual',
       $seed$[
  {"step_number":1,"delay_hours":0,"channel":"email","mode":"literal",
   "subject_template":"Hi from Legacy Properties",
   "preview_text":"A quick hello, and a question so I can actually help.",
   "body_template":"{{greeting}}\n\nThanks for reaching out to Legacy Properties. I'm Sara Cooper, broker-owner, and this is a real note from me.\n\nSo I can be genuinely useful and not just send noise, tell me where you are: buying, selling, or simply exploring what is possible right now?\n\nWhatever it is, I will meet you there. Just reply and point me in the right direction."},
  {"step_number":2,"delay_hours":72,"channel":"email","mode":"literal",
   "subject_template":"A little about how I work",
   "preview_text":"Local, honest, and in your corner.",
   "body_template":"{{greeting}}\n\nA quick note while I have you. I work the Calaveras and Tuolumne area closely, and I care more about getting it right for you than about any single deal.\n\nBuying or selling, that means straight answers, real local knowledge, and someone who reads the fine print so you do not have to.\n\nIf a question is on your mind, reply and ask. That is the fastest way I can help."},
  {"step_number":3,"delay_hours":168,"channel":"email","mode":"literal",
   "subject_template":"Whenever you want to talk",
   "preview_text":"A short call can save a lot of guessing.",
   "body_template":"{{greeting}}\n\nSometimes the easiest thing is a quick conversation. No pressure and no sales pitch.\n\nIf it would help to talk through your options, whether you are months out or just curious, I am glad to. You can reach me directly at (209) 559-4966, or just reply here."},
  {"step_number":4,"delay_hours":288,"channel":"email","mode":"literal",
   "subject_template":"Still here when you need me",
   "preview_text":"No pressure. The door stays open.",
   "body_template":"{{greeting}}\n\nI will leave you be for now, but I did not want to disappear.\n\nWhenever you are ready, or you just have a question, I am one reply away. And if the timing is not right, tell me \"not now\" and I will check back later instead."}
]$seed$::jsonb, true
where not exists (select 1 from public.sequences where name = 'new_lead_nurture');

-- These drips hold Email 1 for approval, then auto-send 2..4 (stop on reply).
update public.sequences set send_mode = 'auto_after_first'
where name in ('buyer_nurture','seller_nurture','new_lead_nurture') and coalesce(send_mode,'') <> 'auto_after_first';
