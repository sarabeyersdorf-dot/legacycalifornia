/* legacy-analytics.js — site-wide Google tag (GA4 + Google Ads) + conversion events.
 *
 * ───────────────────────── CONFIG — EDIT THESE ─────────────────────────────
 * These are PUBLIC, client-side identifiers (they ship in the page source), so
 * they live here in the code — NOT in Vercel environment variables. Edit this
 * file and commit; no env-var / redeploy dance is needed.
 *
 *   GA4_MEASUREMENT_ID — Google Analytics → Admin → Data Streams. Looks like "G-XXXXXXXXXX".
 *   GOOGLE_ADS_ID      — Google Ads account. Looks like "AW-XXXXXXXXX".
 *   ADS_CONVERSION_LABELS.phoneClick / .packetRequest — paste when you create each
 *       conversion action in Google Ads. Looks like "AW-XXXXXXXXX/AbCdEfGh1234".
 *
 * BEHAVIOUR (safe to ship with everything blank):
 *   • A value still on its "XXXX" placeholder (or empty) is treated as NOT SET —
 *     that tag is silently skipped. With both IDs unset, no tag loads at all and
 *     the site works perfectly.
 *   • An empty conversion label fires the GA4 event only and skips the Ads
 *     conversion — so this ships today and lights up when you paste labels in.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CONFIG = {
    GA4_MEASUREMENT_ID: 'G-43P5CYDS1B',
    GOOGLE_ADS_ID:      'AW-16991290125',
    ADS_CONVERSION_LABELS: {
      phoneClick:    '',   // e.g. "AW-XXXXXXXXX/AbCdEfGh1234"
      packetRequest: ''    // e.g. "AW-XXXXXXXXX/IjKlMnOp5678"
    }
  };

  // A value is "real" only if it's a non-empty string with no "XXXX" placeholder.
  function real(v) { return typeof v === 'string' && v.length > 0 && v.indexOf('XXXX') === -1; }

  var GA4 = real(CONFIG.GA4_MEASUREMENT_ID) ? CONFIG.GA4_MEASUREMENT_ID : null;
  var ADS = real(CONFIG.GOOGLE_ADS_ID)      ? CONFIG.GOOGLE_ADS_ID      : null;

  window.dataLayer = window.dataLayer || [];
  function gtagShim() { window.dataLayer.push(arguments); }

  var loaded = false;
  function ensureLoaded() {
    if (loaded) return true;
    if (!GA4 && !ADS) return false;               // nothing configured → never load
    loaded = true;
    // Define window.gtag (the standard inline shim) BEFORE the library loads, so
    // it queues calls and is a real function immediately.
    window.gtag = window.gtag || gtagShim;
    window.gtag('js', new Date());
    if (GA4) window.gtag('config', GA4);          // GA4 property
    if (ADS) window.gtag('config', ADS);          // Google Ads (conversions + remarketing)
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA4 || ADS);
    (document.head || document.documentElement).appendChild(s);
    return true;
  }

  // Fire a GA4 event; also fire the Google Ads conversion when a real label is set.
  function track(eventName, params, adsLabel) {
    if (!ensureLoaded()) return;                   // no tags configured → no-op
    try { window.gtag('event', eventName, params || {}); } catch (e) {}
    if (ADS && typeof adsLabel === 'string' && adsLabel && adsLabel.indexOf('XXXX') === -1) {
      try { window.gtag('event', 'conversion', { send_to: adsLabel }); } catch (e) {}
    }
  }

  // ── Task 2: every tel: link is a conversion ─────────────────────────────────
  // One delegated listener covers every tel: link on every page (and any added
  // later), with no per-page wiring. Never preventDefault — the call must still
  // place normally on mobile.
  document.addEventListener('click', function (e) {
    var a = (e.target && e.target.closest) ? e.target.closest('a[href^="tel:"]') : null;
    if (!a) return;
    track('phone_click', {
      page_path:     location.pathname,
      page_location: location.href,
      link_url:      a.getAttribute('href')
    }, CONFIG.ADS_CONVERSION_LABELS.phoneClick);
  }, true);

  // ── Task 3 helper: the 433 packet form calls this on a successful submit ─────
  window.LegacyAnalytics = {
    track: track,
    phoneClick: function () {
      track('phone_click', { page_path: location.pathname }, CONFIG.ADS_CONVERSION_LABELS.phoneClick);
    },
    packetRequest: function (params) {
      track('packet_request', params || { page_path: location.pathname }, CONFIG.ADS_CONVERSION_LABELS.packetRequest);
    }
  };

  // Load now (if configured) so the pageview is captured on every page.
  ensureLoaded();
})();
