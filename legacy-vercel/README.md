# Legacy Properties — Website (Vercel)

Boutique real estate site for the California Gold Country (Calaveras · Amador · Tuolumne),
with a live MetroList (RESO Web API) IDX integration.

## Folder layout (important)
```
public/        ← all static pages, CSS, JS, images, hero video  (served at the domain root)
api/           ← Vercel serverless functions (the MLS feed)
vercel.json    ← function + caching config
package.json
.env.example   ← copy your MetroList credentials from here into Vercel env vars
```
> `public/index.html` becomes the homepage at `/`. `api/listings.js` is reachable at `/api/listings`, etc.
> Do **not** move the static files out of `public/` or the functions out of `api/`.

## Deploy to Vercel
1. Push this folder to a GitHub repo (the contents at the repo root, so `public/` and `api/`
   are top-level folders in the repo).
2. In Vercel: **Add New → Project → Import** the repo.
3. Settings should auto-detect:
   - Framework Preset: **Other**
   - Build Command: *(empty)*
   - Output Directory: *(empty — Vercel serves `public/`)*
   - Root Directory: *(empty)*
4. Add environment variables from `.env.example` under **Settings → Environment Variables**
   (the MetroList RESO Web API credentials).
5. Deploy. Every push to GitHub auto-deploys.

Until the MetroList env vars are set, listings pages fall back to built-in sample cards
with a small "Preview data" badge — nothing breaks.

## Local development
```
npm install -g vercel
vercel dev      # serves public/ + api/ at http://localhost:3000
```

## Notes
- Font stack (Cormorant Garamond · Manrope · JetBrains Mono) is loaded in `public/legacy.css`.
- `public/art/sara-headshot.png` and `public/art/james-headshot.png` are referenced site-wide.
- MetroList integration: `api/*.js` + `public/idx-client.js` + `vercel.json`.
