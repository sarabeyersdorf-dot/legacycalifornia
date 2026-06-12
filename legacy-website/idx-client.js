// idx-client.js
// ─────────────────────────────────────────────────────────────
// Tiny browser client for the Legacy IDX API.
//
//   await LegacyIDX.fetchListings({ city: 'Murphys' })
//     → { listings, total, source }
//   await LegacyIDX.fetchListing(id)
//     → { listing, source }
//
// `source` is 'live' (MetroList) or 'sample' (fallback). Use it to show
// a small "preview data" badge on staging.
//
// Works on both production (https://legacycalifornia.com/api/...) and
// during local development (vercel dev → http://localhost:3000/api/...).
// ─────────────────────────────────────────────────────────────

(function (root) {
  const BASE = root.LEGACY_IDX_BASE
    || (location.hostname === 'localhost'
        ? '' /* same-origin during vercel dev */
        : '');

  async function request(path, params = {}) {
    const u = new URL(BASE + path, location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') u.searchParams.set(k, v);
    }
    const r = await fetch(u);
    if (!r.ok) throw new Error(`IDX ${path} → ${r.status}`);
    return r.json();
  }

  function fetchListings(filters = {}) {
    return request('/api/listings', filters);
  }
  function fetchListing(id) {
    return request('/api/listing', { id });
  }

  /* ── Photo URL through our proxy ───────────────────────── */
  function photoUrl(rawUrl) {
    if (!rawUrl) return null;
    // Already proxied or local? Pass through.
    if (rawUrl.startsWith('/') || rawUrl.includes(location.host)) return rawUrl;
    // Unsplash + other allowed dev sources: pass through.
    if (/^https?:\/\/(images|source)\.unsplash\.com/.test(rawUrl)) return rawUrl;
    return `${BASE}/api/photo?url=${encodeURIComponent(rawUrl)}`;
  }

  /* ── Card renderer (matches the templates in listings.html) ── */
  function cardHTML(l) {
    const photo = photoUrl(l.photos && l.photos[0]);
    const specs = [
      l.beds ? `${l.beds} Bd` : null,
      l.baths ? `${l.baths} Ba` : null,
      l.sqft ? `${l.sqft.toLocaleString()} sf` : null,
      l.lotAcres ? `${l.lotAcres} ac` : null,
      (!l.beds && !l.sqft) ? l.type : null,
    ].filter(Boolean).map(s => `<span>${s}</span>`).join('');

    const statusPill = l.status && l.status !== 'Active'
      ? `<span class="pill-status">${l.status}</span>`
      : `<span class="pill-status pill-new">Active</span>`;

    return `
      <a href="listing.html?id=${encodeURIComponent(l.id)}" class="prop-card" data-id="${l.id}">
        <div class="prop-photo">
          ${photo ? `<img src="${photo}" alt="" loading="lazy">` : ''}
          <div class="prop-tags">${statusPill}</div>
        </div>
        <div class="prop-body">
          <div class="prop-price">${formatPrice(l.price)}</div>
          <div class="prop-address">${l.address} · ${l.city}</div>
          <div class="prop-specs">${specs}</div>
          <div class="prop-foot">
            <span class="label-cap">MLS #${l.id}</span>
            <span class="prop-bookmark" onclick="event.preventDefault();this.classList.toggle('on');">♡</span>
          </div>
        </div>
      </a>
    `;
  }

  function formatPrice(n) {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString('en-US');
  }

  /** Replace the contents of an element with cards for the given listings. */
  function renderInto(el, listings) {
    if (!el) return;
    el.innerHTML = listings.map(cardHTML).join('');
  }

  /* ── Source badge (shows "Preview data" until env is configured) ── */
  function showSourceBadge(source) {
    if (source !== 'sample') return;
    let badge = document.getElementById('idx-source-badge');
    if (badge) return;
    badge = document.createElement('div');
    badge.id = 'idx-source-badge';
    badge.textContent = 'Preview data · MetroList feed not yet connected';
    Object.assign(badge.style, {
      position: 'fixed', bottom: '14px', left: '14px', zIndex: 9999,
      background: '#1B1813', color: '#C99E5A',
      padding: '8px 14px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: '10px', letterSpacing: '0.16em', textTransform: 'uppercase',
      border: '1px solid rgba(201,158,90,0.4)',
    });
    document.body.appendChild(badge);
  }

  root.LegacyIDX = {
    fetchListings, fetchListing,
    photoUrl, cardHTML, renderInto, formatPrice,
    showSourceBadge,
  };
})(window);
