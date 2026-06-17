// api/_lib/handlers/crm-morning-brief.js
// GET /api/crm/morning-brief
//
// Returns Sara's daily snapshot:
//   - drafts:        messages with status='pending_approval' (the "Five quiet asks")
//   - tours_today:   tours scheduled in the next 24 hours
//   - radio_silence: leads with last_contact_at older than 14 days
//   - new_today:     leads created in the last 24 hours
//   - active_deals:  open offers grouped by status
//   - narrative:     AI-generated brief paragraph in Sara's voice
//
// Agents only. The auth gate is enforced at the route level; this handler
// still defends with getCallerProfile() so it's safe even if mis-mounted.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { anthropicMessage } from '../anthropic.js';
import { handleOptions, ok, fail } from '../cors.js';

const SARA_SYSTEM = `You are writing a one-paragraph morning brief for Sara Cooper, Broker-Owner of Legacy Properties in Angels Camp, CA.
Voice: warm, direct, conversational. Like a smart assistant who reads her data.
Short sentences. No exclamation points. No filler. Lead with the most important signal.
Never invent details — only reference numbers and names provided.
Output plain prose only, 3-5 sentences, no markdown.`;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const supa = adminClient();
    const now  = new Date();
    const dayAgo  = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const twoWk   = new Date(now.getTime() - 14 * 86400 * 1000).toISOString();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();

    const [drafts, toursToday, radioSilence, newToday, openOffers] = await Promise.all([
      supa.from('messages')
          .select('id, lead_id, channel, subject, body, ai_draft_reasoning, created_at, leads(first_name,last_name,email,temperature,score)')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(10),
      supa.from('tours')
          .select('id, scheduled_at, tour_type, status, leads(first_name,last_name), properties(address,city)')
          .gte('scheduled_at', now.toISOString())
          .lte('scheduled_at', tomorrow)
          .order('scheduled_at'),
      supa.from('leads')
          .select('id, first_name, last_name, email, temperature, score, last_contact_at')
          .eq('status', 'active')
          .lt('last_contact_at', twoWk)
          .order('last_contact_at')
          .limit(10),
      supa.from('leads')
          .select('id, first_name, last_name, email, source, journey_stage, score, temperature, created_at')
          .gte('created_at', dayAgo)
          .order('created_at', { ascending: false }),
      supa.from('offers')
          .select('id, status, amount, property_id, properties(address,city), buyer_lead_id, leads(first_name,last_name)')
          .in('status', ['received','countered'])
    ]);

    const result = {
      drafts:        drafts.data        || [],
      tours_today:   toursToday.data    || [],
      radio_silence: radioSilence.data  || [],
      new_today:     newToday.data      || [],
      open_offers:   openOffers.data    || []
    };

    // Look for today's cached brief first. Refresh narrative if older than 4h.
    const agent = profile.role === 'agent_james' ? 'james' : 'sara';
    const today = new Date().toISOString().slice(0, 10);
    const { data: cached } = await supa
      .from('briefs')
      .select('*')
      .eq('agent', agent)
      .eq('brief_date', today)
      .maybeSingle();

    const cacheFresh = cached && cached.narrative &&
      (Date.now() - new Date(cached.updated_at).getTime()) < 4 * 3600 * 1000;

    if (cacheFresh) {
      result.narrative      = cached.narrative;
      result.narrative_from = 'cache';
      return ok(res, result);
    }

    // Generate the narrative — fail soft so the panel still works if Anthropic is down.
    try {
      const ctx = {
        draft_count:        result.drafts.length,
        tours_today_count:  result.tours_today.length,
        radio_silence_count: result.radio_silence.length,
        new_today_count:    result.new_today.length,
        open_offer_count:   result.open_offers.length,
        sample_new_lead:    result.new_today[0]?.first_name || null,
        sample_radio_lead:  result.radio_silence[0]?.first_name || null
      };
      const userPrompt = `Today is ${now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}.
Snapshot for ${agent === 'sara' ? 'Sara' : 'James'}:
  ${ctx.draft_count} draft message(s) awaiting your approval
  ${ctx.tours_today_count} tour(s) on today's calendar
  ${ctx.new_today_count} new lead(s) in the past 24 hours${ctx.sample_new_lead ? ' (latest: ' + ctx.sample_new_lead + ')' : ''}
  ${ctx.radio_silence_count} lead(s) with no contact in 14+ days${ctx.sample_radio_lead ? ' (e.g. ' + ctx.sample_radio_lead + ')' : ''}
  ${ctx.open_offer_count} open offer(s) in negotiation
Write the brief paragraph now. Lead with the most important signal.`;
      const { text } = await anthropicMessage({
        system: SARA_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 400,
        temperature: 0.6
      });
      result.narrative      = text.trim();
      result.narrative_from = 'fresh';

      // Persist (upsert) so subsequent reloads hit the cache
      await supa.from('briefs').upsert({
        agent,
        brief_date: today,
        narrative:  result.narrative,
        snapshot:   ctx,
        updated_at: new Date().toISOString()
      }, { onConflict: 'agent,brief_date' });
    } catch (e) {
      result.narrative = cached?.narrative || null;
      result.narrative_error = e.message;
      result.narrative_from = cached?.narrative ? 'stale_cache' : 'none';
    }

    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
