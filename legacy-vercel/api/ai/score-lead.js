// api/ai/score-lead.js
// Recalculates a lead's score 0–100 from their event history and journey stage,
// then updates `leads.score` and `leads.temperature`.
//
// Usage:
//   - HTTP:  POST /api/ai/score-lead  body: { lead_id }
//   - Server: `import { scoreLead } from './ai/score-lead.js'`
//
// Score weights (per spec Phase 1C):
//   form_submitted: +10
//   journey_stage ready_to_offer +30 / touring +20 / narrowing +10
//   property_saved +5 each (max +25)
//   property_viewed ≥3x: +10
//   sms_replied +15
//   email_opened +3
//   tour_booked +20
//   tour_completed +15
//   14+ days no contact: −10
//   30+ days no contact: −20

import { adminClient } from '../_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';

function temperatureFor(score) {
  if (score >= 75) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 25) return 'cold';
  return 'cold';
}

export async function scoreLead(lead_id) {
  const supa = adminClient();

  const { data: lead, error } = await supa
    .from('leads').select('*').eq('id', lead_id).single();
  if (error || !lead) throw new Error('lead not found');

  const { data: events = [] } = await supa
    .from('lead_events').select('*').eq('lead_id', lead_id);

  let score = 0;
  const breakdown = [];

  // Journey stage
  if (lead.journey_stage === 'ready_to_offer') { score += 30; breakdown.push('+30 ready_to_offer'); }
  else if (lead.journey_stage === 'touring')   { score += 20; breakdown.push('+20 touring'); }
  else if (lead.journey_stage === 'narrowing') { score += 10; breakdown.push('+10 narrowing'); }

  // Aggregate events
  let savedCount = 0;
  const viewCounts = {}; // property_id → count
  for (const ev of events) {
    switch (ev.event_type) {
      case 'form_submitted':   score += 10; breakdown.push('+10 form_submitted'); break;
      case 'property_saved':   savedCount += 1; break;
      case 'property_viewed': {
        const pid = ev.event_data?.property_id || 'unknown';
        viewCounts[pid] = (viewCounts[pid] || 0) + 1;
        break;
      }
      case 'sms_replied':      score += 15; breakdown.push('+15 sms_replied'); break;
      case 'email_opened':     score += 3;  breakdown.push('+3 email_opened'); break;
      case 'tour_booked':      score += 20; breakdown.push('+20 tour_booked'); break;
      case 'tour_completed':   score += 15; breakdown.push('+15 tour_completed'); break;
      default: break;
    }
  }
  const savedPts = Math.min(savedCount * 5, 25);
  if (savedPts) { score += savedPts; breakdown.push(`+${savedPts} property_saved x${savedCount}`); }

  for (const [pid, c] of Object.entries(viewCounts)) {
    if (c >= 3) { score += 10; breakdown.push(`+10 property_viewed 3+ (${pid})`); break; }
  }

  // Radio-silence penalty
  if (lead.last_contact_at) {
    const days = (Date.now() - new Date(lead.last_contact_at).getTime()) / 86400000;
    if (days >= 30)      { score -= 20; breakdown.push('-20 30d_silence'); }
    else if (days >= 14) { score -= 10; breakdown.push('-10 14d_silence'); }
  }

  score = Math.max(0, Math.min(100, score));
  const temperature = temperatureFor(score);

  // Persist + audit event
  if (score !== lead.score || temperature !== lead.temperature) {
    await supa.from('leads')
      .update({ score, temperature })
      .eq('id', lead_id);

    await supa.from('lead_events').insert({
      lead_id,
      event_type: 'score_change',
      event_data: { old_score: lead.score, new_score: score, breakdown },
      source: 'manual'
    });
  }

  return { score, temperature, breakdown };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { lead_id } = await readJson(req);
    if (!lead_id) return fail(res, 400, 'lead_id required');
    const result = await scoreLead(lead_id);
    return ok(res, result);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
