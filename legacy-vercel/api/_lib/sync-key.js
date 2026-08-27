// api/_lib/sync-key.js
// Dual-key gate for the briefing's ?key= endpoints, so SYNC_SECRET can be
// rotated with NO 401 window (Cowork 2026-08-27, item 5). The env var and the
// scheduled-task prompt can't change in the same instant, so we accept two keys
// at once:
//     SYNC_SECRET       — the current key (also honors legacy BRIEFING_FEEDBACK_SECRET)
//     SYNC_SECRET_NEXT   — the incoming key during a rotation
// Rotation: add SYNC_SECRET_NEXT → Sara updates the prompt → confirm the run used
// 'next' → move SYNC_SECRET_NEXT's value into SYNC_SECRET and clear _NEXT.
//
// Returns { ok, which, configured }:
//   which      — 'primary' | 'next' | null (which key matched; lets a run OBSERVE
//                the rotation instead of assuming it)
//   configured — whether ANY key is set (endpoints that ran open with no secret
//                configured keep that behavior)
export function checkSyncKey(key) {
  const k = String(key ?? '');
  const primary = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET || null;
  const next    = process.env.SYNC_SECRET_NEXT || null;
  const configured = !!(primary || next);
  if (primary && k === primary) return { ok: true, which: 'primary', configured };
  if (next    && k === next)    return { ok: true, which: 'next',    configured };
  return { ok: false, which: null, configured };
}
