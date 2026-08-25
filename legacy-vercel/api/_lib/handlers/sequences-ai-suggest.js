// api/_lib/handlers/sequences-ai-suggest.js
// POST /api/sequences/ai-suggest   { sequence_name, step_number, instruction? }
//   → { step_number, subject, body, reasoning }
//
// Drafts one email of an expired-listing sequence in Sara's voice so she doesn't
// have to write each from scratch. Read-only: it returns a suggestion; the editor
// shows it, Sara tweaks, then Saves via /api/sequences/edit. The system prompt
// forbids signatures/disclaimers (the send pipeline adds the branded header,
// headshot, footer, and the "not a solicitation" line automatically) and pins the
// merge tokens so personalization still fills in per lead.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { anthropicJSON } from '../anthropic.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const EXPIRED_SYSTEM = `You are writing cold outreach emails on behalf of Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, California. The recipients are owners whose home listing recently EXPIRED — it was on the market with another agent and did not sell.

Voice: warm, direct, genuinely knowledgeable, human. A trusted local expert, never a form letter. Never corporate, salesy, or pushy. Never disparage the previous agent or the homeowner.
Style: short sentences, short paragraphs. No exclamation points. No em-dashes. No hype words ("amazing", "incredible", "thrilled"). No pressure or false urgency.

HARD RULES:
1. Merge tokens — use these EXACTLY where a personalized value belongs. Never invent a name, address, or number:
   {{greeting}}          renders as "Hi Jane," or, when the name is unknown, "Hi,". ALWAYS begin the email with {{greeting}} on its own first line.
   {{property_address}}  the home's street address.
   {{city}}              the home's city.
   {{CASE_STUDY_URL}}    a link to Legacy's case-study page — use it when you want to point to proof/results.
2. Do NOT write any signature, sign-off ("Warmly, Sara"), letterhead, logo, headshot, phone block, or any unsubscribe / "not a solicitation" disclaimer. All of that is added automatically by the system. End on the last sentence of your actual message.
3. Plain text only. No HTML, no markdown, and no links other than the {{CASE_STUDY_URL}} token.
4. Never invent facts, statistics, sale prices, timelines, or commitments.`;

// What each step in the 4-email expired cadence is for (keeps the set varied).
const EXPIRED_INTENT = {
  1: 'Email 1 — the opener. Very short. Acknowledge, without drama, that the listing expired, and that helping homes like theirs sell is what you do. No hard ask — just open the door to a conversation.',
  2: 'Email 2 — proof, a few days later. Briefly show HOW Legacy markets a home differently and why that gets results. Pointing to {{CASE_STUDY_URL}} works well here. Still low-pressure.',
  3: 'Email 3 — a concrete, free offer. Offer something specific and useful: an honest read on why {{property_address}} may not have sold, or a fresh marketing plan for it. One clear, easy next step.',
  4: 'Email 4 — the graceful last touch. Short, warm, no guilt. Leave the door open and make it effortless to reply whenever they are ready.'
};

// Speed-to-Lead: a SOLICITED, instant auto-reply to someone who JUST contacted
// Legacy through the website. Warm acknowledgement, not cold outreach.
const SPEED_SYSTEM = `You are writing the instant auto-reply that goes to someone who just contacted Legacy Properties (Sara Cooper, Broker-Owner, and James Beyersdorf) through legacycalifornia.com. They reached out first, so this is a warm, welcome acknowledgement — never cold outreach and never salesy.

Voice: warm, human, brief, reassuring. Like a real person replying quickly, not a corporate autoresponder.
Style: short sentences, short paragraphs. No exclamation points. No em-dashes. No hype. No pressure.

HARD RULES:
1. Merge tokens — use EXACTLY where a personalized value belongs, never invent one:
   {{greeting}}    renders as "Hi Jane," or, when the name is unknown, "Hi,". ALWAYS begin with {{greeting}} on its own first line.
   {{first_name}}  the lead's first name (usually you only need {{greeting}}).
