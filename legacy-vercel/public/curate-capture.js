/* CRM "curate" capture overlay — shared by property-search.html and listing.html.
   Inert for public visitors: it only activates when the CRM opens the page with
   ?capture=<collectionId> (the agent picking listings for a client collection).
   The target collection is stashed in sessionStorage (Kestrel rewrites the query
   string as it navigates, so the param can't be trusted to persist) and our
   params are stripped from the URL so iHomefinder's own routing is untouched.

   IMPORTANT: Kestrel renders the whole widget inside an OPEN SHADOW ROOT on
   div.ihf-container. document.querySelectorAll() never sees the listing cards,
   and a MutationObserver on document.body never fires for widget re-renders —
   both must target the shadow root itself. Listing cards carry stable classes
   (.ihf-listing-result-cell, .ihf-listing-result-price, …) and each card links
   to /listing?id=<MLS>_<board>, which is the most reliable source of the MLS#. */
(function () {
  'use strict';
  var KEY = 'legacyCaptureCollection';
  var qs = new URLSearchParams(location.search);

  // Seed sessionStorage from the launch URL, then remove our params so they
  // don't interfere with Kestrel's query-string routing.
  if (qs.has('capture')) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        id: qs.get('capture') || '',
        title: qs.get('title') || 'this collection'
      }));
    } catch (e) {}
    qs.delete('capture'); qs.delete('title');
    var clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash;
    try { history.replaceState(null, '', clean); } catch (e) {}
  }

  var target = null;
  try { target = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!target || !target.id) return; // public visitor — do nothing at all.

  var isDetailPage = /^\/listing(\.html)?$/.test(location.pathname);

  // ---- capture bar ----------------------------------------------------------
  var bar = document.createElement('div');
  bar.style.cssText = 'position:sticky;top:0;z-index:99998;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#1A1714;color:#FAF6EC;box-shadow:0 2px 12px rgba(0,0,0,.25);font-family:system-ui,sans-serif;';
  bar.innerHTML =
    '<b style="font-size:14px;">Add to collection</b>' +
    '<span style="color:#C9BEA8;font-size:12px;">“' + String(target.title).replace(/</g, '&lt;') + '”</span>' +
    '<span style="flex:1 1 40px;"></span>' +
    (isDetailPage
      ? '<button type="button" id="lgcCaptureThis" style="background:#B08D57;color:#1A1714;border:none;border-radius:8px;padding:8px 15px;font-size:12px;font-weight:600;cursor:pointer;">＋ Add this listing</button>'
      : '<span style="color:#C9BEA8;font-size:12px;">Click “＋ Add to collection” on any listing</span>') +
    '<button type="button" id="lgcCaptureStop" style="background:transparent;color:#C9BEA8;border:1px solid #4a443c;border-radius:8px;padding:8px 15px;font-size:12px;font-weight:600;cursor:pointer;">Done — stop adding</button>';
  document.body.insertBefore(bar, document.body.firstChild);

  bar.querySelector('#lgcCaptureStop').addEventListener('click', function () {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    bar.remove();
    widgetRoots().forEach(function (root) {
      root.querySelectorAll('[data-lgc-addbtn]').forEach(function (b) { b.remove(); });
    });
    observed.forEach(function (o) { o.disconnect(); });
    clearInterval(pollTimer);
  });
  var detailBtn = bar.querySelector('#lgcCaptureThis');
  if (detailBtn) detailBtn.addEventListener('click', function () { onAdd(null, detailBtn); });

  function toast(msg, good) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100000;padding:11px 18px;border-radius:10px;font-size:13px;color:#FAF6EC;box-shadow:0 6px 24px rgba(0,0,0,.3);background:' + (good ? '#2E5C3D' : '#8A3B2B') + ';';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // ---- shadow-root plumbing -------------------------------------------------
  function widgetRoots() {
    var out = [];
    document.querySelectorAll('.ihf-container').forEach(function (host) {
      if (host.shadowRoot) out.push(host.shadowRoot);
    });
    return out;
  }

  // ---- scraping ---------------------------------------------------------------
  function txt(scope, sel) {
    var n = scope.querySelector(sel);
    return n ? (n.textContent || '').trim() : null;
  }
  function num(v) { return v ? (String(v).replace(/[^0-9.]/g, '') || null) : null; }

  function scrapeCard(card) {
    var a = card.querySelector('a[href*="listing"]');
    var idm = a ? (a.getAttribute('href') || '').match(/[?&]id=([A-Za-z0-9]+)/) : null;
    var mls = idm ? idm[1].split('_')[0]
                  : ((txt(card, '.ihf-listing-result-number') || '').replace(/[^A-Za-z0-9-]/g, '') || null);
    var streets = card.querySelectorAll('.ihf-gallery-street-name');
    var cityLine = streets[1] ? (streets[1].textContent || '').trim() : '';
    var cm = cityLine.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})/);
    var img = card.querySelector('img');
    var photo = img ? (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || null) : null;
    if (photo && photo.indexOf('http') !== 0) { try { photo = new URL(photo, location.href).href; } catch (e) {} }
    return {
      mls_number: mls,
      address: streets[0] ? (streets[0].textContent || '').trim() : null,
      city: cm ? cm[1].trim() : null,
      state: cm ? cm[2] : 'CA',
      zip: cm ? cm[3] : null,
      price: txt(card, '.ihf-listing-result-price'),
      beds: num(txt(card, '.ihf-listing-result-bed')),
      baths: num(txt(card, '.ihf-listing-result-bath')),
      sqft: num(txt(card, '.ihf-listing-result-sqft')),
      photo: photo
    };
  }

  // Detail page: the MLS# is in the URL (?id=<MLS>_<board>) and the address is
  // the document title ("324 Augusta Court Valley Springs, CA 95252").
  function scrapeDetail() {
    var idm = location.search.match(/[?&]id=([A-Za-z0-9]+)/);
    var mls = idm ? idm[1].split('_')[0] : null;
    var root = widgetRoots()[0];
    // Address comes as two elements: .listing-address-1 ("467 Skyline Drive")
    // and .listing-address-2 ("Arnold, CA 95223"). The document title mashes
    // them together with no comma, so it can't be split reliably.
    var street = root ? txt(root, '.listing-address-1') : null;
    var line2 = (root ? txt(root, '.listing-address-2') : null) || '';
    var cm = line2.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})/);
    // The detail layout has semantic containers (.bedrooms, .bathrooms,
    // .square-feet, .list-price) whose text is "<value><label>", e.g.
    // "1Bedrooms" / "110Square Feet" / "List Price$89,500". Never regex the
    // whole shadow text — it concatenates without spaces, so "Listing
    // #2260716031Bedrooms" would bleed the MLS# into the bed count.
    function field(sel, re) {
      if (!root) return null;
      var n = root.querySelector(sel);
      if (!n) return null;
      var x = (n.textContent || '').match(re);
      return x ? x[1].replace(/,/g, '') : null;
    }
    var img = root ? root.querySelector('img') : null;
    return {
      mls_number: mls || (field('.listing-number', /#\s*([A-Za-z0-9-]+)/) || null),
      address: street || (document.title || '').trim() || null,
      city: cm ? cm[1].trim() : null,
      state: cm ? cm[2] : 'CA',
      zip: cm ? cm[3] : null,
      price: field('.list-price', /(\$[\d,]{3,})/),
      beds: field('.bedrooms', /^\s*(\d{1,2})/),
      baths: field('.bathrooms', /^\s*(\d{1,2}(?:\.\d+)?)/),
      sqft: field('.square-feet', /^\s*([\d,]{2,})/),
      photo: img ? (img.currentSrc || img.getAttribute('src') || null) : null
    };
  }

  // ---- add ------------------------------------------------------------------
  function onAdd(card, btn) {
    var listing = card ? scrapeCard(card) : scrapeDetail();
    if (!listing.mls_number && !listing.address) {
      toast('Couldn’t read that listing — open its Details page and add from there.', false);
      return;
    }
    var orig = btn.textContent; btn.textContent = 'Adding…'; btn.disabled = true;
    fetch('/api/curate/collections', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'capture-listing', collection_id: target.id, listing: listing })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }).catch(function () { return { ok: r.ok, status: r.status, j: {} }; }); })
      .then(function (r) {
        if (r.ok && r.j && r.j.listing) {
          btn.textContent = '✓ Added'; btn.style.background = '#2E5C3D'; btn.style.color = '#FAF6EC';
          toast('Added ' + (listing.address || listing.mls_number || 'listing') + ' to “' + target.title + '”.', true);
        } else if (r.status === 401) {
          btn.textContent = orig; btn.disabled = false;
          toast('Sign in to the CRM in this browser first, then try again.', false);
        } else {
          btn.textContent = orig; btn.disabled = false;
          toast((r.j && r.j.error) || 'Could not add that listing.', false);
        }
      })
      .catch(function () { btn.textContent = orig; btn.disabled = false; toast('Network error — try again.', false); });
  }

  // ---- decorate results cards -------------------------------------------------
  function decorate() {
    widgetRoots().forEach(function (root) {
      root.querySelectorAll('.ihf-listing-result-cell').forEach(function (card) {
        if (card.getAttribute('data-lgc-dec')) return;
        card.setAttribute('data-lgc-dec', '1');
        try { if (getComputedStyle(card).position === 'static') card.style.position = 'relative'; } catch (e) {}
        var btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = '＋ Add to collection';
        btn.setAttribute('data-lgc-addbtn', '1');
        btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:9999;background:#1A1714;color:#FAF6EC;border:none;border-radius:8px;padding:8px 12px;font-family:monospace;font-size:11px;letter-spacing:.05em;text-transform:uppercase;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);';
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onAdd(card, btn); });
        card.appendChild(btn);
      });
    });
  }

  // Kestrel builds its shadow DOM asynchronously and re-renders on every
  // in-widget navigation (it's a React app routed off the query string, no page
  // reloads). Watch each shadow root once it exists; a light poll catches the
  // root appearing in the first place, and is also the safety net if a
  // mutation slips past the observer. Debounced so we run AFTER a re-render.
  var observed = [];
  var seen = typeof WeakSet === 'function' ? new WeakSet() : { has: function () { return false; }, add: function () {} };
  var t = null;
  function ensure() {
    widgetRoots().forEach(function (root) {
      if (seen.has(root)) return;
      seen.add(root);
      var obs = new MutationObserver(function () {
        clearTimeout(t); t = setTimeout(decorate, 400);
      });
      obs.observe(root, { childList: true, subtree: true });
      observed.push(obs);
    });
    decorate();
  }
  var pollTimer = setInterval(ensure, 1000);
  ensure();
})();
