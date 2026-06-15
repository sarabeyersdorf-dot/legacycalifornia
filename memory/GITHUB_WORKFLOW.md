# GitHub Auto-Commit Workflow

**Project:** Legacy Properties
**Repo:** `https://github.com/sarabeyersdorf-dot/legacycalifornia`
**Branch:** `main`
**Auto-deploy:** Vercel watches `main` and deploys within ~1 minute of every push.

---

## What this file documents

Sara has authorised E1 (this Emergent agent) to push directly to the GitHub
repo from the sandbox. The Personal Access Token lives **only** in the
sandbox's local git config (`/app/.git/config`) — it is never committed to
the repo tree.

This means: every time E1 makes a code change, E1 should commit and push
without waiting for the user to click "Save to GitHub".

---

## Standard push procedure (E1 runs after every change)

```bash
cd /app
git add -A
git commit -m "<short description of what changed>"
git push origin main
```

Vercel will auto-rebuild and deploy. The user verifies in:
- Vercel → Deployments (new entry, status Ready, no Stale tag)
- The relevant page on `https://legacycalifornia.vercel.app/`

If the push prints the token in stderr, mask it in the output shown to the
user:

```bash
git push origin main 2>&1 | sed 's/ghp_[A-Za-z0-9]*/ghp_***REDACTED***/g'
```

---

## Commit message conventions

- One imperative-mood line, ≤ 72 chars.
- Examples:
  - `fix: accept SUPABASE_SERVICE_ROLE_KEY env var name`
  - `feat: phase 1D morning brief endpoint`
  - `chore: ignore node_modules`
- Multi-change commits acceptable; longer-form notes go in the commit body
  after a blank line.

---

## When to push

Push after every logical unit of work that the user could observe:

- ✅ A new endpoint is wired up and ready to test on Vercel
- ✅ A bug fix that needs to be verified live
- ✅ A copy/content change in HTML
- ✅ DB schema changes (the SQL file change goes to GitHub even though the
  user must apply it in Supabase manually)
- ❌ Mid-edit, broken intermediate states
- ❌ `node_modules/` / `yarn.lock` regenerations on their own (use
  `.gitignore` to filter)

---

## Token rotation

If Sara wants to rotate the PAT:

1. Create a new fine-grained PAT at
   https://github.com/settings/tokens?type=beta
   - **Repository access**: select only `sarabeyersdorf-dot/legacycalifornia`
   - **Permissions** → Repository → **Contents: Read and write**
   - All other permissions: leave default (read-only metadata)
   - Expiry: 90 days or whatever Sara prefers
2. Revoke the old token at https://github.com/settings/tokens.
3. Tell E1 the new token; E1 will re-run:
   ```bash
   git remote set-url origin "https://sarabeyersdorf-dot:<NEW_TOKEN>@github.com/sarabeyersdorf-dot/legacycalifornia.git"
   git push --dry-run origin main   # verify
   ```

---

## Recovery: if the remote loses its token

The token is stored in the sandbox at `/app/.git/config` under
`[remote "origin"] url = ...`. If the sandbox is rebuilt or the config is
cleared, the user must hand E1 the token again to re-authenticate.

To check if the token is still configured (without printing it):

```bash
git config --get remote.origin.url | grep -q "ghp_" && echo "token present" || echo "token MISSING — ask Sara"
```

---

## Files NOT to commit

Already untracked, but worth noting:

- `legacy-vercel/node_modules/` — should be in `.gitignore` (TODO)
- `.env`, `.env.local` — never. Only `.env.example` is committed.
- Any file containing the PAT, Supabase service key, Anthropic key,
  Twilio token, FUB key, or MailerLite key.

---

## Quick reference: the full lifecycle

```
[E1 makes a code change in /app/legacy-vercel/]
    ↓
[E1 runs: cd /app && git add -A && git commit -m "..." && git push origin main]
    ↓
[GitHub receives the push at sarabeyersdorf-dot/legacycalifornia main]
    ↓
[Vercel webhook fires → new deployment built from latest commit]
    ↓
[~60 seconds later: green Ready in Vercel Deployments]
    ↓
[Sara verifies in incognito window at legacycalifornia.vercel.app]
```
