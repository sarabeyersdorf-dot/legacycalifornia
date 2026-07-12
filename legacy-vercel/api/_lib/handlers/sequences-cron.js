// api/_lib/handlers/sequences-cron.js
// GET /api/sequences/cron
//
// Hourly Vercel cron that does TWO things:
//
// 1) SEQUENCES TICKER
//    For every lead with sequence_id set, sequence_paused=false,
//    status='active', and sequence_next_due_at <= now():
//       a) Auto-pause if the lead's most recent message is inbound.
//          (They replied — we should not keep dripping at them.)
//       b) Otherwise, draft the next step using direct Anthropic
//          (claude-sonnet-4-6, no SDK wrappers), insert into messages
//          with status='pending_approval'. NEVER auto-sends.
//       c) Advance sequence_step and re-schedule sequence_next_due_at.
//          When all steps are done, clear sequence_id.
//
// 2) TUESDAY SELLER DIGEST
//    Only between 14:00–14:59 UTC on Tuesdays (≈ 7am Pacific). For every
//    property with seller_lead_id set + status='active', generate a short
//    Sara-voice digest of the week's traffic + offers + showings and send
//    it via Resend. A digest is sent at most once per property per week
//    (uniqueness enforced by checking the messages table).
//
// Auth: protected by a shared secret (CRON_SECRET). Vercel cron includes
// the secret automatically when set as `secret` on the cron entry.
// In dev, the secret check is bypassed when CRON_SECRET is not set.

import { adminClient }            from '../supabase.js';
import { anthropicJSON, anthropicMessage } from '../anthropic.js';
import { sendEmail, resendConfigured }     from '../resend.js';
import { handleOptions, ok, fail } from '../cors.js';

const SARA_VOICE = `You are drafting on behalf of Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA.
Sara's voice: warm, direct, never corporate, never salesy. Short sentences.
No exclamation points. No filler. No em-dashes. No markdown.
Hard rules:
1. Sara's phone is 209-559-4966. Never use a placeholder.
2. Do not repeat the same phrase, sentence, or idea twice.
3. If the recipient's first name is "Sara", open with "Hi," instead of "Hey Sara".
4. Reference only real numbers from the context. Never invent showings/offers/visitors.`;

const TEMPLATE_VARS = (lead, sequence) => ({
  first_name:      lead.first_name || 'there',
  last_name:       lead.last_name  || '',
  area:            (lead.areas && lead.areas[0]) || 'your area',
  price_min:       lead.price_min || '',
  price_max:       lead.price_max || '',
  sequence_name:   sequence?.name || ''
});

function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

