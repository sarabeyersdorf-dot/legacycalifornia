// api/auth/callback.js
// Magic-link callback. Supabase redirects the user here with either
//   ?code=...                       (PKCE flow — preferred)
//   #access_token=...&refresh_token (implicit fragment flow)
//
// For the PKCE branch we exchange server-side, set httpOnly cookies, and
// redirect to /dashboard.html. For the fragment branch we serve a tiny HTML
// shim that posts the tokens back to /api/auth/session, then redirects.

import { userClient } from '../_lib/supabase.js';

const COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600';

function setSessionCookies(res, access_token, refresh_token) {
  res.setHeader('Set-Cookie', [
    `sb-access-token=${encodeURIComponent(access_token)}; ${COOKIE_OPTS}`,
    `sb-refresh-token=${encodeURIComponent(refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  ]);
}

export default async function handler(req, res) {
  const url  = new URL(req.url, `https://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/dashboard.html';

  if (code) {
    try {
      const supa = userClient(null);
      const { data, error } = await supa.auth.exchangeCodeForSession(code);
      if (error) {
        res.statusCode = 400;
        return res.end(`auth callback failed: ${error.message}`);
      }
      setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      res.statusCode = 302;
      res.setHeader('Location', next);
      return res.end();
    } catch (e) {
      res.statusCode = 500;
      return res.end(`auth callback error: ${e.message}`);
    }
  }

  // Fragment / implicit fallback — render a tiny shim that posts tokens back.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Signing you in…</title></head>
<body style="font-family:system-ui,sans-serif;color:#222;padding:32px;">
<p>Signing you in…</p>
<script>
(async function () {
  const hash = new URLSearchParams(location.hash.slice(1));
  const at = hash.get('access_token');
  const rt = hash.get('refresh_token');
  if (!at) { document.body.innerText = 'No token in callback.'; return; }
  await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: at, refresh_token: rt })
  });
  location.replace(${JSON.stringify(next)});
})();
</script>
</body></html>`);
}