2. Make clear it is a quick automatic note confirming their message arrived, and that Sara or James will personally follow up shortly (usually within a few hours during the day). It is fine to give Sara's direct line, (209) 559-4966, for anything time sensitive.
3. Do NOT write any signature, sign-off, letterhead, logo, or disclaimer — those are added automatically. End on the last sentence of your actual message.
4. Plain text only. No HTML, no markdown, no links. Never invent facts, commitments, or timelines beyond "shortly / within a few hours."`;

const SPEED_INTENT = {
  1: 'The single instant acknowledgement email. Confirm warmly that their message came through, set the expectation that a real person (Sara or James) will follow up soon, and offer Sara\'s direct number for anything urgent. Keep it short and genuine.'
};

// Warm nurture drips to leads who reached out (buyer / seller / not-yet-known).
// Not cold outreach: helpful, patient, human. Merge tokens: {{greeting}},
// {{first_name}}, {{area}} (buyer), {{CASE_STUDY_URL}} (seller). No subject
// property, so never use {{property_address}} or {{city}}.
const NURTURE_RULES = `Voice: warm, direct, genuinely helpful, human. Sara Cooper, Broker-Owner of Legacy Properties (Angels Camp, CA), and James Beyersdorf. Never corporate, salesy, or pushy.
Style: short sentences, short paragraphs. No exclamation points. No em-dashes. No hype. No pressure or false urgency.
HARD RULES:
1. Begin every email with {{greeting}} on its own first line ("Hi Jane," or "Hi," when the name is unknown). Other allowed tokens: {{first_name}}, {{area}} (the buyer's area), {{CASE_STUDY_URL}} (Legacy's case-study page). Never use {{property_address}} or {{city}} — these leads have no subject property. Never invent a name, place, or number.
2. Do NOT write a signature, sign-off, letterhead, logo, or disclaimer — those are added automatically. End on the last sentence of your message.
3. Plain text only. No HTML, no markdown, no links other than {{CASE_STUDY_URL}}. Never invent facts or commitments.`;

const BUYER_SYSTEM = `You are writing a nurture email to someone who reached out about BUYING a home in the Calaveras/Tuolumne foothills. They contacted Legacy first, so this is a warm follow-up, not cold outreach.\n\n${NURTURE_RULES}`;
const SELLER_SYSTEM = `You are writing a nurture email to someone who reached out about SELLING their home, served by Legacy Properties. They contacted first, so this is a warm follow-up, not cold outreach. Legacy's edge is real marketing (cinematic film, a dedicated site, an investor packet, buyer-specific briefs, a live seller portal) — point to {{CASE_STUDY_URL}} for proof.\n\n${NURTURE_RULES}`;
const NEWLEAD_SYSTEM = `You are writing a nurture email to a brand-new lead whose intent (buying vs selling) is NOT yet known. They contacted Legacy first. Keep it useful either way and, early on, invite them to tell you whether they are buying, selling, or exploring.\n\n${NURTURE_RULES}`;

const BUYER_INTENT = {
  1: 'Email 1 — warm intro. Say who you are, how you actually help a buyer (listen first, send homes that fit, early access to quiet listings), and ask one open question about what they want.',
  2: 'Email 2 — value. Explain that the best homes in {{area}} often sell quietly/early, and that you can flag those first once you know their criteria. Invite them to sharpen their search.',
  3: 'Email 3 — make it easy. Demystify the first practical steps (real pre-approval, knowing the true monthly number, having an advocate who reads contracts). Offer to walk them through it, free.',
  4: 'Email 4 — graceful check-in. Short, no pressure. Leave the door open and make it easy to reply later or say "not now".'
};
const SELLER_INTENT = {
  1: 'Email 1 — warm intro. Introduce yourself and, instead of claiming to be different, point to a real Legacy campaign at {{CASE_STUDY_URL}}. Offer to tell them what you would build for their home.',
  2: 'Email 2 — proof. Contrast a few-photos-and-a-sign listing with a full Legacy campaign (photography, film, dedicated page, targeted buyer marketing). Point again to {{CASE_STUDY_URL}}.',
  3: 'Email 3 — transparency. Describe the live seller portal (documents, timeline, marketing numbers, real time) so they would always know where things stand. Link {{CASE_STUDY_URL}}.',
  4: 'Email 4 — the free offer. Offer a no-obligation plan: an honest read on price and exactly how you would market it. Easy next step; graceful out.'
};
const NEWLEAD_INTENT = {
  1: 'Email 1 — warm hello. Introduce yourself and ask one simple question: are they buying, selling, or just exploring, so you can actually help.',
  2: 'Email 2 — who you are. Briefly: local, honest, in their corner, useful whether they buy or sell. Invite a question.',
  3: 'Email 3 — invite a conversation. Offer a low-pressure call; give the direct number (209) 559-4966 or a reply.',
  4: 'Email 4 — graceful check-in. Short, no pressure, door open, easy "not now".'
};

