# Legacy Properties — PRD

## Problem statement (verbatim, condensed)
Wire real backends into the fully-designed Legacy Platform prototype hosted at
`legacycalifornia.vercel.app` to replace Ylopo ($2K/mo) and Follow Up Boss with
a single owned system. Build on Vercel + Supabase + direct Anthropic API.
Never modify HTML/CSS — add backend functionality only.

## Tech stack (locked by spec)
- Hosting: Vercel
- DB / Auth / Storage: Supabase
- AI: direct `https://api.anthropic.com/v1/messages`, model `claude-sonnet-4-6` (no wrappers, no emergentintegrations)
- SMS: Twilio
- Email: MailerLite
- IDX: MetroListPRO Optima IDX (account #230389)
- Temporary mirror: Follow Up Boss (deleted in January)

## User personas
- **Sara Cooper** — broker-owner, primary CRM user
- **James Cooper** — partner agent
- **Buyer** — magic-link auth, dashboard view
- **Seller** — magic-link auth, seller portal view

## What's been implemented (Phase 1A + 1B + 1C — 2026-01)
- **DB**: `db/schema.sql`, `db/rls_policies.sql`, `db/seed_sequences.sql` (7 default sequences)
- **Auth**: `/api/auth/{login, magic-link, callback, session, logout, config}.js`
- **Lead intake**: `/api/leads/intake.js` (single endpoint for every form on the site)
- **AI**: `/api/ai/{welcome, draft-reply, score-lead}.js` — direct Anthropic, drafts saved as `pending_approval`
- **Twilio alert**: hot-lead SMS to Sara at +1 209-559-4966 when `journey_stage = ready_to_offer`
- **FUB sync** (Phase 1 only): `/api/fub/sync.js`
- **Shared libs**: `api/_lib/{supabase, anthropic, auth, twilio, cors}.js`
- **Frontend wiring**: single `public/legacy-client.js` added via one `<script>` tag per page; no HTML/CSS structure changes. Wires: homepage journey selector, Find My Match (every page), Message Sara, Book a tour, listing.html tour scheduler + Send to Sara, auth gates for /crm.html, /dashboard.html, /seller.html.
- **DRE fix**: `#0214187` → `#02141987` across 16 HTML pages
- **`package.json`**: adds `@supabase/supabase-js`, declares ESM (`type: module`)
- **`.env.example`**: documents every required Vercel env var
- **README.md**: full Phase 1 setup + deploy guide

## Static / locked
- Visual design — every HTML/CSS file
- Schema field names — match spec exactly
- Direct Anthropic API only

## Backlog (priority order)
- **P0 — Phase 1D**: live CRM data (`/api/crm/{morning-brief, inbox, pipeline, approve-message, leads/[id]}.js`)
- **P0 — Phase 1E**: buyer dashboard (`/api/buyer/{dashboard, save-property, book-tour}.js`)
- **P1 — Phase 1F**: seller portal (`/api/seller/portal.js`)
- **P1 — Phase 1G**: sequences cron engine (`/api/cron/sequences.js`, `/api/sequences/enroll.js`)
- **P1 — Phase 1I**: MetroListPRO Optima IDX embed + `/api/idx/{sync, behavioral-webhook}.js`
- **P2 — Phase 2**: delete `/api/fub/sync.js` in January when FUB contract ends

## Next action items (for user)
1. Create the Supabase project; run the three SQL files in order.
2. Add all env vars in Vercel (see `.env.example`).
3. Deploy. Submit a test lead via the homepage to verify the full intake → AI draft → CRM-inbox loop.
4. Confirm Phase 1A/1B/1C work end-to-end, then unblock Phase 1D.
