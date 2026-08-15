// Supabase Edge Function: newsletter
// ---------------------------------------------------------------------------
// Monthly newsletter sender via the SendGrid v3 API. This is the BULK path,
// deliberately separate from the CRM's Resend transactional path: bulk mail
// sends from the ROOT domain (legacycalifornia.com, SendGrid-authenticated),
// transactional sends from send.legacycalifornia.com (Resend). Separate
// domains + providers = isolated sender reputations, so a bad newsletter week
// can't take down magic-link delivery.
//
// SAFETY MODEL — read before touching:
//   * This function sends NOTHING on its own. There is no cron. Every send is
//     an explicit, authenticated, batched HTTP call.
//   * Warm-up is caller-controlled: send small batches (`limit`) and grow the
//     ceiling over the first few issues. Never blast the whole list at once
//     from a cold domain.
//   * Every recipient is re-checked against the opt-out gates at send time, and
//     every email carries an RFC 8058 one-click List-Unsubscribe pointing at the
//     CRM's own /api/unsubscribe (so SendGrid and leads.email_opt_out stay in
//     sync — keep SendGrid "Subscription Tracking" OFF).
//   * Idempotent: each (issue, recipient) send is recorded in newsletter_sends
//     (db/073); re-invoking during a ramp continues where it left off.
//
// Secrets (Supabase → Project → Edge Functions → Secrets):
//   NEWSLETTER_SECRET          required on every call (?key=… or Bearer …)
//   SENDGRID_API_KEY           Mail Send-scoped key (legacy-ledger-send-2)
//   SENDGRID_FROM_EMAIL        default sara@legacycalifornia.com
//   SENDGRID_FROM_NAME         default "Sara Cooper · Legacy Properties"
//   SENDGRID_REPLY_TO          default sarasellscalifornia@gmail.com
//   PUBLIC_SITE_URL            default https://legacycalifornia.com
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   auto-injected by Supabase
//
// API (POST JSON, auth via ?key= or `Authorization: Bearer <NEWSLETTER_SECRET>`):
//   { "mode": "resolve", "issue_slug": "june-2026" }
//     → { issue, contactable, already_sent, remaining, sample }   (no send)
//   { "mode": "send", "issue_slug": "june-2026", "limit": 200, "dry_run": true }
//     → { issue, would_send, sample, subject }                    (no send)
//   { "mode": "send", "issue_slug": "june-2026", "limit": 200 }
//     → { issue, sent, failed, skipped, remaining }
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";
const MAX_BATCH = 300;          // hard ceiling per call; warm-up wants far less
const DEFAULT_BATCH = 100;
const CONCURRENCY = 8;          // parallel SendGrid requests (one per recipient)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function env(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

const CFG = {
  secret:    env("NEWSLETTER_SECRET"),
  sgKey:     env("SENDGRID_API_KEY"),
  fromEmail: env("SENDGRID_FROM_EMAIL", "sara@legacycalifornia.com"),
  fromName:  env("SENDGRID_FROM_NAME", "Sara Cooper · Legacy Properties"),
  replyTo:   env("SENDGRID_REPLY_TO", "sarasellscalifornia@gmail.com"),
  site:      env("PUBLIC_SITE_URL", "https://legacycalifornia.com").replace(/\/+$/, ""),
  supaUrl:   env("SUPABASE_URL"),
  supaKey:   env("SUPABASE_SERVICE_ROLE_KEY"),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function authed(req: Request): boolean {
  if (!CFG.secret) return false;
  const url = new URL(req.url);
  const q = url.searchParams.get("key");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return q === CFG.secret || bearer === CFG.secret;
}

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

// The parchment-branded wrapper, matching the CRM's transactional email look.
function renderHtml(bodyText: string, unsubUrl: string): string {
  const paras = esc(bodyText).split(/\n\s*\n/).map((p) =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, "<br>")}</p>`
  ).join("");
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paras}
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:24px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">Sara Cooper · Legacy Properties<br><a href="${CFG.site}" style="color:#7C6A4D;">legacycalifornia.com</a></p>
    <p style="font-size:11px;line-height:1.5;color:#A89C8A;margin:16px 0 0;text-align:center;">You're receiving this because you asked to hear from Legacy Properties. <a href="${esc(unsubUrl)}" style="color:#8C6E3D;">Unsubscribe</a>.</p>
  </div>`;
}

