// api/ledger.js — public read endpoint for The Ledger
//
// GET /api/ledger                  → { issues: [ ...index rows, newest first ], current: {...} | null }
// GET /api/ledger?slug=2026-08     → { issue: { ...full issue }, issues: [ ...index ] }  (404 if not published)
// GET /api/ledger?tag=Murphys      → { issues: [ ...filtered ] }
// GET /api/ledger?limit=6
//
// This is the build-folder version (documented contract in HANDOFF.md, supports
// ?tag / ?limit). Two changes from the Dropbox copy, both deliberate:
//   1. module.exports → export default — this project is an ES module
//      (package.json "type":"module"; api/listings.js uses export default).
//   2. Env vars read via an ANON-ONLY lookup that tries the spellings this repo
//      actually uses. Carried over from the hardened api-ledger.js: the list
//      contains NO service-role names, so the route cannot start on a
//      service-role key. RLS (status='published') is what hides drafts.
//
// Column lists (INDEX_COLS / FULL_COLS) deliberately exclude `review_notes`
// (Sara's private editorial notes) and `generated_by` — confirmed, they never
// reach the browser.

function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = process.env[arguments[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

// URL spellings used across this project.
const SUPABASE_URL = pick(
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL'
);

// Anon / publishable key ONLY. No service-role names here, on purpose.
const SUPABASE_ANON_KEY = pick(
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY'
);

// Columns returned for the archive index (keep the payload small — no body).
const INDEX_COLS = [
  'slug', 'issue_month', 'volume', 'issue_no', 'send_date',
  'title', 'dek', 'hero_image_url', 'tags', 'reading_time', 'published_at',
].join(',');

const FULL_COLS = [
  INDEX_COLS, 'content', 'sources',
].join(',');

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`supabase ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'missing_supabase_env' });
  }

  try {
    const { slug, tag, limit } = req.query || {};

    // ---- single issue -------------------------------------------------
    if (slug) {
      const safeSlug = String(slug).slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, '');
      const rows = await sb(
        `ledger_issues?slug=eq.${encodeURIComponent(safeSlug)}` +
        `&status=eq.published&select=${FULL_COLS}&limit=1`
      );
      if (!rows.length) return res.status(404).json({ error: 'not_found' });

      // Also hand back a lightweight archive so the page can render prev/next
      // and the sidebar from a single request.
      const index = await sb(
        `ledger_issues?status=eq.published&select=${INDEX_COLS}` +
        `&order=issue_month.desc&limit=36`
      );

      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.status(200).json({ issue: rows[0], issues: index });
    }

    // ---- index / archive ----------------------------------------------
    const n = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 60);
    let path =
      `ledger_issues?status=eq.published&select=${INDEX_COLS}` +
      `&order=issue_month.desc&limit=${n}`;

    if (tag) {
      const safeTag = String(tag).slice(0, 40).replace(/[^a-zA-Z0-9 &'-]/g, '');
      path += `&tags=cs.${encodeURIComponent(`{"${safeTag}"}`)}`;
    }

    const issues = await sb(path);

    // The newest issue comes back complete so the page's hero can render
    // without a second round trip.
    let current = null;
    if (issues.length && !tag) {
      const full = await sb(
        `ledger_issues?slug=eq.${encodeURIComponent(issues[0].slug)}` +
        `&status=eq.published&select=${FULL_COLS}&limit=1`
      );
      current = full[0] || null;
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ issues, current });
  } catch (err) {
    console.error('[api/ledger]', err.message);
    return res.status(500).json({ error: 'ledger_unavailable' });
  }
}
