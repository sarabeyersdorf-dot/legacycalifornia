// api/_lib/handlers/crm-import-leads.js
// POST /api/crm/import-leads
//
// Permanent CSV-import surface. Same endpoint handles three jobs:
//   kind='leads'     → import the legacy_leads_import.csv shape
//   kind='consent'   → apply the lead_consent_flags.csv shape onto existing leads
//   kind='delete_test' → delete the two seeded sarabeyersdorf / Sara Cooper test rows
//
// Auth: agent-only (server-side).
// Body: { kind, csv?, csv_url?, dry_run? }
//   - csv:     raw CSV text
//   - csv_url: fetched server-side (the legacy artifact URLs)
//   - dry_run: returns a preview without writing
//
// Dedupe rules:
//   - leads:    primary key = fub_id (cast to text). Fallback = email (lowercased).
//   - consent:  primary key = fub_id. Fallback = email.
//
// Notes:
//   - pipeline_stage in CSV is honoured ('sphere' now valid per migration 006).
//   - assigned_agent in CSV: 'sara' / 'james' kept; anything else → 'sara'.
//   - status: 'active' default. If consent later flips not_interested=true the
//     sequences cron treats them as contactable-but-skip-channels; status only
//     flips to 'do_not_contact' when the consent CSV says all three channels.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const ALLOWED_STAGES   = new Set(['new','nurture','touring','offer','close','sphere']);
const ALLOWED_AGENTS   = new Set(['sara','james','unassigned']);
const ALLOWED_TYPES    = new Set(['buyer','seller','land','investor']);
const ALLOWED_TEMPS    = new Set(['new','warm','hot','cold']);

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields, escaped quotes, embedded commas/newlines.
// Returns { headers: string[], rows: object[] }.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"')      { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') {
        row.push(field); rows.push(row);
        row = []; field = '';
      } else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length === 1 && rows[i][0] === '') continue; // trailing blank line
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (rows[i][idx] ?? '').trim(); });
    out.push(obj);
  }
  return { headers, rows: out };
}

const truthy = (v) => /^(1|true|t|yes|y)$/i.test(String(v || '').trim());

function shapeLead(r) {
  const stage = ALLOWED_STAGES.has(r.pipeline_stage) ? r.pipeline_stage : 'new';
  const agent = ALLOWED_AGENTS.has(r.assigned_agent) ? r.assigned_agent : 'sara';
  const lt    = ALLOWED_TYPES.has(r.lead_type)       ? r.lead_type      : null;
  const tmp   = ALLOWED_TEMPS.has(r.temperature)     ? r.temperature    : 'new';
  const priceMin = r.price_min ? Number(String(r.price_min).replace(/[^\d.]/g, '')) || null : null;
  const priceMax = r.price_max ? Number(String(r.price_max).replace(/[^\d.]/g, '')) || null : null;
  const lastContact = r.last_contact_at ? r.last_contact_at : null;
  return {
    first_name:     r.first_name || null,
    last_name:      r.last_name  || null,
    email:          (r.email || '').toLowerCase().trim() || null,
    phone:          r.phone      || null,
    source:         r.source     || 'import',
    journey_stage:  null,
    lead_type:      lt,
    temperature:    tmp,
    assigned_agent: agent,
    pipeline_stage: stage,
    price_min:      priceMin,
    price_max:      priceMax,
    notes:          r.notes      || null,
    status:         r.status     || 'active',
    last_contact_at: lastContact,
    fub_id:         r.fub_id ? String(r.fub_id) : null
  };
}

// ---------------------------------------------------------------------------
async function fetchCsv(body) {
  if (typeof body.csv === 'string' && body.csv.length) return body.csv;
  if (typeof body.csv_url === 'string' && /^https?:\/\//.test(body.csv_url)) {
    const r = await fetch(body.csv_url);
    if (!r.ok) throw new Error(`csv_url fetch failed: ${r.status}`);
    return await r.text();
  }
  throw new Error('csv or csv_url required');
}

