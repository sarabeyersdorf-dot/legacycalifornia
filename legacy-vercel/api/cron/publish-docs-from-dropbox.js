// api/cron/publish-docs-from-dropbox.js
//
// Publishes a deal's DOCUMENT FILES from Dropbox share folders to the site, so a
// client portal can load them — the missing counterpart to publish-from-dropbox
// (which only publishes deals.json, never the document files themselves).
//
// For each deal that declares a Dropbox folder (deals.json "docFolder"), this:
//   1. Lists the deal's share subfolders in Dropbox and reads the files in each.
//   2. Commits each file to legacy-vercel/public/docs/<deal>/<slug> in GitHub
//      (only when its bytes changed), so it's served at /docs/<deal>/<slug>.
//   3. Writes a repo-owned MANIFEST — legacy-vercel/data/portal-docs/<deal>.json —
//      listing every published doc with url + scope + visibility (from the FOLDER
//      it sat in) + an optional escrow link. The sync reads this manifest ALONGSIDE
//      deals.json clientDocuments, so folder placement drives portal documents.
//
// The manifest is a sync INPUT, not a direct DB write — the hourly rebuild reads
// it, so it can never be wiped. Visibility comes from the folder; the SPEC's
// fail-closed model still holds (nothing outside a share folder is published as
// client-visible), plus a type-based safety-narrowing that can only tighten.
//
// Trigger:
//   GET /api/cron/publish-docs-from-dropbox?key=<PUBLISH_SECRET>            (all deals)
//   GET /api/cron/publish-docs-from-dropbox?key=<PUBLISH_SECRET>&deal=433-hwy4  (one)
//
// Env (same secrets publish-from-dropbox already uses):
//   PUBLISH_SECRET, GITHUB_TOKEN, DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN, SYNC_SECRET

const GITHUB_OWNER = 'sarabeyersdorf-dot';
const GITHUB_REPO = 'legacycalifornia';
const GITHUB_BRANCH = 'main';
const DEALS_PATH = 'legacy-vercel/data/deals.json';
const DOCS_DIR = 'legacy-vercel/public/docs';           // served at /docs/...
const MANIFEST_DIR = 'legacy-vercel/data/portal-docs';  // read by the sync

// Folder name (case-insensitive, relative to a deal's docFolder) → visibility.
const FOLDER_VISIBILITY = [
  ['ex/seller only', 'seller'],
  ['ex/buyer only',  'buyer'],
  ['ex/private',     'agent_only'],
  ['share with seller', 'seller'],
  ['share with buyer',  'buyer'],
  ['share with both',   'both'],
  ['seller', 'seller'],     // legacy folder names Sara already uses
  ['buyer',  'buyer'],
  ['ex',     'both'],       // executed docs: both by default (keep LAST — prefix of others)
];

// Type-based safety-narrowing — can only TIGHTEN a folder's visibility, never widen.
function narrowByType(name, folderVis) {
  const n = name.toLowerCase();
  // Never client-visible.
  if (/(commission|broker.?comp|pre.?approval|proof.?of.?funds|lender|competing|prior.?offer|emd.?check|earnest.?money.?check)/.test(n)) return 'agent_only';
  // The buyer's own buyer-broker agreement → buyer only.
  if (/\bbrbc\b|buyer.?rep|buyer.?broker/.test(n)) return capNarrower(folderVis, 'buyer');
  // The listing agreement is seller-only even though it's a "property" doc.
  if (/\brla\b|listing.?agreement|residential.?listing/.test(n)) return capNarrower(folderVis, 'seller');
  return folderVis;
}
// Return the narrower of the folder's audience and a cap. 'both' widest; a specific
// side is narrower; agent_only narrowest. If the cap and the folder disagree on side,
// fall to agent_only (safe) rather than pick one.
function capNarrower(folderVis, cap) {
  if (folderVis === 'agent_only') return 'agent_only';
  if (folderVis === cap) return cap;
  if (folderVis === 'both') return cap;          // both → the capped side
  return 'agent_only';                            // seller-folder doc capped to buyer (or vice-versa) → hide
}

// scope by document type: disclosures / reports / listing paperwork survive an
// escrow (property); contract paperwork is archived with it (transaction).
function scopeByType(name) {
  const n = name.toLowerCase();
  if (/(tds|spq|nhd|fhds|wfa|avid|sbsa|mca|firpta|as\b|lpd|sfls|wildfire|water.?heater|carbon|\bco\b|well|septic|roof|hoa|earthquake|pest|prelim|preliminary.?title|lease|estoppel|\brla\b|listing.?agreement|\bmot\b|modification.?of.?terms|report)/.test(n)) {
    return 'property';
  }
  return 'transaction';
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}
function extOf(name) { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
// A tidy client-facing name from a filename (drop extension, separators → spaces).
function prettyName(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
}

async function dropboxToken(env) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.DROPBOX_REFRESH_TOKEN })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Dropbox token refresh failed: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

// List files (not folders) directly under a Dropbox path. Missing folder → []. Paginated.
async function listFolder(token, path) {
  const out = [];
  let resp = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: false })
  });
  if (resp.status === 409) return out;               // path not found → no such share folder
  if (!resp.ok) throw new Error(`list_folder ${path}: ${resp.status} ${await resp.text()}`);
  let j = await resp.json();
  const take = (entries) => { for (const e of entries) if (e['.tag'] === 'file') out.push(e); };
  take(j.entries);
  while (j.has_more) {
    resp = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: j.cursor })
    });
    if (!resp.ok) throw new Error(`list_folder/continue: ${resp.status}`);
    j = await resp.json();
    take(j.entries);
  }
  return out;
}