function unsubUrl(token: string): string {
  return `${CFG.site}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Body copy for one recipient: a short teaser that links to the web version —
// the proven, deliverability-friendly pattern (light HTML, real content on the
// site). issue.dek is the one-line summary authored with the issue.
function bodyFor(firstName: string, issue: { title: string; dek?: string | null; slug: string }): string {
  const fn = firstName || "there";
  const link = `${CFG.site}/ledger.html?slug=${encodeURIComponent(issue.slug)}`;
  return `Hi ${fn},\n\n`
    + (issue.dek ? `${issue.dek}\n\n` : `The latest Legacy letter is out — "${issue.title}."\n\n`)
    + `Read it here:\n${link}\n\n— Sara`;
}

// Send one email to one recipient. One request per recipient keeps the body and
// the one-click header fully per-recipient with no substitution fiddliness, and
// gives granular success/failure. Returns the SendGrid message id on success.
async function sendOne(rec: { email: string; name: string; token: string; first: string },
                       issue: { title: string; dek?: string | null; slug: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const uurl = unsubUrl(rec.token);
  const text = bodyFor(rec.first, issue);
  const payload = {
    personalizations: [{
      to: [{ email: rec.email, name: rec.name || undefined }],
      subject: issue.title,
    }],
    from:     { email: CFG.fromEmail, name: CFG.fromName },
    reply_to: { email: CFG.replyTo, name: CFG.fromName },
    categories: ["newsletter"],
    // RFC 8058 one-click. The https target is the CRM's own token endpoint (now
    // POST-capable); the mailto is the human fallback.
    headers: {
      "List-Unsubscribe": `<${uurl}>, <mailto:${CFG.replyTo}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    content: [
      { type: "text/plain", value: text },
      { type: "text/html",  value: renderHtml(text, uurl) },
    ],
  };
  try {
    const res = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true, id: res.headers.get("x-message-id") || undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

// Run tasks with a small concurrency cap so a warm-up batch stays inside the
// function's wall-clock budget without hammering SendGrid.
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!authed(req)) return json({ error: "unauthorized" }, 401);

  // Config sanity — never half-run.
  const missing = ["secret", "sgKey", "supaUrl", "supaKey"].filter((k) => !(CFG as Record<string, string>)[k]);
  if (missing.length) return json({ error: "missing_config", missing }, 500);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty body allowed for resolve */ }

  const mode = b.mode === "send" ? "send" : "resolve";
  const issueSlug = String(b.issue_slug || "").trim();
  if (!issueSlug) return json({ error: "issue_slug required" }, 400);
  const dryRun = b.dry_run === true;
  const limit = Math.max(1, Math.min(MAX_BATCH, Number(b.limit) || DEFAULT_BATCH));

  const supa = createClient(CFG.supaUrl, CFG.supaKey, { auth: { persistSession: false } });

  // The issue content (reuses the existing ledger_issues model; must be published).
  const { data: issue, error: issueErr } = await supa
    .from("ledger_issues").select("slug, title, dek, status")
    .eq("slug", issueSlug).maybeSingle();
  if (issueErr) return json({ error: `issue lookup: ${issueErr.message}` }, 500);
  if (!issue) return json({ error: `no issue with slug "${issueSlug}"` }, 404);
  if (issue.status !== "published") return json({ error: `issue "${issueSlug}" is not published (status=${issue.status})` }, 400);

  // Contactable recipients: opted in, active, has an email AND a one-click
  // unsubscribe token (so every send is compliant). Cap wide; we page by
  // excluding already-sent below.
  const { data: leads, error: leadsErr } = await supa
    .from("leads")
    .select("id, first_name, last_name, email, unsubscribe_token")
    .eq("email_opt_out", false).eq("not_interested", false).eq("status", "active")
    .not("email", "is", null).not("unsubscribe_token", "is", null)
    .limit(5000);
  if (leadsErr) return json({ error: `leads: ${leadsErr.message}` }, 500);

  const { data: sent } = await supa.from("newsletter_sends").select("lead_id").eq("issue_slug", issueSlug);
  const sentSet = new Set((sent || []).map((r) => r.lead_id));

  const eligible = (leads || []).filter((l) => l.email && EMAIL_RE.test(l.email) && !sentSet.has(l.id));
  const nameOf = (l: { first_name?: string | null; last_name?: string | null }) =>
    [l.first_name, l.last_name].filter(Boolean).join(" ") || "";

  const issueInfo = { slug: issue.slug, title: issue.title, dek: issue.dek };

  if (mode === "resolve") {
    return json({
      issue: issueInfo,
      contactable: (leads || []).length,
      already_sent: sentSet.size,
      remaining: eligible.length,
      sample: eligible.slice(0, 5).map((l) => nameOf(l) || l.email),
    });
  }

  // ---- send one batch ----
  const batch = eligible.slice(0, limit);
  if (!batch.length) return json({ issue: issueInfo, sent: 0, failed: 0, skipped: 0, remaining: 0, note: "nothing left to send for this issue" });

  if (dryRun) {
    return json({
      issue: issueInfo,
      would_send: batch.length,
      remaining_after: eligible.length - batch.length,
      subject: issue.title,
      sample: batch.slice(0, 5).map((l) => nameOf(l) || l.email),
      note: "dry_run — no email sent",
    });
  }

  const recs = batch.map((l) => ({ email: l.email as string, name: nameOf(l), token: l.unsubscribe_token as string, first: l.first_name || "", id: l.id }));
  const results = await pool(recs, CONCURRENCY, async (r) => {
    const out = await sendOne(r, issueInfo);
    return { ...out, rec: r };
  });

  const okRows = results.filter((r) => r.ok);
  const nowIso = new Date().toISOString();

  // Record the successes (idempotent). Best-effort audit trail alongside.
  if (okRows.length) {
    await supa.from("newsletter_sends").upsert(
      okRows.map((r) => ({ issue_slug: issueSlug, lead_id: r.rec.id, sent_at: nowIso, message_id: r.id || null })),
      { onConflict: "issue_slug,lead_id", ignoreDuplicates: true },
    );
    const okIds = okRows.map((r) => r.rec.id);
    await supa.from("leads").update({ last_contact_at: nowIso }).in("id", okIds).then(() => {}, () => {});
  }

  const failed = results.length - okRows.length;
  return json({
    issue: issueInfo,
    sent: okRows.length,
    failed,
    remaining: eligible.length - okRows.length,
    errors: results.filter((r) => !r.ok).slice(0, 5).map((r) => r.error),
  });
});
