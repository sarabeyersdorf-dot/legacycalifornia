/* ==========================================================================
   /api/ledger  —  serves The Ledger to ledger.html
   Legacy Properties · legacycalifornia.com
   Created 2026-07-29

   WHY THIS FILE EXISTS
   ---------------------------------------------------------------------------
   ledger.html fetches `/api/ledger` on load. That route did not exist, so the
   page rendered "Error: api 404". This is the missing half.

   Deploy location: `api/ledger.js` in the repo root (Vercel maps the file path
   to the URL, so `api/ledger.js` → `/api/ledger`). Matches the existing
   `/api/listings` convention.

   EXPORT STYLE: this project is an ES module (package.json "type":"module" and
   api/listings.js uses `export default async function handler`). The original
   draft used CommonJS `module.exports`, which fails to load here — converted to
   `export default` to match the project. Logic is otherwise unchanged.

   WHAT IT RETURNS
   ---------------------------------------------------------------------------
     GET /api/ledger              → newest published issue + archive index
     GET /api/ledger?slug=2026-08 → that specific issue (if published) + index

     {
       "issue":  { ...full row including content and sources... } | null,
       "issues": [ { slug, issue_month, volume, issue_no, title, dek,
                     tags, reading_time } ]        // newest first, index only
     }

   `issue: null` is a normal 200 response, not an error — it means nothing is
   published yet. ledger.html renders "The next issue is on its way" for that
   case. Do not turn it into a 404: a 404 tells search engines the page is
   broken, when in fact it is simply between issues.

   *** SECURITY: WHY THE ANON KEY AND NOT THE SERVICE-ROLE KEY ***
   ---------------------------------------------------------------------------
   This route deliberately uses the PUBLISHABLE (anon) key.

   `ledger_issues` has row-level security on, with a policy that lets anonymous
   readers see only rows where `status = 'published'`. Verified 2026-07-29: with
   one draft row in the table, an anon read returns zero rows.

   The service-role key bypasses RLS completely. If this route used it, the only
   thing keeping an unpublished draft off the public internet would be the query
   string below — one forgotten filter, one refactor, one clever `?slug=`, and
   Sara's unreviewed draft ships. With the anon key the database itself refuses,
   so a bug here produces an empty response instead of a leak.

   Concretely: right now there IS an unpublished August draft sitting in that
   table. Do not "fix" a preview feature by swapping in the service-role key.

   NO DRAFT PREVIEW HERE, ON PURPOSE
   ---------------------------------------------------------------------------
   Previewing drafts would require bypassing RLS, which is exactly the risk
   above. Sara reviews each issue from the self-contained
   `Ledger_<Month>_PREVIEW.html` file generated with the draft baked in — no
   endpoint, no key, no exposure. If a live draft preview is ever genuinely
   needed, put it behind the existing agent auth (`current_role_is_agent()`),
   never behind a shared token.
========================================================================== */

/* Accept the common env-var spellings so this works whatever the project
   already uses. First non-empty wins. */
function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = process.env[arguments[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

var SUPABASE_URL = pick(
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL'
);

/* Publishable / anon key ONLY. Note SUPABASE_SERVICE_ROLE_KEY is deliberately
   absent from this list — see the security note above. */
var SUPABASE_KEY = pick(
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY'
);

var TABLE = 'ledger_issues';

/* Columns for the archive list. Deliberately excludes `content`, `sources` and
   `review_notes` — review_notes are Sara's private editorial notes and must
   never reach the browser, and shipping every issue's full content in the index
   would balloon the payload for no reason. */
var INDEX_COLS = [
  'slug', 'issue_month', 'volume', 'issue_no',
  'title', 'dek', 'tags', 'reading_time'
].join(',');

/* Full issue columns. `review_notes`, `generated_by` and `status` are omitted
   on purpose: internal only. */
var ISSUE_COLS = [
  'slug', 'issue_month', 'volume', 'issue_no', 'send_date',
  'title', 'dek', 'hero_image_url', 'tags', 'reading_time',
  'content', 'sources', 'published_at'
].join(',');

function sbFetch(path) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json'
    }
  }).then(function (r) {
    if (!r.ok) {
      return r.text().then(function (t) {
        var err = new Error('supabase ' + r.status + ': ' + t.slice(0, 300));
        err.status = r.status;
        throw err;
      });
    }
    return r.json();
  });
}

export default async function handler(req, res) {
  /* read-only endpoint */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    /* Name the missing vars in the log so this is a two-minute fix, but do not
       put configuration detail in the client response. */
    console.error(
      '[api/ledger] Missing env config. Need SUPABASE_URL and ' +
      'SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) set in Vercel. ' +
      'Have URL: ' + Boolean(SUPABASE_URL) + ', key: ' + Boolean(SUPABASE_KEY)
    );
    return res.status(500).json({ error: 'Ledger is not configured yet.' });
  }

  try {
    var slug = req.query && req.query.slug ? String(req.query.slug) : null;

    /* Reject anything that is not a plain slug before it reaches the query
       string. Belt-and-braces — PostgREST params are encoded below anyway. */
    if (slug && !/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
      return res.status(400).json({ error: 'Bad slug' });
    }

    /* `status=eq.published` is redundant given RLS, and that is the point:
       two independent things would both have to fail to expose a draft. */
    var issueQuery = TABLE +
      '?select=' + encodeURIComponent(ISSUE_COLS) +
      '&status=eq.published' +
      (slug
        ? '&slug=eq.' + encodeURIComponent(slug)
        : '&order=issue_month.desc&limit=1');

    var indexQuery = TABLE +
      '?select=' + encodeURIComponent(INDEX_COLS) +
      '&status=eq.published' +
      '&order=issue_month.desc&limit=60';

    var results = await Promise.all([sbFetch(issueQuery), sbFetch(indexQuery)]);
    var issueRows = results[0] || [];
    var indexRows = results[1] || [];

    var issue = issueRows.length ? issueRows[0] : null;

    /* A slug that exists but is not published, or does not exist at all, is a
       genuine 404 — the visitor asked for a specific thing that is not there. */
    if (slug && !issue) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(404).json({ error: 'No published issue with that slug.' });
    }

    /* CDN cache. The Ledger changes once a month, so serving a cached copy for
       ten minutes and revalidating in the background costs nothing and makes
       the page fast. stale-while-revalidate means a reader never waits on a
       cold function. Bump s-maxage down if a correction needs to go out fast,
       or purge the Vercel cache. */
    res.setHeader('Cache-Control',
      'public, s-maxage=600, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    return res.status(200).json({ issue: issue, issues: indexRows });

  } catch (err) {
    /* Log the real error server-side; return something generic. Supabase error
       bodies can echo query structure, which is not for the public. */
    console.error('[api/ledger]', err && err.message ? err.message : err);
    return res.status(502).json({ error: 'Could not load the Ledger.' });
  }
}
