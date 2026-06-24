#!/usr/bin/env node
// scripts/import_legacy_leads.mjs
// =============================================================================
// One-time legacy lead import for Sara Cooper / Legacy Properties.
//
// Reads two CSVs (legacy_leads_import.csv + lead_consent_flags.csv), dedupes
// against the live Supabase `leads` table by fub_id (and email fallback),
// deletes the seeded test rows, bulk-inserts the legacy leads, then applies
// the consent flags + 'sphere' pipeline_stage.
//
// SAFE TO RE-RUN. Every step is dedupe-aware:
//   - lead insert skips rows whose fub_id (or email) already exists
//   - consent update is idempotent (PATCH on existing rows by fub_id/email)
//   - test-row delete only fires when matches are found
//
// USAGE (local):
//   1. Make sure `db/006_consent_and_sphere.sql` has already been executed in
//      the Supabase SQL editor. Without it, the 'sphere' stage and opt-out
//      columns don't exist and the script will abort.
//   2. cd legacy-vercel && yarn add @supabase/supabase-js   (one time)
//   3. SUPABASE_URL=https://xxx.supabase.co \
//      SUPABASE_SERVICE_KEY=eyJ... \
//      node scripts/import_legacy_leads.mjs
//
// FLAGS (env vars):
//   DRY_RUN=1        → preview counts only; no writes
//   SKIP_DELETE=1    → don't delete the sarabeyersdorf/sara cooper test rows
//   SKIP_CONSENT=1   → import leads but don't apply the consent CSV
//   LEADS_CSV=path   → override CSV source (default: artifact URL)
//   CONSENT_CSV=path → override CSV source (default: artifact URL)
//
// All counts are printed at the end. Exit code is non-zero on error.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const LEADS_URL   = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/fvyf3ftm_legacy_leads_import.csv';
const CONSENT_URL = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/ugrzaqww_lead_consent_flags.csv';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY_RUN      = !!process.env.DRY_RUN;
const SKIP_DELETE  = !!process.env.SKIP_DELETE;
const SKIP_CONSENT = !!process.env.SKIP_CONSENT;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required.');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ---------- CSV parsing (quote- + comma-safe; same algorithm as the handler)
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
      if (c === '"')        { inQuotes = true; }
      else if (c === ',')   { row.push(field); field = ''; }
      else if (c === '\r')  { /* skip */ }
      else if (c === '\n')  { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length === 1 && rows[i][0] === '') continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (rows[i][idx] ?? '').trim(); });
    out.push(obj);
  }
  return out;
}

async function loadCsv(label, override, fallbackUrl) {
  if (override && existsSync(override)) {
    console.log(`▸ ${label}: reading local ${override}`);
    return parseCsv(readFileSync(override, 'utf8'));
  }
  console.log(`▸ ${label}: fetching ${fallbackUrl}`);
  const r = await fetch(fallbackUrl);
  if (!r.ok) throw new Error(`${label} fetch failed: ${r.status}`);
  return parseCsv(await r.text());
}

// ---------- Schema sanity check (verifies migration 006 ran)
async function verifyMigration() {
  // Insert + rollback a row with the new sphere stage / opt-out columns
  // to confirm the CHECK constraint + columns exist. Cheaper alternative:
  // attempt a SELECT on call_opt_out — Postgres errors if column missing.
  const { error } = await supa.from('leads').select('call_opt_out, not_interested').limit(1);
  if (error && /column .* does not exist/i.test(error.message)) {
    throw new Error('Migration 006 not run yet. Execute db/006_consent_and_sphere.sql in Supabase first.');
  }
}

// ---------- Shape one CSV row into a Supabase `leads` insert payload
const ALLOWED_STAGES = new Set(['new','nurture','touring','offer','close','sphere']);
const ALLOWED_AGENTS = new Set(['sara','james','unassigned']);
const ALLOWED_TYPES  = new Set(['buyer','seller','land','investor']);
const ALLOWED_TEMPS  = new Set(['new','warm','hot','cold']);

