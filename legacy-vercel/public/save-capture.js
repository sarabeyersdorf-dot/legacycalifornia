/* Buyer-facing "save this home" — injects a heart button onto every IDX search
   result card, writing to the buyer's OWN saved homes via /api/me/save-property
   (our DB; iHomefinder is only the display feed).

   Reuses the shadow-root + card-scrape technique proven in curate-capture.js:
   Kestrel renders inside an OPEN SHADOW ROOT on div.ihf-container, so cards are
   only reachable through host.shadowRoot, and re-renders (React routed off the
   query string, no reloads) must be watched on the root itself.

   Distinct from curate-capture.js: that is an AGENT capture-mode tool (?capture=)
   that POSTs to /api/curate/collections. This is always-on for buyers and POSTs
   to /api/me/save-property. Both can coexist (different corner + data attr). */
(function () {
  'use strict';

  function widgetRoots() {
    var out = [];
    document.querySelectorAll('.ihf-container').forEach(function (h) { if (h.shadowRoot) out.push(h.shadowRoot); });
    return out;
  }
  function txt(scope, sel) { var n = scope.querySelector(sel); return n ? (n.textContent || '').trim() : null; }

  // Extract the listing id + display fields from one result card. The id must be
  // the FULL iHomefinder id (e.g. 226081050_6) so it matches the detail-page
  // save (which reads ?id=) — hence [^&#]+, not the MLS-only slice.
  function cardData(card) {
    var a = card.querySelector('a[href*="listing"]');
    var href = a ? (a.getAttribute('href') || '') : '';
    var idm = href.match(/[?&]id=([^&#]+)/);
    var id = idm ? decodeURIComponent(idm[1]) : null;
    var streets = card.querySelectorAll('.ihf-gallery-street-name');
    var cityLine = streets[1] ? (streets[1].textContent || '').trim() : '';
    var cm = cityLine.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})/);
    var img = card.querySelector('img');
    var photo = img ? (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || null) : null;
    if (photo && photo.indexOf('http') !== 0) { try { photo = new URL(photo, location.href).href; } catch (e) {} }
    var price = txt(card, '.ihf-listing-result-price');
    return {
      id: id,
      address: streets[0] ? (streets[0].textContent || '').trim() : null,
      city: cm ? cm[1].trim() : null,
      price: price ? (price.replace(/[^0-9]/g, '') || null) : null,
      image: photo
    };
  }

  var savedIds = null;   // Set of the buyer's saved ids (null until loaded)
  function loadSaved() {
    return fetch('/api/me/save-property', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ids) savedIds = new Set(j.ids); })
      .catch(function () {});
  }
  function isOn(id) { return !!(savedIds && savedIds.has(id)); }

  function paint(btn, id) {
    var on = isOn(id);
    btn.innerHTML = on ? '&#9829;' : '&#9825;';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Saved — click to remove' : 'Save this home';
    btn.style.color = on ? '#fff' : '#1A1714';
    btn.style.background = on ? '#8C6E3D' : 'rgba(255,255,255,.94)';
  }

  function toggle(id, data, btn) {
    btn.disabled = true;
    var want = !isOn(id);
    var body = want
      ? { listing_id: id, address: data.address || undefined, city: data.city || undefined, price: data.price || undefined, image: data.image || undefined }
      : { listing_id: id, unsave: true };
    fetch('/api/me/save-property', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
      .then(function (r) {
        if (r.status === 401) { location.href = 'dashboard.html?next=' + encodeURIComponent(location.pathname + location.search); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (j && typeof j.saved === 'boolean') {
          if (!savedIds) savedIds = new Set();
          if (j.saved) savedIds.add(id); else savedIds.delete(id);
          paint(btn, id);
        }
        btn.disabled = false;
      })
      .catch(function () { btn.disabled = false; });
  }

  function decorate() {
    widgetRoots().forEach(function (root) {
      root.querySelectorAll('.ihf-listing-result-cell').forEach(function (card) {
        if (card.getAttribute('data-lgc-save')) return;
        card.setAttribute('data-lgc-save', '1');
        var data = cardData(card);
        if (!data.id) return;
        try { if (getComputedStyle(card).position === 'static') card.style.position = 'relative'; } catch (e) {}
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-lgc-savebtn', '1');
        btn.setAttribute('aria-label', 'Save this home');
        btn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:9999;width:34px;height:34px;border-radius:50%;border:none;font-size:17px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;transition:transform .1s;';
        paint(btn, data.id);
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(data.id, data, btn); });
        card.appendChild(btn);
      });
    });
  }

  // Watch each shadow root (async build + re-render on every in-widget nav).
  var seen = typeof WeakSet === 'function' ? new WeakSet() : { has: function () { return false; }, add: function () {} };
  var t = null, observed = [];
  function ensure() {
    widgetRoots().forEach(function (root) {
      if (seen.has(root)) return;
      seen.add(root);
      var obs = new MutationObserver(function () { clearTimeout(t); t = setTimeout(decorate, 400); });
      obs.observe(root, { childList: true, subtree: true });
      observed.push(obs);
    });
    decorate();
  }
  loadSaved().then(function () { ensure(); setInterval(ensure, 1000); });
})();
