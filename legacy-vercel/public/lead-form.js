/* lead-form.js — a drop-in direct lead capture form for any page.
 *
 * WHY THIS EXISTS
 * Lead capture on the site was split across two systems that don't talk to each
 * other, and a person had to register with BOTH before anything worked:
 *
 *   - Find My Match posts to our CRM. The visitor then got a SECOND email asking
 *     them to sign up at iHomefinder before any listing alert would reach them.
 *     Most people never did that, so the search they asked for never existed.
 *   - The valuation page's "Get my estimate" is an iHomefinder widget. A seller
 *     entering their address there becomes an iHomefinder lead and never reaches
 *     the CRM at all — which is why valuation_requests has zero rows.
 *
 * Both halves are now fixed at the server: /api/leads/intake creates the CRM
 * lead AND registers them with iHomefinder AND subscribes them to their town's
 * market report, from one submit. This form is the front end of that — the only
 * thing a visitor has to fill in.
 *
 * USAGE — drop the script on a page and mark a container:
 *   <div data-lead-form data-lead-kind="seller" data-lead-title="…"></div>
 *   <script src="/lead-form.js" defer></script>
 *
 * Attributes (all optional except the marker):
 *   data-lead-kind   'seller' | 'buyer' | 'both'   default 'both'
 *   data-lead-title  heading text
 *   data-lead-note   one line under the heading
 *   data-lead-cta    button label
 *   data-lead-area   pre-fills the town, e.g. on a town page
 *
 * Deliberately three fields. Every extra box costs completions, and the CRM only
 * needs enough to call someone back — the rest of the conversation is the job.
 */
