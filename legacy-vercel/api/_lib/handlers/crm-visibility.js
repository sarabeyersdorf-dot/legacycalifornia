// api/_lib/handlers/crm-visibility.js
// POST /api/crm/visibility
//   Body: { kind: 'task'|'tour'|'appointment', id, visibility: 'internal'|'client', client_label? }
//   Flips one row's visibility between internal and client, and optionally sets
//   the friendly client_label the client sees in their portal.
//
// WIRE-FRAUD GUARD (binding, no override — ever):
//   Before any flip TO 'client', the row's title / note / client_label and the
//   proposed client_label are scanned for wire-instruction language. If any
//   matches, the flip is REFUSED (409) with a warning. Wire instructions must
//   never reach a client through this portal. There is deliberately no admin
//   override path. Flips back to 'internal' are always allowed.
//
// Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const KINDS = {
  task:        'agent_tasks',
  tour:        'tours',
  appointment: 'appointments'
};

// Fields that carry human text worth scanning per kind (for the wire guard).
const TEXT_FIELDS = {
  task:        ['title', 'note', 'client_label'],
  tour:        ['tour_type', 'notes', 'client_label'],
  appointment: ['title', 'location', 'notes', 'client_label']
};

// Wire-instruction language. Deliberately broad: a false block is a minor
// annoyance; a leaked wire instruction is a stolen down payment. No override.
const WIRE_PATTERNS = [
  /\bwir(?:e|ing|ed)\b/i,        // wire, wiring, wired
  /\brouting\b/i,               // routing number
  /\baba\b/i,                   // ABA number
  /\bswift\b/i,                 // SWIFT code
  /\biban\b/i,                  // IBAN
  /\baccount\s*(?:#|no\.?\b|number\b)/i,  // account #, account no, account number
  /\bacct\b/i,                          // acct, acct #, acct no
  /\b\d{9}\b/                   // a bare 9-digit number (ABA/routing shape)
];

function wireHit(...texts) {
  const blob = texts.filter(Boolean).join(' \n ');
  for (const re of WIRE_PATTERNS) if (re.test(blob)) return re.source;
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const body = await readJson(req);
    const kind = String(body?.kind || '').trim();
    const id   = body?.id;
    const visibility = body?.visibility === 'client' ? 'client' : 'internal';
    const table = KINDS[kind];
    if (!table || !id) return fail(res, 400, 'kind and id required');

    const supa = adminClient();
    const { data: row, error: readErr } = await supa.from(table).select('*').eq('id', id).maybeSingle();
    if (readErr) return fail(res, 500, readErr.message);
    if (!row)    return fail(res, 404, `${kind} not found`);

    // Proposed label — an explicit client_label wins; otherwise keep the stored one.
    const nextLabel = body?.client_label !== undefined
      ? (String(body.client_label || '').trim() || null)
      : (row.client_label ?? null);

    // WIRE GUARD — only when the result would be client-visible.
    if (visibility === 'client') {
      const fields = (TEXT_FIELDS[kind] || []).map((f) => row[f]);
      const hit = wireHit(...fields, nextLabel);
      if (hit) {
        return fail(res, 409, 'This item looks like it contains wire or payment instructions, so it can’t be shared with the client. Wire details must be given by phone through the title company only — never through the portal. Remove the wire/account language, then share.');
      }
    }

    const patch = { visibility };
    if (body?.client_label !== undefined) patch.client_label = nextLabel;

    const { data: updated, error: upErr } = await supa.from(table)
      .update(patch).eq('id', id).select().single();
    if (upErr) return fail(res, 500, upErr.message);

    return ok(res, { item: updated, kind, shared: visibility === 'client' });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