function shapeLead(r) {
  const stage = ALLOWED_STAGES.has(r.pipeline_stage) ? r.pipeline_stage : 'new';
  const agent = ALLOWED_AGENTS.has(r.assigned_agent) ? r.assigned_agent : 'sara';
  const lt    = ALLOWED_TYPES.has(r.lead_type)       ? r.lead_type      : null;
  const tmp   = ALLOWED_TEMPS.has(r.temperature)     ? r.temperature    : 'new';
  const num   = (v) => (v ? Number(String(v).replace(/[^\d.]/g, '')) || null : null);
  return {
    first_name:      r.first_name || null,
    last_name:       r.last_name  || null,
    email:           (r.email || '').toLowerCase().trim() || null,
    phone:           r.phone || null,
    source:          r.source || 'import',
    journey_stage:   r.journey_stage || null,
    lead_type:       lt,
    temperature:     tmp,
    assigned_agent:  agent,
    pipeline_stage:  stage,
    price_min:       num(r.price_min),
    price_max:       num(r.price_max),
    notes:           r.notes  || null,
    status:          r.status || 'active',
    last_contact_at: r.last_contact_at || null,
    fub_id:          r.fub_id ? String(r.fub_id) : null
  };
}

// ---------- Pull ALL existing leads in pages (Supabase caps at 1000/req)
async function fetchAllExisting() {
  const PAGE = 1000;
  let from = 0, all = [];
  while (true) {
    const { data, error } = await supa
      .from('leads')
      .select('id, fub_id, email, first_name, last_name')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load existing leads: ${error.message}`);
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ---------- Step 1: Insert legacy leads
async function importLeads() {
  console.log('\n=== STEP 1 / 3 — Import legacy leads ===');
  const rows = await loadCsv('leads.csv', process.env.LEADS_CSV, LEADS_URL);
  console.log(`  parsed: ${rows.length} CSV rows`);

  const existing = await fetchAllExisting();
  const byFub   = new Map(existing.filter((r) => r.fub_id).map((r) => [String(r.fub_id), r.id]));
  const byEmail = new Map(existing.filter((r) => r.email).map((r) => [r.email.toLowerCase(), r.id]));
  console.log(`  existing rows in DB: ${existing.length} (fub keys: ${byFub.size}, email keys: ${byEmail.size})`);

  const toInsert = [];
  let skippedDup = 0, blanks = 0;
  for (const r of rows) {
    const lead = shapeLead(r);
    const key  = lead.fub_id;
    if (key && byFub.has(key))                              { skippedDup++; continue; }
    if (!key && lead.email && byEmail.has(lead.email))      { skippedDup++; continue; }
    if (!lead.first_name && !lead.last_name && !lead.email && !lead.phone) { blanks++; continue; }
    toInsert.push(lead);
  }

  console.log(`  will insert: ${toInsert.length}   skip-dup: ${skippedDup}   blank: ${blanks}`);
  if (DRY_RUN) { console.log('  DRY_RUN=1 — no writes'); return { inserted: 0, skippedDup, blanks, parsed: rows.length }; }

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const slice = toInsert.slice(i, i + BATCH);
    const { error } = await supa.from('leads').insert(slice);
    if (error) throw new Error(`insert batch ${i}: ${error.message}`);
    inserted += slice.length;
    process.stdout.write(`\r  inserted: ${inserted}/${toInsert.length}`);
  }
  console.log('\n  ✓ insert complete');
  return { inserted, skippedDup, blanks, parsed: rows.length };
}

// ---------- Step 2: Apply consent flags + sphere stage
const truthy = (v) => /^(1|true|t|yes|y)$/i.test(String(v || '').trim());

async function applyConsent() {
  console.log('\n=== STEP 2 / 3 — Apply consent flags ===');
  if (SKIP_CONSENT) { console.log('  SKIP_CONSENT=1 — skipped'); return null; }
  const rows = await loadCsv('consent.csv', process.env.CONSENT_CSV, CONSENT_URL);
  console.log(`  parsed: ${rows.length} consent rows`);

  let applied = 0, notFound = 0, dnc = 0, sphered = 0;
  const errors = [];

  for (const r of rows) {
    const fub   = r.fub_id ? String(r.fub_id) : null;
    const email = (r.email || '').toLowerCase().trim() || null;
    const patch = {
      call_opt_out:   truthy(r.no_call),
      sms_opt_out:    truthy(r.no_sms),
      email_opt_out:  truthy(r.no_email),
      not_interested: truthy(r.not_interested)
    };
    if ((patch.call_opt_out && patch.sms_opt_out && patch.email_opt_out) || patch.not_interested) {
      patch.status = 'do_not_contact'; dnc++;
    }
    if (truthy(r.out_of_pipeline)) { patch.pipeline_stage = 'sphere'; sphered++; }

    if (DRY_RUN) continue;

    let q = supa.from('leads').update(patch);
    if (fub) q = q.eq('fub_id', fub);
    else if (email) q = q.eq('email', email);
    else { errors.push({ row: r, reason: 'no fub_id or email' }); continue; }

    const { data, error } = await q.select('id');
    if (error)              { errors.push({ fub_id: fub, email, reason: error.message }); continue; }
    if (!data?.length)      { notFound++; continue; }
    applied += data.length;
  }
  console.log(`  applied: ${applied}   not_found: ${notFound}   promoted_DNC: ${dnc}   moved_to_sphere: ${sphered}   errors: ${errors.length}`);
  if (errors.length) console.log('  sample errors:', errors.slice(0, 3));
  return { applied, notFound, dnc, sphered, errors: errors.length };
}

// ---------- Step 3: Delete seeded test rows
async function deleteTestRows() {
  console.log('\n=== STEP 3 / 3 — Delete test rows ===');
  if (SKIP_DELETE) { console.log('  SKIP_DELETE=1 — skipped'); return null; }
  const ors = [
    'email.ilike.%sarabeyersdorf%',
    'email.ilike.%sarasellscalifornia%',
    'and(first_name.ilike.sara,last_name.ilike.cooper)'
  ].join(',');
  const { data: matches = [], error } = await supa
    .from('leads')
    .select('id, first_name, last_name, email')
    .or(ors);
  if (error) throw new Error(`scan test rows: ${error.message}`);

  console.log(`  matched: ${matches.length}`);
  if (matches.length) console.log('  sample:', matches.slice(0, 5).map((m) => `${m.first_name} ${m.last_name} <${m.email}>`));
  if (DRY_RUN || !matches.length) return { matched: matches.length, deleted: 0 };

  const ids = matches.map((m) => m.id);
  const { error: delErr } = await supa.from('leads').delete().in('id', ids);
  if (delErr) throw new Error(`delete test rows: ${delErr.message}`);
  console.log(`  ✓ deleted ${ids.length} rows`);
  return { matched: matches.length, deleted: ids.length };
}

// ---------- Main
(async function main() {
  console.log('Legacy Properties — one-time CSV import');
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Flags : DRY_RUN=${DRY_RUN ? 'yes' : 'no'}  SKIP_DELETE=${SKIP_DELETE ? 'yes' : 'no'}  SKIP_CONSENT=${SKIP_CONSENT ? 'yes' : 'no'}`);

  try {
    await verifyMigration();
    const a = await importLeads();
    const b = await applyConsent();
    const c = await deleteTestRows();

    console.log('\n================  SUMMARY  ================');
    console.log('Leads   :', a);
    console.log('Consent :', b);
    console.log('Cleanup :', c);
    console.log('===========================================');
    process.exit(0);
  } catch (e) {
    console.error('\n✗ Import failed:', e.message);
    process.exit(2);
  }
})();
