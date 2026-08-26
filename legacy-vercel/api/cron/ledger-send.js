// api/cron/ledger-send.js — GET /api/cron/ledger-send?key=<PUBLISH_SECRET>
//
// Automatic Ledger delivery. Once an issue is published (status='published')
// and its send_date has arrived, this mails it to every 'ledger'-tagged
// subscriber who hasn't already received it, then stamps the issue emailed_at.
//
// Idempotent + resumable: each (issue, subscriber) send is recorded in
// ledger_sends, and only BATCH are sent per run to stay inside Vercel's budget.
// Runs hourly (see vercel.json); a large list drains over a few runs, then the
// issue is marked emailed_at and future runs find nothing due.

import { adminClient } from '../_lib/supabase.js';
import { pickEmailProvider, bodyToHtml, unsubscribeFooter } from '../_lib/email-html.js';
import { verifyCron } from '../_lib/cron-auth.js';

const BATCH = 20;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); // never serve a stale cron replay (Bug 8)
  if (!verifyCron(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  const supa = adminClient();
  const provider = pickEmailProvider();
  if (!provider) return res.status(200).json({ success: true, note: 'no email provider configured' });

  const today = new Date().toISOString().slice(0, 10);

  // Oldest published, due, not-yet-fully-emailed issue. send_date null = send now.
  const { data: candidates } = await supa.from('ledger_issues')
    .select('slug, title, dek, send_date')
    .eq('status', 'published').is('emailed_at', null)
    .order('send_date', { ascending: true }).limit(10);
  const issue = (candidates || []).find((i) => !i.send_date || i.send_date <= today);
  if (!issue) return res.status(200).json({ success: true, note: 'nothing due' });

  // Who already got this issue, and who's a live subscriber.
  const { data: already } = await supa.from('ledger_sends').select('lead_id').eq('issue_slug', issue.slug);
  const sentSet = new Set((already || []).map((r) => r.lead_id));
  const { data: subs } = await supa.from('leads')
    .select('id, first_name, email, unsubscribe_token')
    .contains('tags', ['ledger'])
    .eq('email_opt_out', false).eq('not_interested', false).eq('status', 'active')
    .not('email', 'is', null)
    .limit(2000);

  const outstanding = (subs || []).filter((l) => l.email && !sentSet.has(l.id));
  const batch = outstanding.slice(0, BATCH);

  let sent = 0, failed = 0;
  for (const l of batch) {
    try {
      const fn = l.first_name || 'there';
      const link = `https://legacycalifornia.com/ledger.html?slug=${encodeURIComponent(issue.slug)}`;
      const text = `Hi ${fn},\n\nThe latest Ledger is out — "${issue.title}."\n\n`
        + (issue.dek ? issue.dek + '\n\n' : '')
        + `Read it here:\n${link}\n\n— Sara`;
      const r = await provider.send({
        agent: 'sara', to: l.email, toName: l.first_name || null,
        subject: `The Ledger — ${issue.title}`,
        text,
        html: bodyToHtml(text, { name: 'Sara Cooper · Legacy Properties' }, { footerHtml: unsubscribeFooter(l.unsubscribe_token) })
      });
      if (r && r.skipped) { failed++; continue; }
      await supa.from('ledger_sends').insert({ issue_slug: issue.slug, lead_id: l.id }).then(() => {}, () => {});
      await supa.from('leads').update({ last_contact_at: new Date().toISOString() }).eq('id', l.id).then(() => {}, () => {});
      sent++;
    } catch (_) { failed++; }
  }

  const remaining = outstanding.length - sent;
  if (remaining <= 0) {
    await supa.from('ledger_issues').update({ emailed_at: new Date().toISOString() }).eq('slug', issue.slug);
  }
  return res.status(200).json({ success: true, issue: issue.slug, sent, failed, remaining: Math.max(0, remaining) });
}
