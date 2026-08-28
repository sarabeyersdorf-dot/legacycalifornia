// api/_lib/handlers/crm-deal-note-suggest.js
// POST /api/crm/deal-note-suggest { source_key }   (agent-only) — SPEC §4.3.
//
// "Suggest for me" — drafts a short client note in Sara's voice from what the
// system already knows about the deal: stage, close date, client-visible
// milestones, and recent documents. READ-ONLY: it returns draft text and writes
// NOTHING. The CRM drops the text into the editable note field, where it stays a
// DRAFT until a human hits Publish. A generated note never reaches a client on its
// own — that is the single worst failure this system could produce, so the
// generator is deliberately incapable of publishing.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { anthropicMessage } from '../anthropic.js';

const fmtDate = (d) => {
  if (!d) return null;
  try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (_) { return String(d); }
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = await readJson(req);
    const sourceKey = String(b?.source_key || '').trim();
    if (!sourceKey) return fail(res, 400, 'source_key required');

    const supa = adminClient();
    const { data: deal, error } = await supa.from('deals')
      .select('id, source_key, address, city, stage, coe_date, side, listing_meta, agent_overrides')
      .eq('source_key', sourceKey).maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!deal)  return fail(res, 404, 'deal not found');

    const ov = (deal.agent_overrides && typeof deal.agent_overrides === 'object') ? deal.agent_overrides : {};
    const coe = ov.coe_date || deal.coe_date || null;
    const client = (deal.listing_meta && deal.listing_meta.client) || null;
    const isBuyer = String(deal.side || '').toLowerCase() === 'buyer';
    const noun = isBuyer ? 'purchase' : 'sale';

    // Client-visible milestones + recent documents — the real facts the note may cite.
    const [{ data: items }, { data: docs }] = await Promise.all([
      supa.from('deal_timeline_items').select('title, status, due_date, client_visible').eq('deal_id', deal.id).order('due_date', { ascending: true }).limit(40).then((r) => r, () => ({ data: [] })),
      supa.from('deal_documents').select('name, status').eq('deal_id', deal.id).order('updated_at', { ascending: false }).limit(12).then((r) => r, () => ({ data: [] }))
    ]);
    const milestones = (items || []).filter((t) => t.client_visible).slice(0, 8)
      .map((t) => `- ${t.title}: ${t.status || 'in progress'}${t.due_date ? ` (due ${fmtDate(t.due_date)})` : ''}`);
    const recentDocs = (docs || []).slice(0, 8).map((d) => `- ${d.name}: ${d.status || 'pending'}`);

    const SYSTEM = `You are writing one short note from Sara Cooper, Broker-Owner of Legacy Properties, to her client about their transaction.
Voice: warm, direct, calm. Like a friend who happens to be a broker.
Short sentences. No exclamation points. No filler. No em-dashes. No markdown. No greeting fluff.
Hard rules:
1. Sara's phone is 209-559-4966. Never use a placeholder like [phone] or {{phone}}.
2. Do not repeat the same idea twice.
3. Output 3-5 short sentences. No salutation, no signoff. Plain prose.
4. Reference ONLY the facts in the context. Never invent a date, a document, or a status.
5. If little is known, write a brief honest check-in rather than padding.`;

    const prompt = `Draft today's client note for the ${noun} at ${deal.address || 'their property'}${deal.city ? ', ' + deal.city : ''}.
Client: ${client || 'the client'}. Stage: ${deal.stage || 'unknown'}.${coe ? ` Close of escrow: ${fmtDate(coe)}.` : ''}
${milestones.length ? `Client-visible milestones:\n${milestones.join('\n')}` : 'No client-visible milestones on file.'}
${recentDocs.length ? `Recent documents:\n${recentDocs.join('\n')}` : 'No documents on file yet.'}
Write 3-5 sentences and end with a concrete next step or a reassuring status line.`;

    const { text } = await anthropicMessage({
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 320,
      temperature: 0.6
    });

    return ok(res, { draft: String(text || '').trim(), facts_used: { milestones: milestones.length, documents: recentDocs.length, coe: !!coe } });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