(function () {
  'use strict';

  var HOSTS = document.querySelectorAll('[data-lead-form]');
  if (!HOSTS.length) return;

  var CSS = ''
    + '.lgf{background:var(--lg-white,#FFFDF8);border:1px solid rgba(23,20,15,.14);'
    +   'border-radius:var(--lg-r,20px);padding:26px 26px 24px;box-shadow:var(--lg-sh-sm,0 2px 10px rgba(23,20,15,.06));max-width:620px;}'
    + '.lgf h3{font-family:var(--lg-sans,system-ui);font-weight:700;font-size:22px;line-height:1.25;margin:0 0 8px;color:var(--lg-ink,#17140F);}'
    + '.lgf .lgf-note{font-family:var(--lg-sans,system-ui);font-size:15.5px;line-height:1.55;color:var(--lg-ink-soft,#4E4335);margin:0 0 18px;}'
    + '.lgf-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}'
    + '@media(max-width:560px){.lgf-row{grid-template-columns:1fr;}}'
    + '.lgf label{display:flex;flex-direction:column;gap:5px;font-family:var(--lg-sans,system-ui);font-size:13.5px;font-weight:600;color:var(--lg-ink-mute,#6F624F);}'
    + '.lgf input,.lgf select{font:inherit;font-size:16px;font-weight:400;padding:11px 13px;border:1px solid rgba(23,20,15,.20);'
    +   'border-radius:var(--lg-r-sm,12px);background:#fff;color:var(--lg-ink,#17140F);width:100%;}'
    + '.lgf input:focus,.lgf select:focus{outline:3px solid var(--lg-c4,#B08D57);outline-offset:2px;border-color:transparent;}'
    + '.lgf-full{grid-column:1/-1;}'
    + '.lgf-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:18px;}'
    + '.lgf-btn{font:inherit;font-family:var(--lg-sans,system-ui);font-size:16px;font-weight:700;cursor:pointer;border:none;'
    +   'border-radius:999px;padding:13px 26px;background:var(--lg-c2,#B08D57);color:var(--lg-ink,#17140F);}'
    + '.lgf-btn:disabled{opacity:.6;cursor:default;}'
    + '.lgf-btn:focus-visible{outline:3px solid var(--lg-ink,#17140F);outline-offset:3px;}'
    + '.lgf-msg{font-family:var(--lg-sans,system-ui);font-size:14.5px;line-height:1.5;}'
    + '.lgf-msg.bad{color:#8E2B2B;}'
    + '.lgf-fine{font-family:var(--lg-sans,system-ui);font-size:13px;line-height:1.5;color:var(--lg-ink-mute,#6F624F);margin:14px 0 0;}'
    + '.lgf-done{font-family:var(--lg-sans,system-ui);font-size:17px;line-height:1.6;color:var(--lg-ink,#17140F);}'
    + '.lgf-done b{display:block;font-size:20px;margin-bottom:8px;}'
    + '.lgf-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}';

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var TOWNS = ['Murphys', 'Arnold', 'Angels Camp', 'Copperopolis', 'Sutter Creek', 'Valley Springs', 'Somewhere else'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  HOSTS.forEach(function (host, i) {
    var kind  = host.getAttribute('data-lead-kind') || 'both';
    var isSeller = kind === 'seller';
    var title = host.getAttribute('data-lead-title')
      || (isSeller ? 'Find out what your home is worth' : 'Tell us what you’re looking for');
    var note  = host.getAttribute('data-lead-note')
      || (isSeller
          ? 'Sara will send you a real valuation — not an automated guess — usually the same day.'
          : 'We’ll set up a search for you and send new listings as they come on the market.');
    var cta   = host.getAttribute('data-lead-cta') || (isSeller ? 'Send me my valuation' : 'Set up my search');
    var area  = host.getAttribute('data-lead-area') || '';
    var uid   = 'lgf' + i;

    // The third field earns its place differently on each side: a seller's
    // address is the thing being valued, a buyer's town is what the search and
    // their iHomefinder market subscription key off.
    var thirdField = isSeller
      ? '<label class="lgf-full" for="' + uid + 'addr">Property address'
        + '<input id="' + uid + 'addr" name="address" autocomplete="street-address" placeholder="1350 Love St, Angels Camp"></label>'
      : '<label class="lgf-full" for="' + uid + 'area">Where are you looking?'
        + '<select id="' + uid + 'area" name="area"><option value="">Anywhere in the foothills</option>'
        + TOWNS.map(function (t) {
            return '<option value="' + esc(t) + '"' + (area === t ? ' selected' : '') + '>' + esc(t) + '</option>';
          }).join('')
        + '</select></label>';

    host.innerHTML =
      '<form class="lgf" novalidate>'
      + '<h3>' + esc(title) + '</h3>'
      + '<p class="lgf-note">' + esc(note) + '</p>'
      + '<div class="lgf-row">'
        + '<label class="lgf-full" for="' + uid + 'name">Your name'
          + '<input id="' + uid + 'name" name="name" autocomplete="name" required></label>'
        + '<label for="' + uid + 'email">Email'
          + '<input id="' + uid + 'email" name="email" type="email" autocomplete="email" inputmode="email" required></label>'
        + '<label for="' + uid + 'phone">Phone <span style="font-weight:400;">(optional)</span>'
          + '<input id="' + uid + 'phone" name="phone" type="tel" autocomplete="tel" inputmode="tel"></label>'
        + thirdField
      + '</div>'
      // Honeypot: bots fill every field, people never see this one. The intake
      // endpoint drops any submission that has it filled.
      + '<div class="lgf-hp" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>'
      + '<div class="lgf-actions">'
        + '<button type="submit" class="lgf-btn">' + esc(cta) + '</button>'
        + '<span class="lgf-msg" role="status" aria-live="polite"></span>'
      + '</div>'
      + '<p class="lgf-fine">We’ll never share your details. Unsubscribe any time.</p>'
      + '</form>';

    var form = host.querySelector('form');
    var btn  = host.querySelector('.lgf-btn');
    var msg  = host.querySelector('.lgf-msg');

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = form.elements;
      var name  = (f.name.value || '').trim();
      var email = (f.email.value || '').trim();
      if (!name)  { msg.className = 'lgf-msg bad'; msg.textContent = 'Your name, please.'; f.name.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        msg.className = 'lgf-msg bad'; msg.textContent = 'That email doesn’t look right.'; f.email.focus(); return;
      }

      var parts = name.split(/\s+/);
      var areaVal = f.area ? (f.area.value || '') : '';
      var payload = {
        first_name: parts[0],
        last_name:  parts.slice(1).join(' ') || null,
        email: email,
        phone: (f.phone.value || '').trim() || null,
        source: 'website_form',
        lead_type: isSeller ? 'seller' : (kind === 'buyer' ? 'buyer' : null),
        // areas drives the iHomefinder market-report subscription server-side, so
        // a buyer who names a town is signed up to that town's report on submit.
        areas: areaVal && areaVal !== 'Somewhere else' ? [areaVal] : (area ? [area] : null),
        message: f.address && f.address.value.trim()
          ? 'Valuation request for ' + f.address.value.trim()
          : null,
        company: f.company.value
      };

      btn.disabled = true; btn.textContent = 'Sending…';
      msg.className = 'lgf-msg'; msg.textContent = '';
      try {
        var res = await fetch('/api/leads/intake', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify(payload)
        });
        var json = null; try { json = await res.json(); } catch (e) {}
        if (!res.ok || (json && json.success === false)) throw new Error((json && json.error) || 'failed');
        host.innerHTML = '<div class="lgf"><div class="lgf-done"><b>Got it, ' + esc(parts[0]) + '.</b>'
          + (isSeller
              ? 'Sara will be in touch about your valuation, usually the same day. If it’s urgent, call (209) 559-4966.'
              : 'Your search is set up — new listings will come straight to you. Sara will follow up personally too.')
          + '</div></div>';
      } catch (err) {
        // Never a dead end: the phone number always works, even if we don't.
        btn.disabled = false; btn.textContent = cta;
        msg.className = 'lgf-msg bad';
        msg.textContent = 'That didn’t send. Please call (209) 559-4966 and we’ll pick it up from there.';
      }
    });
  });
})();
