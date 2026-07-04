// api/_lib/handlers/curate-listing-media.js
// /api/curate/listing-media   (agent-only)
//   GET  ?mls_number=<#>   → current media row for that listing (+ the listing)
//   POST { mls_number, youtube_url?, matterport_url?, tour_views? }
//        → upsert the media row (resolves the property by MLS #). Extracts the
//          YouTube video id and clears the cached view count so it re-pulls.
//
// The seller portal auto-fetches the YouTube view count; Matterport tour_views
// is entered by hand from the Matterport dashboard.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { extractYouTubeId } from '../youtube.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    if (req.method === 'GET') {
      const mls = (req.query?.mls_number || '').toString().trim();
      if (!mls) return fail(res, 400, 'mls_number required');
      const { data: prop } = await supa.from('properties')
        .select('id, mls_number, address, city').eq('mls_number', mls).maybeSingle();
      if (!prop) return ok(res, { found: false, listing: null, media: null });
      const { data: media } = await supa.from('listing_media').select('*').eq('property_id', prop.id).maybeSingle();
      return ok(res, { found: true, listing: prop, media: media || null });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const mls = (b?.mls_number || '').toString().trim();
      if (!mls) return fail(res, 400, 'mls_number required');

      const { data: prop } = await supa.from('properties')
        .select('id, address').eq('mls_number', mls).maybeSingle();
      if (!prop) return fail(res, 404, `no listing found for MLS #${mls}`);

      const youtube_url = (b?.youtube_url || '').toString().trim() || null;
      const youtube_video_id = youtube_url ? extractYouTubeId(youtube_url) : null;
      if (youtube_url && !youtube_video_id) return fail(res, 400, "that doesn't look like a YouTube link");

      const row = {
        property_id: prop.id,
        youtube_url,
        youtube_video_id,
        video_views: null,          // clear cache so the portal re-pulls
        video_synced_at: null,
        matterport_url: (b?.matterport_url || '').toString().trim() || null,
        tour_views: Number.isFinite(+b?.tour_views) ? Math.max(0, Math.round(+b.tour_views)) : null,
        updated_at: new Date().toISOString()
      };
      const { data, error } = await supa.from('listing_media')
        .upsert(row, { onConflict: 'property_id' }).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { saved: true, listing: prop, media: data });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
