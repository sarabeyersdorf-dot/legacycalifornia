// api/_lib/handlers/auth-callback.js
// Magic-link callback. Supabase redirects the user here with either
//   ?code=...                       (PKCE flow — preferred)
//   #access_token=...&refresh_token (implicit fragment flow)
//
// PKCE branch:  exchange server-side → set httpOnly cookies → 302 to
//               role-appropriate page (agents → /crm.html, else /dashboard.html).
// Fragment branch: serve a small HTML shim that POSTs the tokens back to
//               /api/auth/session, then redirects to /api/auth/callback?next=
//               so this same role-routing logic runs.

import { adminClient, userClient } from '../supabase.js';

const COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600';

function setSessionCookies(res, access_token, refresh_token) {
  res.setHeader('Set-Cookie', [
    `sb-access-token=${encodeURIComponent(access_token)}; ${COOKIE_OPTS}`,
    `sb-refresh-token=${encodeURIComponent(refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  ]);
}

async function landingForUser(userId) {
  if (!userId) return '/dashboard.html';
  try {
    const { data } = await adminClient()
      .from('users').select('role').eq('id', userId).maybeSingle();
    const role = data?.role || 'buyer';
    if (role === 'agent_sara' || role === 'agent_james' || role === 'admin') return '/crm.html';
    if (role === 'seller') return '/seller.html';
    return '/dashboard.html';
  } catch {
    return '/dashboard.html';
  }
}

export default async function handler(req, res) {
  const url     = new URL(req.url, `https://${req.headers.host}`);
  const code    = url.searchParams.get('code');
  const nextOv  = url.searchParams.get('next');   // explicit override wins
  const token   = url.searchParams.get('access_token'); // post-shim re-entry

  // Re-entry from the fragment-shim path: cookies are already set, we just
  // need to figure out the role and redirect.
  if (token && !code) {
    try {
      const { data: { user } } = await adminClient().auth.getUser(token);
      const dest = nextOv || await landingForUser(user?.id);
      res.statusCode = 302;
      res.setHeader('Location', dest);
      return res.end();
    } catch (e) {
      res.statusCode = 500;
      return res.end(`callback role lookup failed: ${e.message}`);
    }
  }

  if (code) {
    try {
      const supa = userClient(null);
      const { data, error } = await supa.auth.exchangeCodeForSession(code);
      if (error) {
        res.statusCode = 400;
        return res.end(`auth callback failed: ${error.message}`);
      }
      setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      const dest = nextOv || await landingForUser(data.user?.id);
      res.statusCode = 302;
      res.setHeader('Location', dest);
      return res.end();
    } catch (e) {
      res.statusCode = 500;
      return res.end(`auth callback error: ${e.message}`);
    }
  }

  // Fragment / implicit fallback — render a tiny shim that posts tokens back
  // to /api/auth/session (sets the cookies), then re-enters this endpoint
  // with ?access_token=... so role-based routing fires.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const overrideNext = nextOv ? `&next=${encodeURIComponent(nextOv)}` : '';
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
  location.replace('/api/auth/callback?access_token=' + encodeURIComponent(at) + '${overrideNext}');
})();
</script>
</body></html>`);
}
