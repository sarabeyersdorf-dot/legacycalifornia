// api/showcase.js
// GET /api/showcase  → public case-study gallery payload for /showcase.
//
// Unauthenticated (this is marketing). Reads the agent-curated showcase_deals
// rows joined to the live `deals` row, so display facts (address, city, price,
// photo) stay correct even after the hourly deals sync. Returns display-ready
// cards grouped into featured + active + sold.
//
// Each card links to the listing's own marketing microsite when one exists
// (microsite_path, e.g. /433-e-highway-4-murphys); otherwise to the generic
// sample seller portal (/sample-portal) so a prospect can experience the real
// portal UI with no client data exposed.

import { adminClient } from './_lib/supabase.js';
import { applyCors, handleOptions } from './_lib/cors.js';

const fmtUSDfull = (n) =>
  (n == null || !Number.isFinite(+n)) ? null
  : '$' + Math.round(+n).toLocaleString('en-US');

function priceLine(status, listPrice, salePrice) {
  if (status === 'sold') {
    const sold = fmtUSDfull(salePrice);
    if (sold) return { label: 'Sold for', value: sold };
    const asked = fmtUSDfull(listPrice);
    return asked ? { label: 'Listed at', value: asked } : null;
  }
  const asked = fmtUSDfull(listPrice);
  return asked ? { label: 'For sale', value: asked } : null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') { res.statusCode = 405; return res.end('GET only'); }

  try {
    const supa = adminClient();

    const { data: rows, error } = await supa
      .from('showcase_deals')
      .select('*, deals(id, address, city, stage, type, side, list_price, sale_price, photo_url, photo_override, coe_date)')
      .order('featured', { ascending: false })
      .order('sort_order', { ascending: true });

    if (error) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: error.message })); }

    const cards = (rows || [])
      // Keep deal-linked rows that still resolve, plus manual entries (deal_id
      // NULL) that carry their own address. Drop only orphaned deal rows.
      .filter((r) => r.deals || (!r.deal_id && (r.address || '').trim()))
      .map((r) => {
        const d = r.deals || null;
        const href = (r.microsite_path && r.microsite_path.trim()) ? r.microsite_path.trim() : '/sample-portal';
        const hasMicrosite = !!(r.microsite_path && r.microsite_path.trim());
        const external = /^https?:\/\//i.test(href);

        if (!d) {
          // Manual / external case study — everything comes from the row itself.
          const status = (r.status === 'sold') ? 'sold' : (r.status === 'active') ? 'active' : 'sold';
          return {
            id:        r.id,
            address:   r.address || '',
            city:      r.city || '',
            status,
            featured:  !!r.featured,
            blurb:     r.blurb || '',
            photo:     r.photo_override || '',
            href, hasMicrosite, external,
            price:     r.price_label ? { label: '', value: r.price_label } : null
          };
        }

        const status = (r.status === 'sold' || r.status === 'active')
          ? r.status
          : (String(d.stage || '').toLowerCase() === 'closed' ? 'sold' : 'active');
        const photo = r.photo_override || d.photo_override || d.photo_url || '';
        return {
          id:        r.id,
          address:   d.address || '',
          city:      d.city || '',
          status,
          featured:  !!r.featured,
          blurb:     r.blurb || '',
          photo,
          href, hasMicrosite, external,
          price:     priceLine(status, d.list_price, d.sale_price)
        };
      });

    const featured = cards.find((c) => c.featured) || null;
    const rest     = cards.filter((c) => c !== featured);
    const active   = rest.filter((c) => c.status === 'active');
    const sold     = rest.filter((c) => c.status === 'sold');

    // Marketing content — safe to cache briefly at the edge.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    return res.end(JSON.stringify({
      featured,
      active,
      sold,
      counts: { total: cards.length, active: active.length, sold: sold.length }
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: e.message }));
  }
}
