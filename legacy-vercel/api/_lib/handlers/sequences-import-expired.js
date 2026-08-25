// api/_lib/handlers/sequences-import-expired.js
// POST /api/sequences/import-expired   { csv: "<raw csv text>", dry_run?: true }
//
// Imports a skip-traced expired-listing CSV and enrolls the new leads in the
// 'expired_listing' sequence. Built for the real export shape:
//   Type, Status, Street Address, City, Zip, Mail Address Same,
//   Phone 1..5 (+ Type + DNC), Email 1..4
//
// Rules (safe by construction):
//   * email = first non-empty Email 1..4. No email → set aside (call/mail only),
//     never enrolled (can't run an email sequence without an address).
//   * dedupe by email within the batch.
//   * an email already in the CRM is NOT auto-enrolled — it's returned for
//     review, so an existing client never gets a cold "your home expired" email.
//   * new leads: property_address/city from the row, phone = Phone 1, seller
//     lead, source 'manual'; extra emails/phones (+DNC) preserved in notes.
//   * dry_run:true parses + classifies WITHOUT writing anything.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { enrollLeads } from './sequences-enroll.js';

// Minimal RFC-4180-ish CSV parse (handles quoted fields + embedded commas).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user)             return fail(res, 401, 'not authenticated');
    if (!isAgent(profile)) return fail(res, 403, 'agents only');

    const b = await readJson(req);
    const dryRun = b.dry_run === true;
    const rows = parseCsv(b.csv);
    if (rows.length < 2) return fail(res, 400, 'csv had no data rows');

    const hdr = rows[0].map((h) => h.trim());
    // Match headers regardless of spaces vs underscores ("Street Address" == "Street_Address").
    const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, ' ').trim();
    const col = (name) => hdr.findIndex((h) => norm(h) === norm(name));
    const iAddr = col('Street Address'), iCity = col('City'), iZip = col('Zip');
    if (iAddr < 0 || iCity < 0) return fail(res, 422, 'csv missing "Street Address" / "City" columns');
    const emailCols = ['Email 1', 'Email 2', 'Email 3', 'Email 4'].map(col).filter((i) => i >= 0);
    const phoneCols = [1, 2, 3, 4, 5].map((n) => ({ p: col(`Phone ${n}`), t: col(`Phone ${n} Type`), d: col(`Phone ${n} DNC`) }));
    const iRelisted = col('Relisted');  // if present + truthy, skip the row (back on market)

    // 1. Parse + classify rows.
    const seen = new Set();
    const toCreate = [];                 // { email, address, city, phone, notes }
    const noEmail = [];                  // addresses we can't email
    const dupes = [];
    const relisted = [];                 // back on market — never emailed
    const isTruthy = (v) => { const s = String(v || '').trim().toLowerCase(); return s !== '' && s !== 'no' && s !== 'false' && s !== '0' && s !== 'n'; };
    for (const r of rows.slice(1)) {
      const address = (r[iAddr] || '').trim();
      const city    = (r[iCity] || '').trim();
      if (!address) continue;
      if (iRelisted >= 0 && isTruthy(r[iRelisted])) { relisted.push({ address, city }); continue; }
      const email = emailCols.map((i) => (r[i] || '').trim()).find(Boolean) || '';
      if (!email) { noEmail.push({ address, city }); continue; }
      const key = email.toLowerCase();
      if (seen.has(key)) { dupes.push({ email, address }); continue; }
      seen.add(key);
      const extraEmails = emailCols.map((i) => (r[i] || '').trim()).filter(Boolean).slice(1);
      const phones = phoneCols
        .map(({ p, t, d }) => ({ num: (r[p] || '').trim(), type: (r[t] || '').trim(), dnc: /dnc/i.test(r[d] || '') }))
        .filter((x) => x.num);
      const notesLines = [
        `Expired listing import ${b.list_label || ''}`.trim(),
        extraEmails.length ? `Other emails: ${extraEmails.join(', ')}` : '',
        phones.length ? `Phones: ${phones.map((p) => `${p.num}${p.type ? ' (' + p.type + ')' : ''}${p.dnc ? ' [DNC]' : ''}`).join(', ')}` : ''
      ].filter(Boolean);
      toCreate.push({
        email, address, city,
        phone: phones[0] ? phones[0].num : null,
        notes: notesLines.join('\n')
      });
    }

    // 2. Which emails already exist in the CRM? (never auto-cold those.)
    const emails = toCreate.map((x) => x.email.toLowerCase());
    let existing = new Set();
    if (emails.length) {
      const { data: ex } = await adminClient().from('leads').select('email').in('email', emails);
      existing = new Set((ex || []).map((e) => (e.email || '').toLowerCase()));
    }
    const fresh  = toCreate.filter((x) => !existing.has(x.email.toLowerCase()));
    const review = toCreate.filter((x) =>  existing.has(x.email.toLowerCase())).map((x) => ({ email: x.email, address: x.address }));

    const summary = {
      dry_run: dryRun,
      parsed_rows: rows.length - 1,
      emailable_unique: toCreate.length,
      no_email: noEmail.length, no_email_list: noEmail,
      relisted: relisted.length, relisted_list: relisted,
      duplicates: dupes.length,
      already_in_crm: review.length, already_in_crm_list: review,
      to_enroll: fresh.length
    };
    if (dryRun) return ok(res, summary);

    // 3. Create the fresh leads + enroll them.
    const supa = adminClient();
    const createdIds = [];
    for (const x of fresh) {
      const { data, error } = await supa.from('leads').insert({
        email: x.email, property_address: x.address, property_city: x.city,
        phone: x.phone, lead_type: 'seller', source: 'manual', status: 'active',
        notes: x.notes
      }).select('id').single();
      if (!error && data) createdIds.push(data.id);
    }
    const enroll = await enrollLeads(supa, { leadIds: createdIds, sequence_name: 'expired_listing' });

    return ok(res, {
      ...summary,
      created: createdIds.length,
      enrolled_count: (enroll.enrolled || []).length,
      enroll_skipped: enroll.skipped || []
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
