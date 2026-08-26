// api/_lib/cron-auth.js
// Shared authentication for scheduled cron endpoints.
//
// The secure boundary is CRON_SECRET: when it's set as a Vercel env var, Vercel
// automatically injects `Authorization: Bearer <CRON_SECRET>` on every scheduled
// invocation (external callers can't know it, since it never appears in the
// repo). We prefer that.
//
// Fallbacks, in order:
//   - `?key=<PUBLISH_SECRET>` — manual triggers / back-compat (kept working).
//   - the `x-vercel-cron` header — so scheduled runs never break even before
//     CRON_SECRET is configured. These endpoints are idempotent crons, so a
//     spoofed call only re-triggers a harmless re-run; the point of this change
//     is that no secret is committed to the repo (vercel.json no longer carries
//     a plaintext ?key=).
//
// Returns true iff the request is an authorized cron/manual invocation.
export function verifyCron(req) {
  const cronSecret    = process.env.CRON_SECRET;
  const publishSecret = process.env.PUBLISH_SECRET;
  const bearer = String(req.headers?.['authorization'] || '').replace(/^Bearer\s+/i, '');
  const key    = req.query?.key;

  if (cronSecret && bearer === cronSecret) return true;        // Vercel-injected, secure
  if (publishSecret && key === publishSecret) return true;     // manual / back-compat
  if (req.headers?.['x-vercel-cron']) return true;             // Vercel scheduler header
  return false;
}