// Per-sequence prompt profiles. Unknown sequences fall back to the expired one.
const PROFILES = {
  expired_listing:  { system: EXPIRED_SYSTEM, intent: EXPIRED_INTENT },
  speed_to_lead:    { system: SPEED_SYSTEM,   intent: SPEED_INTENT },
  buyer_nurture:    { system: BUYER_SYSTEM,   intent: BUYER_INTENT },
  seller_nurture:   { system: SELLER_SYSTEM,  intent: SELLER_INTENT },
  new_lead_nurture: { system: NEWLEAD_SYSTEM, intent: NEWLEAD_INTENT }
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = await readJson(req);
    const name        = String(b.sequence_name || 'expired_listing').trim();
    const stepNum     = Number(b.step_number) || 1;
    const instruction = (typeof b.instruction === 'string') ? b.instruction.trim() : '';

    const supa = adminClient();
    const { data: seq } = await supa
      .from('sequences').select('name, description, steps').eq('name', name).maybeSingle();

    const steps = (seq && Array.isArray(seq.steps))
      ? seq.steps.slice().sort((a, c) => (a.step_number || 0) - (c.step_number || 0))
      : [];

    // Give the model the OTHER emails so it doesn't echo their angle or wording.
    const others = steps
      .filter((s) => Number(s.step_number) !== stepNum)
      .map((s) => `Email ${s.step_number} subject: ${s.subject_template || '(none)'}\nEmail ${s.step_number} body:\n${(s.body_template || '').slice(0, 700)}`)
      .join('\n\n---\n\n');

    const prof   = PROFILES[name] || PROFILES.expired_listing;
    const intent = prof.intent[stepNum] || `Email ${stepNum} in the sequence.`;
    const total  = steps.length || (name === 'speed_to_lead' ? 1 : 4);

    const userPrompt = `Write EMAIL ${stepNum} of a ${total}-email sequence.

This email's job:
${intent}

The other emails already in this sequence (do NOT repeat their angle or wording):
${others || '(none yet — this is the only one)'}

${instruction ? `Sara's specific request for this email: ${instruction}\n` : ''}Respond in JSON only, no markdown fences:
{
  "subject": "the subject line — plain, specific, under ~60 characters, no clickbait",
  "body": "the full email body as plain text, beginning with {{greeting}} on the first line",
  "reasoning": "one short sentence on the angle you chose"
}`;

    // One email is small work, so lead with the fast model under a hard timeout
    // to stay well inside the function budget (avoids the 504). If it's slow or
    // unavailable, fall back once to the default model, then surface a friendly
    // "busy, try again" rather than a raw gateway timeout.
    const call = (model, timeoutMs) => anthropicJSON({
      system: prof.system,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 700,
      temperature: 0.7,
      model,
      timeoutMs
    });

    let json;
    try {
      ({ json } = await call('claude-haiku-4-5-20251001', 22000));
    } catch (e1) {
      try {
        ({ json } = await call(undefined, 26000));   // default model fallback
      } catch (e2) {
        return fail(res, 503, 'The writing assistant is busy right now. Give it a few seconds and try again.');
      }
    }

    const subject = String(json.subject || '').trim();
    const body    = String(json.body || '').trim();
    if (!body) return fail(res, 502, 'AI returned an empty draft — try again.');

    return ok(res, { step_number: stepNum, subject, body, reasoning: String(json.reasoning || '').trim() });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
