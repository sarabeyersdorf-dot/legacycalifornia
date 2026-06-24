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
- Email: Resend (primary)
- IDX: iHomefinder Optima IDX
- Temporary mirror: Follow Up Boss (deleted in January)

## User personas
- **Sara Cooper** — broker-owner, primary CRM user
- **James Cooper** — partner agent
- **Buyer** — magic-link auth, dashboard view
- **Seller** — magic-link auth, seller portal view

## Code architecture
```
legacy-vercel/
├── api/
│   ├── _lib/
│   │   ├── handlers/   # one file per route action — registered in dispatchers
│   │   └── *.js        # shared helpers (supabase, anthropic, auth, twilio, resend, cors)
│   ├── ai/, auth/, crm/, idx/, seller/, sequences/   # [action].js dispatchers (1 fn each)
│   ├── leads/intake.js, me/dashboard.js, fub/sync.js  # one-off endpoints
│   └── listings.js, listing.js, photo.js              # IDX-facing endpoints
├── db/                # Supabase SQL migrations 001…006
├── public/            # HTML/CSS visual layer (do NOT modify) + legacy-client.js
└── scripts/           # one-off operational scripts (e.g. import_legacy_leads.mjs)
```

## What's been implemented

### Phase 1A–1C (2026-01)
- DB schema + RLS, Auth (`/api/auth/*`), Lead intake, AI welcome/draft/score, FUB temporary mirror, frontend wiring via single `legacy-client.js`.

### Phase 1D–1I (2026-02)
- **1D — CRM live data**: `/api/crm/[action].js` dispatcher; morning brief cached 4h.
- **1E — Buyer dashboard**: `/api/me/dashboard.js`; auth gate + mock-flash elimination.
- **1F — Seller portal**: `/api/seller/[action].js` → portal; `db/003_seller_portal.sql`.
- **1G — Sequences**: `/api/sequences/[action].js`; daily cron drafts next step → pending_approval; Tuesday digest via Resend.
- **1I — iHomefinder IDX**: `/api/idx/[action].js` → behavioral webhook + 4h listings sync.
- CRM Live Wiring: Inbox / Pipeline / Detail panels read+write Supabase.
- `PATCH /api/crm/lead` (kanban drag + reassign).
- `POST /api/crm/message` (manual composer).
- `POST /api/crm/note` (Agent-only RLS, `db/005_lead_notes.sql`).
- Sidebar roster, tab-strip counts, 4 today-view panels (signals, deals, hours, funnel) wired to live data.
- Vercel function count: 12/12 (Hobby tier ceiling) — all new endpoints via dispatchers.

### Phase 1J (2026-06)
- **CSV Lead Import** (`POST /api/crm/import-leads` via `crm/[action].js`):
  - `kind='leads'`: parse + dedupe + bulk insert
  - `kind='consent'`: apply per-channel opt-outs + sphere stage + DNC promotion
  - `kind='delete_test'`: clean up seeded test rows
- `db/006_consent_and_sphere.sql`: per-channel opt-outs, `sphere` pipeline stage, `do_not_contact` status, dedupe + contactability indexes.
- Sequences cron respects opt-outs + DNC + sphere gate.
- Frontend import modal added to crm.html via data-* hooks only.
- **One-time CSV import executed against live Supabase** (2026-06-21):
  - 2,016 legacy leads inserted from `legacy_leads_import.csv`
  - 692 consent rows applied (38 → DNC, 42 → sphere)
  - 3 seeded test rows deleted
- **`scripts/import_legacy_leads.mjs`**: dedupe-aware standalone import (uses PostgREST via plain fetch — no SDK deps).
- **GET /api/crm/metrics** (new dispatcher action) replaces all remaining hardcoded numbers on crm.html:
  - Today-foot Day list (drafts → radio-silence → tours → new leads, max 6)
  - Today-foot Yesterday-at-a-glance (emails sent, drafts, showings, new leads, $ pipeline added, inbox-handled %)
  - Pipeline header KPIs (expected this month, closing this week, tour→offer rate)
  - Reports closed-volume bar chart (last 5 calendar months)
  - Reports recent-closings table (last 6 close-stage leads)
  - Reports KPI cards (trailing 12mo volume, transactions, avg price)

## Static / locked
- Visual design — every HTML/CSS file
- Schema field names — match spec exactly
- Direct Anthropic API only

## Backlog
- **P1** — Visual polish: about.html rebuild (currently 404 from index/how-we-work links).
- **P2** — AI-draft Discard, Regenerate, Schedule tour, Call button endpoints.
- **P2** — Phase 2: delete `/api/fub/sync.js` + `fub_id` column when FUB contract ends.
- **P2** — Enrichment: deeper iHomefinder feed mapping once we see real payloads.
- **P3** — When real "sold" data starts flowing (post first close), revisit `crm-metrics.js` to source `closed_by_month` + `recent_closings` from a future `transactions` table instead of `pipeline_stage='close'` leads.

## Next action items
1. Sign into the CRM as Sara and verify all panels paint live data:
   `legacycalifornia.vercel.app/crm.html` → email `sarasellscalifornia@gmail.com`.
2. Inspect Today / Pipeline / Reports views — confirm no hard-coded numbers remain.
3. Trigger a test sequence enroll on one of the new leads to validate opt-out skipping.

## Credentials
- Email: `sarasellscalifornia@gmail.com` (Agent CRM access; password held by Sara)
