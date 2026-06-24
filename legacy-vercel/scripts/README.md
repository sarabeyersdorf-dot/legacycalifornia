# Legacy Properties — one-off scripts

## `import_legacy_leads.mjs`
One-time backfill of the 2,016 legacy FUB leads + 694 consent rows into Supabase.

### Prerequisite
Run `db/006_consent_and_sphere.sql` in the Supabase SQL editor **first** (adds opt-out columns + `sphere` pipeline stage). The script aborts if the migration hasn't run.

### Run it

```bash
cd legacy-vercel
yarn install                 # one time

# Dry run first — no writes, just counts
SUPABASE_URL="https://sthfxehojcvfdyatxzlv.supabase.co" \
SUPABASE_SERVICE_KEY="eyJ...service_role..." \
DRY_RUN=1 \
node scripts/import_legacy_leads.mjs

# When the counts look right, run for real
SUPABASE_URL="https://sthfxehojcvfdyatxzlv.supabase.co" \
SUPABASE_SERVICE_KEY="eyJ...service_role..." \
node scripts/import_legacy_leads.mjs
```

### What it does (in order)
1. **Sanity-checks** that migration 006 has been applied.
2. **Imports leads** from `legacy_leads_import.csv` (artifact URL baked in). Dedupes against the live DB by `fub_id` (then email fallback). Bulk-inserts in batches of 200.
3. **Applies consent flags** from `lead_consent_flags.csv`. Updates existing rows (matched by `fub_id` or `email`) with `call_opt_out` / `sms_opt_out` / `email_opt_out` / `not_interested`. If all three channels are off — or `not_interested=1` — also flips `status='do_not_contact'`. If `out_of_pipeline=1`, moves the lead to `pipeline_stage='sphere'`.
4. **Deletes the seeded test rows** (`sarabeyersdorf`, `sarasellscalifornia`, `Sara Cooper`).

Every step is dedupe-aware and **safe to re-run**.

### Flags
| Env             | Effect                                              |
| --------------- | --------------------------------------------------- |
| `DRY_RUN=1`     | Preview counts only — no writes.                    |
| `SKIP_CONSENT=1`| Import leads but don't apply the consent CSV.       |
| `SKIP_DELETE=1` | Don't delete the test rows.                         |
| `LEADS_CSV=path`| Local CSV override.                                 |
| `CONSENT_CSV=path` | Local CSV override.                              |
