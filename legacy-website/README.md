# Legacy Properties — Website

Boutique real estate site for the California Gold Country (Calaveras · Amador · Tuolumne),
with a live MetroList (RESO Web API) IDX integration.

## Stack
- Static HTML/CSS/JS marketing site (no build step)
- `api/*.js` — Vercel serverless functions for the MLS feed
- `vercel.json` — routing + function config

## Deploy to Vercel
1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** the repo.
3. No build command needed — Vercel auto-detects `vercel.json` and the `api/` functions.
4. Add environment variables (see `.env.example`) under
   **Settings → Environment Variables**:
   - the MetroList RESO Web API credentials / token
5. Deploy. Every push to GitHub auto-deploys.

Until the MetroList env vars are set, the listings pages fall back to built-in
sample cards and show a small "Preview data" badge — nothing breaks.

## Local development
```
npm install -g vercel
vercel dev          # serves the site + api/ functions at localhost:3000
```

## Project map
| Path | What it is |
|------|------------|
| `index.html` | Homepage (hero video) |
| `listings.html`, `listing.html` | IDX listings index + detail (live MLS via `api/`) |
| `towns.html`, `town-*.html` | Community pages |
| `ledger.html`, `ledger-issue.html` | "The Legacy Ledger" newsletter |
| `relocate.html`, `seller.html`, `about.html`, `how-we-work.html` | Marketing pages |
| `commute.html`, `fire-zone.html`, `river-mountain.html` | Editorial / tool pages |
| `dashboard.html`, `crm.html`, `platform.html` | Client dashboard + internal CRM |
| `legacy.css` + page CSS | Styles (Cormorant Garamond · Manrope · JetBrains Mono) |
| `idx-client.js` | Browser client for the IDX API |
| `api/*.js` | Vercel serverless functions (MetroList integration) |
| `art/` | Headshots referenced across the site |
| `hero-video.mp4` | Homepage hero background |

## Notes
- Do not change the font stack (loaded in `legacy.css`).
- `art/sara-headshot.png` and `art/james-headshot.png` are referenced site-wide — keep them.
- The MetroList integration lives in `api/` + `idx-client.js` + `vercel.json`.