async function dropboxDownload(token, path) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) }
  });
  if (!r.ok) throw new Error(`download ${path}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

function ghHeaders(env) {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}
// Commit a file only if its bytes changed. Returns 'created' | 'updated' | 'unchanged'.
async function ghPutFile(env, repoPath, buffer, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
  const contentB64 = buffer.toString('base64');
  let sha = null, existing = null;
  const getR = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders(env) });
  if (getR.ok) { const g = await getR.json(); sha = g.sha; existing = (g.content || '').replace(/\n/g, ''); }
  if (existing && existing === contentB64) return 'unchanged';
  const putR = await fetch(url, {
    method: 'PUT', headers: ghHeaders(env),
    body: JSON.stringify({ message, content: contentB64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) })
  });
  if (!putR.ok) throw new Error(`GitHub PUT ${repoPath}: ${putR.status} ${await putR.text()}`);
  return sha ? 'updated' : 'created';
}
async function ghGetJson(env, repoPath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`GitHub GET ${repoPath}: ${r.status}`);
  const g = await r.json();
  return JSON.parse(Buffer.from(g.content, 'base64').toString('utf-8'));
}

export default async function handler(req, res) {
  const env = process.env;
  if (!env.PUBLISH_SECRET || req.query.key !== env.PUBLISH_SECRET) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  const onlyDeal = typeof req.query.deal === 'string' ? req.query.deal.trim() : '';
  const result = { deals: [], files_committed: 0, files_unchanged: 0, errors: [] };

  try {
    const token = await dropboxToken(env);
    const deals = (await ghGetJson(env, DEALS_PATH)).deals || [];
    const targets = deals.filter((d) => d && d.docFolder && (!onlyDeal || d.id === onlyDeal));

    for (const d of targets) {
      const dealId = d.id;
      const base = String(d.docFolder).replace(/\/+$/, '');
      const manifest = [];
      const seen = new Set();
      const dealOut = { deal: dealId, published: 0, unchanged: 0, folders: [] };
      // Prior manifest → skip re-downloading a file whose Dropbox rev is unchanged.
      let prevBySlug = new Map();
      try {
        const prev = await ghGetJson(env, `${MANIFEST_DIR}/${dealId}.json`);
        if (Array.isArray(prev)) prevBySlug = new Map(prev.map((e) => [String(e.url || '').split('/').pop(), e]));
      } catch (_) { /* no prior manifest yet */ }
      try {
        for (const [sub, folderVis] of FOLDER_VISIBILITY) {
          let files;
          try { files = await listFolder(token, `${base}/${sub}`); }
          catch (e) { result.errors.push({ deal: dealId, folder: sub, error: e.message }); continue; }
          if (!files.length) continue;
          dealOut.folders.push({ folder: sub, files: files.length, visibility: folderVis });
          for (const f of files) {
            try {
              const raw = String(f.name || '');
              // Skip system / hidden files BEFORE anything else: dotfiles
              // (.DS_Store, .dropbox, .dropbox.attr), macOS AppleDouble companions
              // (._Foo.pdf — these DO carry a real extension, so the whitelist alone
              // wouldn't catch them), and common OS cruft.
              if (/^\./.test(raw) || /^(thumbs\.db|desktop\.ini|\$recycle|icon\r?)$/i.test(raw)) continue;
              const slug = slugify(raw);
              if (!slug || seen.has(slug)) continue; // a file already handled by an earlier (narrower) folder wins
              seen.add(slug);
              const ext = extOf(raw);
              if (!['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'].includes(ext)) continue; // only real documents
              const repoPath = `${DOCS_DIR}/${dealId}/${slug}`;
              // Skip the download+commit when Dropbox says the bytes are unchanged
              // (same rev as the prior manifest). Classification is still recomputed.
              const prior = prevBySlug.get(slug);
              if (prior && prior.rev && prior.rev === f.rev) {
                dealOut.unchanged++; result.files_unchanged++;
              } else {
                const buf = await dropboxDownload(token, f.path_lower || `${base}/${sub}/${f.name}`);
                const outcome = await ghPutFile(env, repoPath, buf, `Publish ${dealId}/${slug} from Dropbox`);
                if (outcome === 'unchanged') { dealOut.unchanged++; result.files_unchanged++; }
                else { dealOut.published++; result.files_committed++; }
              }
              const visibility = narrowByType(f.name, folderVis);
              manifest.push({
                name: prettyName(f.name),
                url: `/docs/${dealId}/${slug}`,
                scope: scopeByType(f.name),
                visibility,
                key: `${dealId}-${slug.replace(/\.[a-z0-9]+$/, '')}`,
                rev: f.rev || null
              });
            } catch (e) { result.errors.push({ deal: dealId, file: f.name, error: e.message }); }
          }
        }
        // Write the manifest the sync reads (sorted for a stable diff).
        manifest.sort((a, b) => a.key.localeCompare(b.key));
        const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
        const mOutcome = await ghPutFile(env, `${MANIFEST_DIR}/${dealId}.json`, manifestBuf, `Update ${dealId} portal-docs manifest`);
        dealOut.manifest = mOutcome;
        dealOut.documents = manifest.length;
      } catch (e) {
        result.errors.push({ deal: dealId, error: e.message });
      }
      result.deals.push(dealOut);
    }

    // Nudge the sync so the new manifests land (best-effort; the hourly sync also picks them up post-deploy).
    try {
      const s = await fetch(`https://legacycalifornia.vercel.app/api/cron/sync-deals?key=${env.SYNC_SECRET}`);
      result.sync = s.ok ? 'ok' : `failed (${s.status})`;
    } catch (e) { result.sync = `error: ${e.message}`; }

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, ...result });
  }
}
