// scripts/fix_fub_stages.mjs
// One-time DB cleanup: re-map leads imported with the wrong pipeline_stage
// because their FUB "Past Client" / "Closed" / "Active Client" labels were
// previously mapped to `close`/`touring` instead of `sphere`/`nurture`.
//
// Safe to re-run.

const SK = process.env.SUPABASE_SERVICE_KEY;
const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
if (!SK || !URL) { console.error('SUPABASE_URL + SUPABASE_SERVICE_KEY required'); process.exit(1); }
const H = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

async function patch(filter, body) {
  const r = await fetch(`${URL}/leads?${filter}&select=id`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`PATCH ${filter} → ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.length;
}

(async () => {
  console.log('▸ Past Client / Closed → sphere (currently in close)');
  const a = await patch(
    `pipeline_stage=eq.close&or=(notes.ilike.*FUB%20stage%3A%20Past%20Client*,notes.ilike.*FUB%20stage%3A%20Past%20Customer*,notes.ilike.*FUB%20stage%3A%20Closed*,notes.ilike.*FUB%20stage%3A%20Sold*)`,
    { pipeline_stage: 'sphere' }
  );
  console.log(`  moved: ${a}`);

  console.log('▸ Active Client / Hot Prospect → nurture (currently in touring)');
  const b = await patch(
    `pipeline_stage=eq.touring&or=(notes.ilike.*FUB%20stage%3A%20Active%20Client*,notes.ilike.*FUB%20stage%3A%20Hot%20Prospect*)`,
    { pipeline_stage: 'nurture' }
  );
  console.log(`  moved: ${b}`);

  console.log('\n✓ Cleanup complete');
})();
