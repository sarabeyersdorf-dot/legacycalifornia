// api/cron/youtube-views.js — GET /api/cron/youtube-views?key=<PUBLISH_SECRET>
//
// Refreshes the public YouTube view count for every deal that has a video tour,
// so the seller portal can show "N views on YouTube" without anyone checking or
// typing it in each week. Runs daily (see vercel.json). The count is cached on
// the deal (deals.video_views / video_views_synced_at, db/067) — a column the
// deals.json sync never writes, so it survives the hourly sync.
//
// Uses a YouTube Data API v3 key (public statistics only — no OAuth). Set
// YOUTUBE_API_KEY in Vercel. Without it the job no-ops cleanly (nothing breaks;
// the portal just won't show a count).

import { adminClient } from '../_lib/supabase.js';
import { extractYouTubeId, getVideoStats, youtubeConfigured } from '../_lib/youtube.js';
import { verifyCron } from '../_lib/cron-auth.js';

export default async function handler(req, res) {
  if (!verifyCron(req)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  if (!youtubeConfigured()) {
    return res.status(200).json({ success: true, disabled: true, note: 'set YOUTUBE_API_KEY in Vercel to enable YouTube view counts' });
  }

  const supa = adminClient();
  try {
    // Every deal — a video can live in the synced video_url column OR in a CRM
    // override (agent_overrides.video_url). The table is small, so fetch all and
    // resolve in JS rather than trust a jsonb filter to catch both sources.
    const { data: deals, error } = await supa
      .from('deals')
      .select('id, source_key, video_url, agent_overrides');
    if (error) return res.status(500).json({ success: false, error: error.message });

    let updated = 0, skipped = 0, notFound = 0;
    const errors = [];
    const now = new Date().toISOString();

    for (const d of (deals || [])) {
      // Prefer a CRM override URL (matches how the portal resolves the video).
      const ov = (d.agent_overrides && typeof d.agent_overrides === 'object' && !Array.isArray(d.agent_overrides)) ? d.agent_overrides : {};
      const url = (ov.video_url != null && ov.video_url !== '') ? ov.video_url : d.video_url;
      const id = extractYouTubeId(url);
      if (!id) { skipped++; continue; }
      try {
        const stats = await getVideoStats(id);
        if (stats.skipped) { skipped++; continue; }
        if (stats.views == null) { notFound++; continue; }
        const { error: uErr } = await supa.from('deals')
          .update({ video_views: stats.views, video_views_synced_at: now })
          .eq('id', d.id);
        if (uErr) errors.push({ source_key: d.source_key, error: uErr.message });
        else updated++;
      } catch (e) {
        errors.push({ source_key: d.source_key, error: e.message || String(e) });
      }
    }

    return res.status(200).json({ success: true, updated, skipped, notFound, errors });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
