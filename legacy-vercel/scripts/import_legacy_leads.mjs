#!/usr/bin/env node
// scripts/import_legacy_leads.mjs
// =============================================================================
// One-time legacy lead import for Sara Cooper / Legacy Properties.
//
// Uses Supabase's PostgREST API via plain fetch — no SDK needed. Works on any
// Node 18+. Safe to re-run; every step dedupes against the live DB.
//
// USAGE:
//   1. Make sure db/006_consent_and_sphere.sql has already been executed in
//      the Supabase SQL editor.
//   2. SUPABASE_URL=https://xxx.supabase.co \
//      SUPABASE_SERVICE_KEY=eyJ... \
//      node scripts/import_legacy_leads.mjs
//
// FLAGS:
//   DRY_RUN=1        → preview counts only; no writes
//   SKIP_DELETE=1    → don't delete the sarabeyersdorf / sara-cooper test rows
//   SKIP_CONSENT=1   → import leads but don't apply the consent CSV
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';

const LEADS_URL   = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/fvyf3ftm_legacy_leads_import.csv';
const CONSENT_URL = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/ugrzaqww_lead_consent_flags.csv';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN       = !!process.env.DRY_RUN;
const SKIP_DELETE   = !!process.env.SKIP_DELETE;
const SKIP_CONSENT  = !!process.env.SKIP_CONSENT;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required.');
  process.exit(1);
}

const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

