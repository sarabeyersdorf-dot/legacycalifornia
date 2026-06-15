// api/auth/logout.js
// POST → clears the session cookies.
// (Functionally identical to DELETE /api/auth/session but easier to wire from
// a simple <form> or a fetch() call.)

import { handleOptions, ok, fail } from '../_lib/cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  res.setHeader('Set-Cookie', [
    'sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  ]);
  return ok(res, { signed_out: true });
}
