// api/auth/[action].js
// Single dispatcher serving all auth URLs:
//   POST /api/auth/login        → auth-login
//   POST /api/auth/magic-link   → auth-magic-link
//   GET  /api/auth/callback     → auth-callback
//   GET/POST/DELETE /api/auth/session → auth-session
//   POST /api/auth/logout       → auth-logout
//   GET  /api/auth/config       → auth-config
//
// Counts as ONE serverless function on Vercel.

import login    from '../_lib/handlers/auth-login.js';
import magic    from '../_lib/handlers/auth-magic-link.js';
import callback from '../_lib/handlers/auth-callback.js';
import session  from '../_lib/handlers/auth-session.js';
import logout   from '../_lib/handlers/auth-logout.js';
import config   from '../_lib/handlers/auth-config.js';

const TABLE = {
  'login':       login,
  'magic-link':  magic,
  'callback':    callback,
  'session':     session,
  'logout':      logout,
  'config':      config
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown auth action: ${action}` }));
  }
  return fn(req, res);
}