// ---------- tiny PostgREST helpers
async function pgGet(path) {
  const r = await fetch(`${REST}${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function pgInsert(table, rows) {
  const r = await fetch(`${REST}/${table}`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`INSERT ${table} → ${r.status} ${await r.text()}`);
}
async function pgPatch(table, query, patch) {
  const r = await fetch(`${REST}/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(`PATCH ${table} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function pgDelete(table, query) {
  const r = await fetch(`${REST}/${table}?${query}`, {
    method: 'DELETE',
    headers: { ...HEADERS, Prefer: 'return=representation' }
  });
  if (!r.ok) throw new Error(`DELETE ${table} → ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------- CSV parser (quote- + comma- + newline-safe)
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
      if (c === '"')       { inQuotes = true; }
      else if (c === ',')  { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
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

// ---------- shape one CSV row → leads insert payload
const ALLOWED_STAGES = new Set(['new','nurture','touring','offer','close','sphere']);
const ALLOWED_AGENTS = new Set(['sara','james','unassigned']);
const ALLOWED_TYPES  = new Set(['buyer','seller','both','land','relocation']);
const ALLOWED_TEMPS  = new Set(['new','warm','hot','cold']);
const ALLOWED_JOURNEY = new Set(['discovering','narrowing','touring','ready_to_offer']);
const ALLOWED_STATUS  = new Set(['active','archived','lost','do_not_contact']);
const ALLOWED_SOURCE  = new Set(['website_form','open_house','referral','ihomefinder_idx','manual']);

// Mirrors the canonical mapping in api/_lib/handlers/crm-import-leads.js
const FUB_STAGE_MAP = {
  'past client':'sphere','past customer':'sphere','closed':'sphere','sold':'sphere','sphere':'sphere',
  'active client':'nurture','hot prospect':'nurture','nurture':'nurture',
  'a - hot 1-3 months':'nurture','b - warm 3-6 months':'nurture','c - cold 6+ months':'nurture',
  'showing homes':'touring',
  'making offers':'offer','pending':'offer','under contract':'offer',
  'lead':'new','buyer':'new','seller':'new','buyer and seller':'new','renter':'new'
};
function extractFubStage(notes) {
  if (!notes) return null;
  const m = notes.match(/FUB stage:\s*([^.]+)/i);
  return m ? m[1].trim() : null;
}
function mapFubStage(fubLabel, rawStage) {
  const key = (fubLabel || '').toLowerCase().trim();
  if (key && FUB_STAGE_MAP[key]) return FUB_STAGE_MAP[key];
  if (ALLOWED_STAGES.has(rawStage)) return rawStage;
  return 'new';
}

function mapSource(s) {
  const v = (s || '').toLowerCase().trim();
  if (ALLOWED_SOURCE.has(v)) return v;
  // Legacy FUB labels → allowed enum
  if (/import|fub|csv|migrat/.test(v))    return 'manual';
  if (/website|web|form|landing/.test(v)) return 'website_form';
  if (/open.?house/.test(v))              return 'open_house';
  if (/referr/.test(v))                   return 'referral';
  if (/idx|ihome/.test(v))                return 'ihomefinder_idx';
  return 'manual';
}

function shapeLead(r) {
  const fubStage = r.fub_stage || extractFubStage(r.notes);
  const stage = mapFubStage(fubStage, r.pipeline_stage);
  const agent = ALLOWED_AGENTS.has(r.assigned_agent) ? r.assigned_agent : 'sara';
  const lt    = ALLOWED_TYPES.has(r.lead_type)       ? r.lead_type      : null;
  const tmp   = ALLOWED_TEMPS.has(r.temperature)     ? r.temperature    : 'new';
  const num   = (v) => (v ? Number(String(v).replace(/[^\d.]/g, '')) || null : null);
  return {
    first_name:      r.first_name || null,
    last_name:       r.last_name  || null,
    email:           (r.email || '').toLowerCase().trim() || null,
    phone:           r.phone || null,
    source:          mapSource(r.source),
    journey_stage:   ALLOWED_JOURNEY.has((r.journey_stage || '').toLowerCase()) ? r.journey_stage.toLowerCase() : null,
    lead_type:       lt,
    temperature:     tmp,
    assigned_agent:  agent,
    pipeline_stage:  stage,
    price_min:       num(r.price_min),
    price_max:       num(r.price_max),
    notes:           r.notes  || null,
    status:          ALLOWED_STATUS.has((r.status || '').toLowerCase()) ? r.status.toLowerCase() : 'active',
    last_contact_at: r.last_contact_at || null,
    fub_id:          r.fub_id ? String(r.fub_id) : null
  };
}

// ---------- pull ALL existing leads (paged, REST caps at 1000/req)
async function fetchAllExisting() {
  const PAGE = 1000;
  let from = 0, all = [];
  while (true) {
    const r = await fetch(`${REST}/leads?select=id,fub_id,email`, {
      headers: { ...HEADERS, Range: `${from}-${from + PAGE - 1}` }
    });
    if (!r.ok) throw new Error(`load existing leads: ${r.status} ${await r.text()}`);
    const data = await r.json();
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ---------- sanity check that migration 006 applied
async function verifyMigration() {
  try {
    await pgGet('/leads?select=call_opt_out,not_interested&limit=1');
  } catch (e) {
    if (/column .* does not exist/i.test(e.message) || /call_opt_out/.test(e.message)) {
      throw new Error('Migration 006 not applied. Run db/006_consent_and_sphere.sql in Supabase first.');
    }
    throw e;
  }
}

// ---------- Step 1: insert legacy leads
async function importLeads() {
  console.log('\n=== STEP 1 / 3 — Import legacy leads ===');
  const rows = await loadCsv('leads.csv', process.env.LEADS_CSV, LEADS_URL);
  console.log(`  parsed: ${rows.length} CSV rows`);

  const existing = await fetchAllExisting();
  const byFub   = new Map(existing.filter((r) => r.fub_id).map((r) => [String(r.fub_id), r.id]));
  const byEmail = new Map(existing.filter((r) => r.email).map((r) => [r.email.toLowerCase(), r.id]));
  console.log(`  existing in DB: ${existing.length} (fub keys: ${byFub.size}, email keys: ${byEmail.size})`);

  const toInsert = [];
  let skippedDup = 0, blanks = 0;
  for (const r of rows) {
    const lead = shapeLead(r);
    const key  = lead.fub_id;
    if (key && byFub.has(key))                                              { skippedDup++; continue; }
    if (!key && lead.email && byEmail.has(lead.email))                      { skippedDup++; continue; }
    if (!lead.first_name && !lead.last_name && !lead.email && !lead.phone)  { blanks++; continue; }
    toInsert.push(lead);
  }
  console.log(`  will insert: ${toInsert.length}   skip-dup: ${skippedDup}   blank: ${blanks}`);
  if (DRY_RUN) { console.log('  DRY_RUN=1 — no writes'); return { inserted: 0, skippedDup, blanks, parsed: rows.length }; }

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const slice = toInsert.slice(i, i + BATCH);
    await pgInsert('leads', slice);
    inserted += slice.length;
    process.stdout.write(`\r  inserted: ${inserted}/${toInsert.length}`);
  }
  console.log('\n  ✓ insert complete');
  return { inserted, skippedDup, blanks, parsed: rows.length };
}

// ---------- Step 2: apply consent flags + sphere stage
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

    let query;
    if (fub)        query = `fub_id=eq.${encodeURIComponent(fub)}`;
    else if (email) query = `email=eq.${encodeURIComponent(email)}`;
    else            { errors.push({ row: r, reason: 'no fub_id or email' }); continue; }

    try {
      const data = await pgPatch('leads', `${query}&select=id`, patch);
      if (!data.length) { notFound++; continue; }
      applied += data.length;
    } catch (e) {
      errors.push({ fub_id: fub, email, reason: e.message });
    }
  }
  console.log(`  applied: ${applied}   not_found: ${notFound}   promoted_DNC: ${dnc}   moved_to_sphere: ${sphered}   errors: ${errors.length}`);
  if (errors.length) console.log('  sample errors:', errors.slice(0, 3));
  return { applied, notFound, dnc, sphered, errors: errors.length };
}

// ---------- Step 3: delete seeded test rows
async function deleteTestRows() {
  console.log('\n=== STEP 3 / 3 — Delete test rows ===');
  if (SKIP_DELETE) { console.log('  SKIP_DELETE=1 — skipped'); return null; }
  const ors = encodeURIComponent('email.ilike.*sarabeyersdorf*,email.ilike.*sarasellscalifornia*,and(first_name.ilike.sara,last_name.ilike.cooper)');
  const matches = await pgGet(`/leads?select=id,first_name,last_name,email&or=(${ors})`);
  console.log(`  matched: ${matches.length}`);
  if (matches.length) console.log('  sample:', matches.slice(0, 5).map((m) => `${m.first_name} ${m.last_name} <${m.email}>`));
  if (DRY_RUN || !matches.length) return { matched: matches.length, deleted: 0 };

  const ids = matches.map((m) => `"${m.id}"`).join(',');
  await pgDelete('leads', `id=in.(${ids})`);
  console.log(`  ✓ deleted ${matches.length} rows`);
  return { matched: matches.length, deleted: matches.length };
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