// ---------------------------------------------------------------------------
// 1. Sequence ticker
// ---------------------------------------------------------------------------
async function tickSequences(supa) {
  const nowIso = new Date().toISOString();

  // Pull every lead due for a step. Limit guards Vercel's 10-second function
  // budget; the next cron tick picks up the remainder.
  const { data: dueLeads = [], error } = await supa
    .from('leads')
    .select('id, first_name, last_name, email, phone, areas, price_min, price_max, journey_stage, lead_type, temperature, score, sequence_id, sequence_step, sequence_next_due_at, call_opt_out, sms_opt_out, email_opt_out, not_interested, pipeline_stage, sms_consent')
    .eq('sequence_paused', false)
    .eq('status', 'active')
    .not('sequence_id', 'is', null)
    .lte('sequence_next_due_at', nowIso)
    .order('sequence_next_due_at', { ascending: true })
    .limit(25);
  if (error) throw new Error(`leads query: ${error.message}`);

  if (!dueLeads.length) return { drafted: 0, paused: 0, completed: 0, errors: [] };

  // Cache sequences for this batch
  const seqIds = [...new Set(dueLeads.map((l) => l.sequence_id))];
  const { data: seqs = [] } = await supa
    .from('sequences').select('id, name, steps').in('id', seqIds);
  const seqMap = new Map(seqs.map((s) => [s.id, s]));

  const counters = { drafted: 0, paused: 0, completed: 0, skipped_consent: 0, errors: [] };

  for (const lead of dueLeads) {
    try {
      // Hard-skip leads that should never receive automated outreach.
      if (lead.pipeline_stage === 'sphere' || lead.not_interested) {
        await supa.from('leads').update({ sequence_paused: true }).eq('id', lead.id);
        counters.skipped_consent++;
        continue;
      }

      const seq = seqMap.get(lead.sequence_id);
      if (!seq) {
        await supa.from('leads').update({ sequence_id: null, sequence_next_due_at: null }).eq('id', lead.id);
        counters.completed++;
        continue;
      }
      const steps = Array.isArray(seq.steps) ? seq.steps : [];
      const idx   = lead.sequence_step || 0;
      const step  = steps[idx];
      if (!step) {
        await supa.from('leads').update({ sequence_id: null, sequence_next_due_at: null }).eq('id', lead.id);
        counters.completed++;
        continue;
      }

      // Per-channel consent: if this step's channel is opted out, advance to
      // the next step that has a contactable channel rather than dripping
      // through SMS when SMS is blocked.
      const channelBlocked = (
        (step.channel === 'sms'   && (lead.sms_opt_out || !lead.sms_consent)) ||   /* A2P: automated SMS needs express opt-in */
        (step.channel === 'email' && lead.email_opt_out)
      );
      if (channelBlocked) {
        const nextIdx = idx + 1;
        const isDone  = nextIdx >= steps.length;
        const nextDue = isDone ? null
          : new Date(Date.now() + (Number(steps[nextIdx].delay_hours) || 0) * 3600_000).toISOString();
        await supa.from('leads').update({
          sequence_step:        nextIdx,
          sequence_next_due_at: nextDue,
          ...(isDone ? { sequence_id: null } : {})
        }).eq('id', lead.id);
        counters.skipped_consent++;
        continue;
      }

      // ---- Auto-pause check ------------------------------------------------
      const { data: lastMsg } = await supa
        .from('messages')
        .select('direction, created_at')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastMsg && lastMsg.direction === 'inbound') {
        await supa.from('leads').update({ sequence_paused: true }).eq('id', lead.id);
        await supa.from('lead_events').insert({
          lead_id:    lead.id,
          event_type: 'score_change',
          source:     'manual',
          event_data: { sequence_paused: true, reason: 'inbound_reply', sequence_id: lead.sequence_id, step: idx + 1 }
        });
        counters.paused++;
        continue;
      }

      // ---- Draft with Claude ----------------------------------------------
      const vars     = TEMPLATE_VARS(lead, seq);
      const subject  = step.channel === 'email' ? fillTemplate(step.subject_template || '', vars) : null;
      const guidance = fillTemplate(step.body_template || '', vars);

      const userPrompt = `Write step ${idx + 1} of the "${seq.name}" sequence for ${vars.first_name}.

Lead context:
  email:         ${lead.email || '(no email)'}
  phone:         ${lead.phone || '(no phone)'}
  journey_stage: ${lead.journey_stage || 'unknown'}
  lead_type:     ${lead.lead_type     || 'unknown'}
  area:          ${vars.area}
  price_range:   ${vars.price_min || '?'} - ${vars.price_max || '?'}
  temperature:   ${lead.temperature}
  score:         ${lead.score}

Step guidance (template-filled): ${guidance}
Channel: ${step.channel}
${step.channel === 'sms'   ? 'Hard cap 160 chars. One thought only.' : ''}
${step.channel === 'email' ? `Subject line (already chosen): "${subject}". 2-4 short paragraphs.` : ''}

Respond in JSON only:
${step.channel === 'sms'
  ? '{ "sms": "...", "reasoning": "one sentence" }'
  : '{ "email_body": "...", "reasoning": "one sentence" }'}`;

      const { json: draft } = await anthropicJSON({
        system:      SARA_VOICE,
        messages:    [{ role: 'user', content: userPrompt }],
        max_tokens:  500,
        temperature: 0.7
      });

      const body = (step.channel === 'sms' ? draft.sms : draft.email_body || '').trim();
      if (!body) throw new Error('empty draft body');

      const { error: insErr } = await supa.from('messages').insert({
        lead_id:            lead.id,
        direction:          'outbound',
        channel:            step.channel,
        body,
        subject,
        status:             'pending_approval',
        ai_generated:       true,
        ai_draft_reasoning: `Sequence "${seq.name}" step ${idx + 1}/${steps.length}. ${(draft.reasoning || '').trim()}`
      });
      if (insErr) throw new Error(`messages insert: ${insErr.message}`);

      // ---- Advance the lead's pointer -------------------------------------
      const nextIdx = idx + 1;
      const isDone  = nextIdx >= steps.length;
      const nextDue = isDone
        ? null
        : new Date(Date.now() + (Number(steps[nextIdx].delay_hours) || 0) * 3600_000).toISOString();

      await supa.from('leads').update({
        sequence_step:        nextIdx,
        sequence_next_due_at: nextDue,
        ...(isDone ? { sequence_id: null } : {})
      }).eq('id', lead.id);

      counters.drafted++;
      if (isDone) counters.completed++;
    } catch (e) {
      counters.errors.push({ lead_id: lead.id, error: e.message });
    }
  }

  return counters;
}