// ---------------------------------------------------------------------------
async function importLeads(supa, body) {
  const text = await fetchCsv(body);
  const { rows } = parseCsv(text);
  if (!rows.length) return { kind: 'leads', error: 'no rows parsed' };

  // Pre-fetch all existing fub_ids + emails for fast dedupe
  const { data: existing = [] } = await supa.from('leads').select('id, fub_id, email');
  const byFub = new Map(existing.filter((r) => r.fub_id).map((r) => [String(r.fub_id), r.id]));
  const byEmail = new Map(existing.filter((r) => r.email).map((r) => [r.email.toLowerCase(), r.id]));

  const toInsert = [];
  const skippedDup = [];
  const errors = [];
  for (const r of rows) {
    try {
      const lead = shapeLead(r);
      const key = lead.fub_id;
      if (key && byFub.has(key))                { skippedDup.push({ fub_id: key, reason: 'fub_id_exists' }); continue; }
      if (!key && lead.email && byEmail.has(lead.email)) { skippedDup.push({ email: lead.email, reason: 'email_exists' }); continue; }
      if (!lead.first_name && !lead.last_name && !lead.email && !lead.phone) { errors.push({ row: r, reason: 'all_fields_empty' }); continue; }
      toInsert.push(lead);
    } catch (e) {
      errors.push({ row: r, reason: e.message });
    }
  }

  const summary = {
    kind:        'leads',
    parsed:      rows.length,
    dedupe_skip: skippedDup.length,
    errors:      errors.length,
    will_insert: toInsert.length,
    preview:     toInsert.slice(0, 5).map((l) => ({ name: `${l.first_name || ''} ${l.last_name || ''}`.trim(), email: l.email, fub_id: l.fub_id, pipeline_stage: l.pipeline_stage }))
  };
  if (body.dry_run) return summary;

  // Insert in batches of 200
  let inserted = 0;
  const batch = 200;
  for (let i = 0; i < toInsert.length; i += batch) {
    const slice = toInsert.slice(i, i + batch);
    const { error } = await supa.from('leads').insert(slice);
    if (error) { errors.push({ batch_start: i, reason: error.message }); break; }
    inserted += slice.length;
  }
  return { ...summary, inserted, errors_after_insert: errors };
}

// ---------------------------------------------------------------------------
async function applyConsent(supa, body) {
  const text = await fetchCsv(body);
  const { rows } = parseCsv(text);
  if (!rows.length) return { kind: 'consent', error: 'no rows parsed' };

  const summary = { kind: 'consent', parsed: rows.length, applied: 0, dnc_promoted: 0, sphered: 0, not_found: 0, errors: [] };
  if (body.dry_run) {
    summary.preview = rows.slice(0, 5);
    return summary;
  }

  for (const r of rows) {
    const fub = r.fub_id ? String(r.fub_id) : null;
    const email = (r.email || '').toLowerCase().trim() || null;
    const patch = {
      call_opt_out:   truthy(r.no_call),
      sms_opt_out:    truthy(r.no_sms),
      email_opt_out:  truthy(r.no_email),
      not_interested: truthy(r.not_interested)
    };
    // If all three channels are off OR not_interested → status='do_not_contact'
    if ((patch.call_opt_out && patch.sms_opt_out && patch.email_opt_out) || patch.not_interested) {
      patch.status = 'do_not_contact';
      summary.dnc_promoted++;
    }
    if (truthy(r.out_of_pipeline)) {
      patch.pipeline_stage = 'sphere';
      summary.sphered++;
    }

    let q = supa.from('leads').update(patch);
    if (fub)        q = q.eq('fub_id', fub);
    else if (email) q = q.eq('email', email);
    else { summary.errors.push({ row: r, reason: 'no fub_id or email' }); continue; }

    const { data, error } = await q.select('id');
    if (error)            { summary.errors.push({ row: r, reason: error.message }); continue; }
    if (!data || !data.length) { summary.not_found++; continue; }
    summary.applied += data.length;
  }
  return summary;
}

// ---------------------------------------------------------------------------
async function deleteTestRows(supa, dryRun) {
  const filters = ['sarabeyersdorf', 'sara cooper', 'sara@'];
  const ors = [
    "email.ilike.%sarabeyersdorf%",
    "email.ilike.%sarasellscalifornia%",
    "and(first_name.ilike.sara,last_name.ilike.cooper)"
  ].join(',');
  const { data: matches = [] } = await supa.from('leads').select('id, first_name, last_name, email').or(ors);
  const summary = { kind: 'delete_test', matched: matches.length, sample: matches.slice(0, 5) };
  if (dryRun || !matches.length) return summary;
  const ids = matches.map((m) => m.id);
  const { error } = await supa.from('leads').delete().in('id', ids);
  if (error) return { ...summary, error: error.message };
  return { ...summary, deleted: ids.length };
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);
    const kind = body?.kind || 'leads';
    const supa = adminClient();

    if (kind === 'leads')       return ok(res, await importLeads(supa, body));
    if (kind === 'consent')     return ok(res, await applyConsent(supa, body));
    if (kind === 'delete_test') return ok(res, await deleteTestRows(supa, !!body.dry_run));
    return fail(res, 400, `unknown kind: ${kind}`);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
