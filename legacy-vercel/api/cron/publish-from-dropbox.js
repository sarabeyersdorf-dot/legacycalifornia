// api/cron/publish-from-dropbox.js
//
// Purpose: replaces the "Cowork pushes deals.json to GitHub" step with a
// server-side job that Vercel runs on its own schedule. This is the ONLY
// place that ever needs the GitHub token and the Dropbox token — both live
// in Vercel's environment variables, never in a Cowork/Claude shell command.
//
// What it does, every time it runs:
//   1. Refreshes a Dropbox access token (using a long-lived refresh token).
//   2. Downloads the current deals.json from Dropbox.
//   3. Validates it parses as JSON (never publishes broken JSON).
//   4. Commits it to GitHub at legacy-vercel/data/deals.json (only if
//      content changed).
//   5. Calls the existing /api/cron/sync-deals endpoint so Supabase / the
//      portal pick up the change immediately.
//
// Trigger: GET https://legacycalifornia.vercel.app/api/cron/publish-from-dropbox?key=<PUBLISH_SECRET>
//
// Required environment variables (Vercel -> Project -> Settings -> Environment Variables):
//   PUBLISH_SECRET        - any password you choose, protects this endpoint
//   GITHUB_TOKEN          - PAT scoped to sarabeyersdorf-dot/legacycalifornia,
//                           Contents: Read and write
//   DROPBOX_APP_KEY       - from your Dropbox App Console
//   DROPBOX_APP_SECRET    - from your Dropbox App Console
//   DROPBOX_REFRESH_TOKEN - long-lived refresh token from the one-time OAuth setup
//   DROPBOX_DEALS_PATH    - optional, defaults to "/_LEGACY/Legacy Cowork/deals.json"
//   SYNC_SECRET           - the existing secret your /api/cron/sync-deals already uses
//
// GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, and GITHUB_FILE_PATH are fixed
// values (this repo layout never moves day-to-day), so they're hardcoded
// below instead of being one more thing that can be mistyped in Vercel.
//
// NOTE: this project's package.json has "type": "module", so this file uses
// `export default`, not `module.exports`.

const GITHUB_OWNER = "sarabeyersdorf-dot";
const GITHUB_REPO = "legacycalifornia";
const GITHUB_BRANCH = "main";
// The Vercel project root lives inside this subfolder of the repo -- the
// GitHub Contents API always wants the FULL repo-relative path, regardless
// of what Vercel's own "Root Directory" project setting is.
const GITHUB_FILE_PATH = "legacy-vercel/data/deals.json";

export default async function handler(req, res) {
  const {
    PUBLISH_SECRET,
    GITHUB_TOKEN,
    DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN,
    DROPBOX_DEALS_PATH,
    SYNC_SECRET,
  } = process.env;

  // --- auth check ---
  if (!PUBLISH_SECRET || req.query.key !== PUBLISH_SECRET) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return;
  }

  const dropboxPath = DROPBOX_DEALS_PATH || "/_LEGACY/Legacy Cowork/deals.json";
  const steps = {};

  try {
    // --- 1. Refresh Dropbox access token ---
    const tokenResp = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${DROPBOX_APP_KEY}:${DROPBOX_APP_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: DROPBOX_REFRESH_TOKEN,
      }),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      throw new Error(
        `Dropbox token refresh failed: ${tokenResp.status} ${JSON.stringify(tokenJson)}`
      );
    }
    const dropboxAccessToken = tokenJson.access_token;
    steps.dropboxAuth = "ok";

    // --- 2. Download deals.json from Dropbox ---
    const downloadResp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxAccessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
      },
    });
    if (!downloadResp.ok) {
      const errText = await downloadResp.text();
      throw new Error(`Dropbox download failed: ${downloadResp.status} ${errText}`);
    }
    const dealsText = await downloadResp.text();
    steps.dropboxDownload = `ok (${dealsText.length} bytes)`;

    // --- 3. Validate JSON before publishing anything ---
    let parsed;
    try {
      parsed = JSON.parse(dealsText);
    } catch (e) {
      throw new Error(`Downloaded deals.json does not parse as JSON: ${e.message}`);
    }
    steps.jsonValid = `ok (version ${parsed.version}, lastUpdated ${parsed.lastUpdated})`;

    // --- 4. Commit to GitHub (only if content actually changed) ---
    const contentsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    steps.githubRequestUrl = `${contentsUrl}?ref=${GITHUB_BRANCH}`;

    const getResp = await fetch(`${contentsUrl}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
    if (!getResp.ok) {
      const errText = await getResp.text();
      throw new Error(`GitHub GET failed: ${getResp.status} ${errText}`);
    }
    const getJson = await getResp.json();
    const currentContent = Buffer.from(getJson.content, "base64").toString("utf-8");

    if (currentContent.trim() === dealsText.trim()) {
      steps.githubCommit = "skipped (no changes)";
    } else {
      const putResp = await fetch(contentsUrl, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Publish deals.json v${parsed.version} (${parsed.lastUpdated}) via Vercel cron`,
          content: Buffer.from(dealsText, "utf-8").toString("base64"),
          sha: getJson.sha,
          branch: GITHUB_BRANCH,
        }),
      });
      if (!putResp.ok) {
        const errText = await putResp.text();
        throw new Error(`GitHub PUT failed: ${putResp.status} ${errText}`);
      }
      steps.githubCommit = "ok (pushed new version)";
    }

    // --- 5. Trigger the existing Supabase sync ---
    const syncUrl = `https://legacycalifornia.vercel.app/api/cron/sync-deals?key=${SYNC_SECRET}`;
    const syncResp = await fetch(syncUrl);
    const syncJson = await syncResp.json().catch(() => ({}));
    steps.supabaseSync = syncResp.ok ? `ok ${JSON.stringify(syncJson)}` : `failed (${syncResp.status})`;

    res.status(200).json({ success: true, steps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, steps });
  }
}