// ---------------------------------------------------------------------------
// 2. Tuesday seller digest
// ---------------------------------------------------------------------------
function isTuesdayDigestHour(d) {
  // Tuesday 14:00-14:59 UTC == 7am Pacific (PDT) / 6am (PST).
  return d.getUTCDay() === 2 && d.getUTCHours() === 14;
}

function fmtUSD(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

async function generateSellerDigestBody(listing, ctx) {
  const { text } = await anthropicMessage({
    system: SARA_VOICE,
    messages: [{ role: 'user', content:
`Write this week's Tuesday digest email for ${ctx.first_name || 'the seller'} about ${listing.address || 'their listing'}.

This week's numbers:
  - page views (last 7 days):   ${ctx.page_views}
  - unique viewers:             ${ctx.unique_viewers}
  - new saves:                  ${ctx.saves}
  - showings completed:         ${ctx.showings_done}
  - showings upcoming:          ${ctx.showings_upcoming}
  - written offers so far:      ${ctx.offers_count}${ctx.top_offer ? ` (top: ${fmtUSD(ctx.top_offer)})` : ''}
  - day on market:              ${ctx.day_on_market}

Format the message as 3 short paragraphs:
  1. One opening sentence with the headline number from this week.
  2. What that means in plain English (no jargon).
  3. The single most useful next step (e.g. "Open house Saturday 11-2", "Two strong offers, deciding by Friday", "Considering a $X price adjustment").

End with: "— Sara · (209) 559-4966". No greeting, no subject line, no markdown.` }],
    max_tokens:  450,
    temperature: 0.6
  });
  return text.trim();
}

async function sendSellerDigests(supa) {
  if (!resendConfigured()) return { skipped: 'no_resend_key', sent: 0 };

  // Active listings with a linked seller lead
  const { data: listings = [], error } = await supa
    .from('properties')
    .select('id, address, city, state, price, sq_ft, bedrooms, bathrooms, created_at, seller_lead_id, leads:seller_lead_id(first_name,last_name,email)')
    .eq('status', 'active')
    .not('seller_lead_id', 'is', null)
    .limit(50);
  if (error) throw new Error(`properties query: ${error.message}`);

  const sevenAgo = new Date(Date.now() - 7 * 86400_000);
  const sevenAgoIso = sevenAgo.toISOString().slice(0, 10);

  const counters = { sent: 0, skipped: 0, errors: [] };

  for (const p of listings) {
    try {
      const seller = p.leads || {};
      if (!seller.email) { counters.skipped++; continue; }

      // De-dupe: have we already sent a digest in the last 6 days?
      const since = new Date(Date.now() - 6 * 86400_000).toISOString();
      const { count: recentCount } = await supa
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', p.seller_lead_id)
        .eq('channel', 'email')
        .eq('direction', 'outbound')
        .eq('subject', 'This week on your listing')
        .gte('created_at', since);
      if ((recentCount || 0) > 0) { counters.skipped++; continue; }

      const [statsRes, offersRes, toursRes] = await Promise.all([
        supa.from('listing_stats').select('page_views,unique_viewers,saves').eq('property_id', p.id).gte('brief_date', sevenAgoIso),
        supa.from('offers').select('amount,status,created_at').eq('property_id', p.id).order('amount', { ascending: false, nullsFirst: false }),
        supa.from('tours').select('scheduled_at,status').eq('property_id', p.id)
      ]);
      const stats   = statsRes.data || [];
      const offers  = offersRes.data || [];
      const tours   = toursRes.data || [];
      const now     = new Date();
      const ctx = {
        first_name:        seller.first_name,
        page_views:        stats.reduce((s, r) => s + (r.page_views || 0), 0),
        unique_viewers:    stats.reduce((s, r) => s + (r.unique_viewers || 0), 0),
        saves:             stats.reduce((s, r) => s + (r.saves || 0), 0),
        showings_done:     tours.filter((t) => new Date(t.scheduled_at) <= now).length,
        showings_upcoming: tours.filter((t) => new Date(t.scheduled_at) >  now).length,
        offers_count:      offers.length,
        top_offer:         offers[0]?.amount || null,
        day_on_market:     Math.max(0, Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400_000))
      };

      const body = await generateSellerDigestBody(p, ctx);
      const html = `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.55;color:#1A1714;max-width:560px;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:24px;margin-bottom:14px;">This week on ${escapeHtml(p.address || 'your listing')}.</div>
        <div style="white-space:pre-wrap;">${escapeHtml(body)}</div>
      </div>`;

      await sendEmail({
        to:       seller.email,
        toName:   [seller.first_name, seller.last_name].filter(Boolean).join(' ') || undefined,
        subject:  'This week on your listing',
        html,
        text:     body
      });

      await supa.from('messages').insert({
        lead_id:      p.seller_lead_id,
        direction:    'outbound',
        channel:      'email',
        body,
        subject:      'This week on your listing',
        status:       'sent',                // transactional, not approval-gated
        ai_generated: true,
        approved_by:  'sara',
        approved_at:  new Date().toISOString(),
        ai_draft_reasoning: 'Tuesday seller digest (auto-sent transactional)'
      });

      counters.sent++;
    } catch (e) {
      counters.errors.push({ property_id: p.id, error: e.message });
    }
  }
  return counters;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  // Optional shared-secret gate (Vercel cron passes ?secret=… or Authorization Bearer)
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const url     = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const querySecret = url.searchParams.get('secret');
    const header  = req.headers['authorization'] || '';
    const bearer  = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (querySecret !== expected && bearer !== expected) {
      return fail(res, 401, 'cron secret invalid');
    }
  }

  // Avoid the global s-maxage cache header for /api/* — this response is
  // a side-effecting cron tick, not cacheable.
  res.setHeader('Cache-Control', 'no-store');

  try {
    const supa = adminClient();
    const out = { sequences: null, digests: null, ran_at: new Date().toISOString() };

    out.sequences = await tickSequences(supa);

    if (isTuesdayDigestHour(new Date())) {
      out.digests = await sendSellerDigests(supa);
    } else {
      out.digests = { skipped: 'not_tuesday_7am_pt' };
    }

    return ok(res, out);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
