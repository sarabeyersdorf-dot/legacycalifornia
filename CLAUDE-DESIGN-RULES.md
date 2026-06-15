# Claude Design Rules
## For AI assistants working on this repo — READ BEFORE TOUCHING ANYTHING

---

## What This Repo Is

A boutique real estate platform for Legacy Properties (Angels Camp, CA) built on:
- **Frontend:** Static HTML/CSS/JS in `legacy-vercel/public/` — deployed on Vercel
- **Backend:** Vercel serverless functions in `legacy-vercel/api/` — do not touch
- **Database:** Supabase (schema in `legacy-vercel/db/`) — do not touch
- **AI:** Direct Anthropic API, model `claude-sonnet-4-6` — do not change
- **Email:** Resend (`RESEND_API_KEY`) — do not change
- **SMS:** Twilio — do not change
- **Auth:** Supabase Auth (magic link for buyers/sellers, password for agents)

---

## YOU MAY EDIT — frontend only

- Any `.html` file in `legacy-vercel/public/`
- Any `.css` file in `legacy-vercel/public/`
- Static images and assets in `legacy-vercel/public/`
- New HTML pages added to `legacy-vercel/public/`
- Copy, layout, styling, design updates

---

## YOU MAY NOT TOUCH — ever

- `legacy-vercel/api/` — all serverless functions (auth, leads, AI, Twilio, Resend, FUB)
- `legacy-vercel/db/` — Supabase schema, RLS policies, seed data
- `legacy-vercel/package.json` — dependencies
- `legacy-vercel/public/legacy-client.js` — this is the frontend/backend bridge that wires forms to the live API. Modifying it breaks lead capture, auth gating, and tour booking.
- `.env` or any environment variable files
- `vercel.json` if it exists

---

## WORKFLOW — How Changes Get Live

Claude Design CANNOT push to GitHub directly. GitHub access is read-only.
The deployment loop works like this:

```
1. Claude Design edits a file in the design environment
         ↓
2. Claude Design shows Sara the finished file with exact file path
         ↓
3. Sara goes to github.com → sarabeyersdorf-dot/legacycalifornia
         ↓
4. Sara navigates to the file path shown → clicks pencil icon (✏️) to edit
         ↓
5. Sara pastes the new file contents → clicks "Commit changes"
         ↓
6. Vercel detects the commit and auto-deploys within 60 seconds
         ↓
7. Changes are live at legacycalifornia.vercel.app ✅
```

**Supabase is NOT affected by frontend commits.** The database only changes
when SQL is run directly in the Supabase dashboard. Never ask Claude Design
to modify database structure or data.

### When handing off a file to Sara, always provide:
- The exact file path from repo root (e.g. `legacy-vercel/public/index.html`)
- The complete file contents (not a diff, not a partial — the full file)
- A one-line description of what changed for the commit message

---

## BACKEND CONSTANTS — read only, never modify in code

| Constant | Value |
|---|---|
| AI model | `claude-sonnet-4-6` |
| AI endpoint | `https://api.anthropic.com/v1/messages` |
| Database | Supabase (see db/schema.sql for all tables) |
| Email | Resend via `RESEND_API_KEY` |
| Sender (temp) | `onboarding@resend.dev` (until domain is live) |
| Sender (final) | `sara@legacycalifornia.com` (after domain pointed) |
| SMS | Twilio via `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` |
| Sara's phone | `209-559-4966` |
| Hosting | Vercel — auto-deploys from main branch |
| Repo | `github.com/sarabeyersdorf-dot/legacycalifornia` |

---

## DESIGN SYSTEM — always use these values

| Token | Value |
|---|---|
| Background | `#F1F3F6` |
| Card background | `#FFFFFF` |
| Card border | `1px solid #E2E8F0` |
| Text primary | `#0F1C2E` |
| Gold accent | `#B8922A` |
| Indigo | `#4F46E5` |
| Status green | `#059669` |
| Status red | `#DC2626` |
| Heading font | Cormorant Garamond |
| Body font | DM Sans |

---

## CRITICAL DETAILS — never get these wrong

| Item | Correct Value |
|---|---|
| DRE number | `#02141987` — never `#0214187` |
| Broker name | Sara Cooper |
| Brokerage | Legacy Properties |
| Coverage area | Calaveras, Amador, El Dorado counties |
| Key towns | Angels Camp, Murphys, San Andreas, Copperopolis, Sutter Creek, Arnold |
| Website | legacycalifornia.com (domain not yet pointed — staging at legacycalifornia.vercel.app) |
| Phone | 209-559-4966 |

---

## PAGES IN THE SITE — reference

| File | Purpose |
|---|---|
| `index.html` | Homepage — journey selector, lead capture |
| `listings.html` | IDX property search (MetroListPRO Optima IDX embed) |
| `listing.html` | Single property detail + tour booking |
| `crm.html` | Agent desk — Sara's daily operating surface (auth gated) |
| `dashboard.html` | Buyer portal — saved homes, tours, messages (auth gated) |
| `seller.html` | Seller portal — listing performance, offers (auth gated) |
| `platform.html` | Platform overview page |
| `ledger.html` | The Ledger — market intelligence blog |
| `about.html` | About Sara and Legacy Properties |
| `relocate.html` | Bay Area relocation landing page |
| `fire-zone.html` | Fire zone information tool |
| `commute.html` | Commute calculator tool |

---

## PHASES ALREADY BUILT — do not rebuild or overwrite

- ✅ Phase 1A — Supabase schema, RLS, auth
- ✅ Phase 1B — Lead intake (all forms wired to `/api/leads/intake`)
- ✅ Phase 1C — AI welcome drafts, lead scoring, FUB sync
- ⬜ Phase 1D — CRM live data (next Emergent session)
- ⬜ Phase 1E — Buyer dashboard live data
- ⬜ Phase 1F — Seller portal live data
- ⬜ Phase 1G — Sequences cron engine
- ⬜ Phase 1H — FUB sync (remove January 2027)
- ⬜ Phase 1I — MetroListPRO Optima IDX behavioral webhook

---

## WHEN EMERGENT TOKENS REFRESH

Resume with this prompt:
> "I have a fully designed real estate platform live at legacycalifornia.vercel.app.
> Phases 1A, 1B, and 1C are complete and live. Read CLAUDE-DESIGN-RULES.md
> before touching anything. The next phase is 1D — CRM live data. Replace
> hardcoded data in crm.html with live Supabase queries per the build spec.
> Run git remote add origin https://github.com/sarabeyersdorf-dot/legacycalifornia.git
> before any commits. Do not modify any HTML/CSS. Begin."

---

*Legacy Properties · Angels Camp, CA · DRE #02141987*
*Rules version 1.0 · June 2026*
