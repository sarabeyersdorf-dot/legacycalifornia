/* legacy-client.js
 * Single global JS layer that wires the existing Legacy site to the new
 * /api endpoints. Adds NO new HTML or CSS — it only:
 *   1) Builds modals dynamically when needed (no design changes to the pages)
 *   2) Hooks click/submit handlers onto buttons and forms that already exist
 *
 * Pages it expects to be included on:
 *   - index.html      (homepage journey selector + footer CTAs)
 *   - listings.html   (Message Sara / Book a tour buttons)
 *   - listing.html    (tour scheduler sidebar + Send to Sara form)
 *   - platform.html   (Find My Match CTA)
 *   - dashboard.html  (auth gate for buyers)
 *   - seller.html     (auth gate for sellers)
 *   - crm.html        (auth gate for agents)
 *
 * Drop it in once per page:
 *   <script src="/legacy-client.js" defer></script>
 */

/* Portal link resolver — the client transaction portal lives at
 * /seller.html?t=<token>, and (side-branded, via vercel.json rewrites) at
 * /buyer/<token> and /seller/<token>. Both branded paths serve the SAME page;
 * the audience is decided server-side from the viewer's deal-party role, so the
 * URL prefix is purely cosmetic. This resolves the token and recognises the path
 * from any of those shapes, so one portal code path serves all of them. Defined
 * globally (outside the IIFEs) so every module can share it. */
window.LGPortal = window.LGPortal || {
  token: function () {
    try {
      var q = new URLSearchParams(location.search).get('t');
      if (q) return q;
      var m = location.pathname.match(/^\/(?:buyer|seller|portal)\/([^\/?#]+)\/?$/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  },
  // Public sample portal: /sample-portal (or ?sample=1). A no-auth, fabricated
  // demonstration of the client experience (linked from /showcase) — no token,
  // no login, no real data.
  isSample: function () {
    try {
      return new URLSearchParams(location.search).get('sample') != null
          || /^\/sample-portal\/?$/.test(location.pathname);
    } catch (e) { return false; }
  },
  // True on the portal page in any of its URL shapes (incl. the sample demo).
  isPath: function () {
    return /\/seller\.html$/.test(location.pathname)
        || /^\/(?:buyer|seller|portal)\/[^\/?#]+\/?$/.test(location.pathname)
        || this.isSample();
  },
  // Build a client's shareable portal link, branded to their side.
  link: function (token, side) {
    var seg = (side === 'buyer') ? 'buyer' : 'seller';
    return location.origin + '/' + seg + '/' + encodeURIComponent(token);
  }
};

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      method: opts.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      credentials: 'include',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON response */ }
    return { ok: res.ok, status: res.status, json };
  };

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // Modal builder — pure JS, inline styles so it doesn't depend on site CSS
  // ---------------------------------------------------------------------------
  function openModal({ title, intro, fields, submitLabel = 'Send', onSubmit }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'lg-ov';
      overlay.setAttribute('data-legacy-modal', '');

      const box = document.createElement('div');
      box.className = 'lg-sheet';
      box.innerHTML = `
        <button type="button" class="lg-sheet__x" data-close aria-label="Close">&times;</button>
        <div class="lg-sheet__eyebrow">Legacy Properties</div>
        <h3 class="lg-sheet__title">${title}</h3>
        ${intro ? `<p class="lg-sheet__intro">${intro}</p>` : ''}
        <form class="lg-sheet__form" data-form novalidate></form>
        <div class="lg-sheet__err" data-error></div>
      `;

      const form = $('[data-form]', box);
      for (const f of fields) {
        if (f.type === 'checkbox') {
          // Consent-style checkbox: small-print label, never pre-checked.
          const wrap = document.createElement('label');
          wrap.className = 'lg-sheet__check';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.name = f.name;
          wrap.appendChild(cb);
          const span = document.createElement('span');
          span.innerHTML = f.label;   // label carries the A2P consent markup + links
          wrap.appendChild(span);
          form.appendChild(wrap);
          continue;
        }
        const wrap = document.createElement('label');
        wrap.className = 'lg-sheet__label';
        const span = document.createElement('span');
        span.textContent = f.label;
        wrap.appendChild(span);
        const el = f.type === 'textarea'
          ? document.createElement('textarea')
          : document.createElement('input');
        el.className = 'lg-field';
        if (f.type !== 'textarea') el.type = f.type || 'text';
        if (f.placeholder) el.placeholder = f.placeholder;
        if (f.required)    el.required    = true;
        if (f.value)       el.value       = f.value;
        el.name = f.name;
        if (f.type === 'textarea') el.rows = 3;
        wrap.appendChild(el);
        form.appendChild(wrap);
      }

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'lg-btn lg-btn--gold';
      submit.textContent = submitLabel;
      form.appendChild(submit);

      document.body.appendChild(overlay);
      overlay.appendChild(box);
      setTimeout(() => form.querySelector('input,textarea')?.focus(), 50);

      const close = (result) => { overlay.remove(); resolve(result); };
      box.querySelector('[data-close]').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        submit.disabled = true;
        submit.textContent = 'Sending…';
        $('[data-error]', box).textContent = '';
        try {
          const result = await onSubmit(data);
          submit.textContent = 'Done. Thank you.';
          setTimeout(() => close(result), 1200);
        } catch (err) {
          $('[data-error]', box).textContent = err.message || 'Something went wrong.';
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
    });
  }

  // Styled toast — the on-brand replacement for native alert() on consumer
  // pages. toast(msg, {error}) shows an ink pill bottom-center that fades after
  // a few seconds. Exposed as window.Legacy.toast.
  function toast(message, opts = {}) {
    let wrap = document.querySelector('.lg-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'lg-toast-wrap';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = 'lg-toast' + (opts.error ? ' lg-toast--err' : '');
    t.textContent = message;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, opts.duration || 4200);
  }

  // ---------------------------------------------------------------------------
  // Lead intake helper
  // ---------------------------------------------------------------------------
  async function submitLead(extra) {
    const payload = { source: 'website_form', ...extra };
    const { ok, json } = await api('/api/leads/intake', { body: payload });
    if (!ok || !json?.success) throw new Error(json?.error || 'Network error');
    return json;
  }

  // ---------------------------------------------------------------------------
  // Page wiring
  // ---------------------------------------------------------------------------
  function wireHomepage() {
    // The four journey-step buttons already toggle via inline setJourney(this);
    // we just need to read which is active when "Save my place" is clicked.
    const saveLink = $('.journey-link');
    if (!saveLink) return;
    saveLink.addEventListener('click', async (e) => {
      e.preventDefault();
      // Which lane? (buyer / seller) — the chips carry '.is-on', not '.active'.
      const sideEl = $('.journey-side.is-on');
      const lead_type = (sideEl?.getAttribute('data-side') === 'seller') ? 'seller' : 'buyer';
      const active = $('.journey-step.is-on');
      const stageLabel = (active?.textContent || '').trim();
      // Buyer stages map to the intake's allowed journey values; seller stages
      // don't (the CRM tracks those as seller_stage), so we carry the seller's
      // chosen stage in the message instead and leave journey_stage null.
      const stageMap = {
        'Discovering':    'discovering',
        'Narrowing':      'narrowing',
        'Touring':        'touring',
        'Ready to offer': 'ready_to_offer'
      };
      const journey_stage = lead_type === 'buyer' ? (stageMap[stageLabel] || 'discovering') : null;
      const message = `Homepage: ${lead_type === 'seller' ? 'Selling' : 'Buying'}${stageLabel ? ' — ' + stageLabel : ''}`;

      const result = await openModal({
        title:  lead_type === 'seller' ? 'Save your place.' : 'Save your place.',
        intro:  lead_type === 'seller'
          ? 'Tell us where to reach you — Sara will follow up about your property within the day. No autoresponders.'
          : 'We will reach out within the day. No autoresponders.',
        fields: [
          { name: 'first_name', label: 'First name', required: true },
          { name: 'last_name',  label: 'Last name' },
          { name: 'email',      label: 'Email',     type: 'email', required: true },
          { name: 'phone',      label: 'Mobile (optional)' },
              SMS_CONSENT_FIELD
        ],
        submitLabel: 'Save my place',
        onSubmit: async (data) => {
          const r = await submitLead({ ...data, journey_stage, lead_type, message });
          return { ...r, email: data.email };
        }
      });
      if (result?.email) location.href = `dashboard.html?email=${encodeURIComponent(result.email)}`;
      else if (result)   location.href = 'dashboard.html';
    });
  }

  function wireFindMyMatch() {
    // Every page has one or more "Find My Match" links → platform.html.
    // We intercept them and open a modal in place; the link still works as fallback.
    $$('a').forEach(a => {
      if ((a.textContent || '').trim().toLowerCase() !== 'find my match') return;
      // The redesign has a dedicated find-my-match.html with its own form
      // posting to /api/leads/intake — let those links navigate normally.
      // Only orphaned / legacy links still get the in-place modal.
      if (((a.getAttribute('href') || '')).toLowerCase().includes('find-my-match')) return;
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        await openModal({
          title:  'Find your match.',
          intro:  'Tell us where you are looking and roughly what you can spend. Sara reviews each one personally.',
          fields: [
            { name: 'first_name', label: 'First name', required: true },
            { name: 'last_name',  label: 'Last name' },
            { name: 'email',      label: 'Email',     type: 'email', required: true },
            { name: 'phone',      label: 'Mobile' },
            SMS_CONSENT_FIELD,
            { name: 'areas',      label: 'Towns you are watching', placeholder: 'Murphys, Arnold, Sutter Creek' },
            { name: 'price_max',  label: 'Top of your range (USD)' },
            { name: 'message',    label: 'Anything we should know', type: 'textarea' }
          ],
          submitLabel: 'Send to Sara',
          onSubmit: (data) => submitLead({
            ...data,
            areas: data.areas ? data.areas.split(',').map(s => s.trim()).filter(Boolean) : null,
            price_max: data.price_max ? Number(data.price_max.toString().replace(/[^\d]/g,'')) : null,
            lead_type: 'buyer',
            journey_stage: 'narrowing'
          })
        });
      });
    });
  }

  // A2P express consent — unchecked by default, added to every form that
  // collects a phone number. Full program terms live at /sms-policy.html.
  const SMS_CONSENT_FIELD = {
    name: 'sms_consent', type: 'checkbox',
    label: 'Text me about my inquiry — appointment reminders and listing updates from Legacy Properties. Frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. <a href="/sms-terms.html" target="_blank" rel="noopener" style="color:#7C6A4D;">Terms</a> &amp; <a href="/privacy.html" target="_blank" rel="noopener" style="color:#7C6A4D;">Privacy Policy</a>. Not required.'
  };

  function wireListingsPage() {
    if (!/\/(listings|property-search)\.html$/.test(location.pathname)) return;
    // "Message Sara" buttons in the polygon CTA strip
    $$('button').forEach(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t === 'message sara') {
        b.addEventListener('click', async (e) => {
          e.preventDefault();
          await openModal({
            title:  'Message Sara.',
            intro:  'Quick question or a custom search request. She reads everything herself.',
            fields: [
              { name: 'first_name', label: 'First name', required: true },
              { name: 'email',      label: 'Email',      type: 'email', required: true },
              { name: 'phone',      label: 'Mobile (optional)' },
              SMS_CONSENT_FIELD,
              { name: 'message',    label: 'Your message', type: 'textarea', required: true }
            ],
            submitLabel: 'Send',
            onSubmit: (data) => submitLead({ ...data, lead_type: 'buyer' })
          });
        });
      }
      if (t === 'book a tour') {
        b.addEventListener('click', async (e) => {
          e.preventDefault();
          await openModal({
            title:  'Book a tour.',
            intro:  'Pick the time in the next step. We will confirm by text.',
            fields: [
              { name: 'first_name', label: 'First name', required: true },
              { name: 'last_name',  label: 'Last name' },
              { name: 'email',      label: 'Email',     type: 'email', required: true },
              { name: 'phone',      label: 'Mobile',    required: true },
              SMS_CONSENT_FIELD
            ],
            submitLabel: 'Request a tour',
            onSubmit: (data) => submitLead({ ...data, lead_type: 'buyer', journey_stage: 'touring' })
          });
        });
      }
    });
  }

  function wireListingDetailPage() {
    if (!/\/(listing|property)\.html$/.test(location.pathname)) return;

    // ---- Tour scheduler ----
    const tabs   = $$('.tour-tab');
    const days   = $$('.tour-day');
    const slots  = $$('.tour-slot');
    const submit = $$('button').find(b => /request tour/i.test(b.textContent || ''));

    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.remove('on')); t.classList.add('on');
    }));
    days.forEach(d => d.addEventListener('click', () => {
      if (d.classList.contains('disabled')) return;
      days.forEach(x => x.classList.remove('on')); d.classList.add('on');
    }));
    slots.forEach(s => s.addEventListener('click', () => {
      slots.forEach(x => x.classList.remove('on')); s.classList.add('on');
    }));

    submit?.addEventListener('click', async (e) => {
      e.preventDefault();
      const tourType = $('.tour-tab.on')?.textContent?.toLowerCase().includes('video') ? 'video' : 'in_person';
      const dayEl    = $('.tour-day.on');
      const slotEl   = $('.tour-slot.on');
      if (!dayEl || !slotEl) { toast('Pick a day and time.', { error: true }); return; }

      // Build a scheduled_at ISO from day number + slot text (current year + month)
      const now = new Date();
      const dom = parseInt(dayEl.querySelector('.num')?.textContent || '0', 10);
      const [time, ampm] = (slotEl.textContent || '').trim().split(' ');
      const [hh, mm]     = time.split(':').map(Number);
      let hour = hh % 12; if (/pm/i.test(ampm)) hour += 12;
      const when = new Date(now.getFullYear(), now.getMonth(), dom, hour, mm || 0);
      if (when < now) when.setMonth(when.getMonth() + 1);

      await openModal({
        title:  'Confirm your tour.',
        intro:  `${tourType === 'video' ? 'Video tour' : 'In-person'} · ${when.toLocaleString(undefined, { weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}`,
        fields: [
          { name: 'first_name', label: 'First name', required: true },
          { name: 'last_name',  label: 'Last name' },
          { name: 'email',      label: 'Email',  type: 'email', required: true },
          { name: 'phone',      label: 'Mobile', required: true },
          SMS_CONSENT_FIELD
        ],
        submitLabel: 'Request tour',
        onSubmit: (data) => submitLead({
          ...data,
          lead_type:     'buyer',
          journey_stage: 'touring',
          property_mls:  window.__LEGACY_LISTING_MLS || null,
          property_id:   window.__LEGACY_LISTING_ID  || null,
          tour: { scheduled_at: when.toISOString(), tour_type: tourType }
        })
      });
    });

    // ---- "Send to Sara" sidebar form ----
    const sideForm = $('.contact-form');
    if (sideForm) {
      const btn = sideForm.querySelector('button');
      btn?.addEventListener('click', async (e) => {
        e.preventDefault();
        const ta    = sideForm.querySelector('textarea');
        const name  = sideForm.querySelectorAll('.field-input')[0];
        const email = sideForm.querySelectorAll('.field-input')[1];
        if (!email?.value || !ta?.value) { toast('Add your email and a quick note.', { error: true }); return; }
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          await submitLead({
            first_name: (name?.value || '').trim(),
            email:       email.value.trim(),
            message:     ta.value.trim(),
            lead_type:   'buyer'
          });
          btn.textContent = 'Sent. Thank you.';
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Send to Sara';
          toast(err.message || 'Something went wrong.', { error: true });
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Auth gating for /crm.html, /dashboard.html, /seller.html
  // ---------------------------------------------------------------------------
  async function ensureSession(requiredRoles) {
    // Never let the "Checking session…" overlay trap the user: if the session
    // check rejects (network) or hangs (backend not responding), fall through to
    // the sign-in card rather than spinning forever. An 8s cap covers a slow or
    // stuck /api/auth/session so the page always resolves to something usable.
    let res;
    try {
      res = await Promise.race([
        api('/api/auth/session', { method: 'GET' }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('session-timeout')); }, 8000); })
      ]);
    } catch (_) {
      return null;
    }
    const { ok, json } = res || {};
    if (!ok) return null;
    const role = json?.profile?.role;
    if (requiredRoles && !requiredRoles.includes(role)) return null;
    return json;
  }

  // Consumer portals (dashboard/seller) get a discreet "who am I signed in as"
  // chip with a one-click switch, so a lingering session — a shared device, a
  // household, or the agent's own login — is always recoverable and never a
  // trap. Tucked: it collapses to a small badge (the initial) so it doesn't
  // cover a card, and expands to the full line on hover / focus / tap.
  function renderAccountBar(session) {
    if (!/\/(dashboard|seller)\.html$/.test(location.pathname)) return;
    if (document.getElementById('leg-acct-bar')) return;
    const email = ((session && session.user && session.user.email) || '').replace(/[<>]/g, '');
    if (!email) return;
    const initial = (email.trim()[0] || '?').toUpperCase();
    const bar = document.createElement('div');
    bar.id = 'leg-acct-bar';
    bar.className = 'lg-acct';
    bar.innerHTML =
      '<button type="button" class="lg-acct__badge" id="leg-acct-badge" aria-label="Account" aria-expanded="false">' + initial + '</button>'
      + '<span class="lg-acct__body"><span class="who">Signed in as ' + email + '</span>'
      + '<a href="#" id="leg-acct-switch">Not you?</a></span>';
    document.body.appendChild(bar);
    // Tap the badge to toggle open on touch (hover/focus handle desktop).
    document.getElementById('leg-acct-badge').addEventListener('click', function (e) {
      e.preventDefault();
      const open = bar.classList.toggle('is-open');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.getElementById('leg-acct-switch').addEventListener('click', async (e) => {
      e.preventDefault();
      try { await api('/api/auth/session', { method: 'DELETE' }); } catch (_) {}
      // Land on a clean sign-in card; drop any ?email so it doesn't re-loop.
      location.href = location.pathname;
    });
  }

  async function gate(requiredRoles) {
    // Inject an immediate full-screen dimmer so the prototype mock can never
    // flash before we know who the visitor is. The overlay is created
    // synchronously on the documentElement so it shows even before <body>
    // has finished parsing.
    let overlay = document.getElementById('leg-auth-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'leg-auth-overlay';
      overlay.className = 'lg-ov lg-ov--solid';
      overlay.style.zIndex = '99998';   // sit under an intake modal if both open
      overlay.innerHTML = '<div class="lg-ov__checking">Checking session…</div>';
      (document.body || document.documentElement).appendChild(overlay);
    }

    // The email the visitor intends to sign in as, if they arrived with one
    // (e.g. the post-registration redirect adds ?email=…). Used to stop a
    // lingering session from routing a new person into the wrong account.
    const wantEmail = (new URLSearchParams(location.search).get('email') || '').trim().toLowerCase();

    const session = await ensureSession(requiredRoles);
    if (session) {
      const sessEmail = ((session.user && session.user.email) || '').trim().toLowerCase();
      // If they explicitly came to sign in as a specific email that isn't the
      // one already signed in on this device, do NOT silently hand them the
      // other account — fall through to the sign-in card (prefilled with the
      // email they intend). A returning user with no ?email, or a matching
      // email, is accepted normally so we never force a needless re-login.
      if (wantEmail && sessEmail && wantEmail !== sessEmail) {
        // fall through to sign-in card
      } else {
        overlay.remove();
        renderAccountBar(session);
        return session;
      }
    }

    // Not signed in (or wrong role) — turn the overlay into a sign-in card.
    // CRM uses password; buyer/seller dashboards use magic link.
    const primaryRole = (requiredRoles || [])[0] || '';
    const isAgent = primaryRole.startsWith('agent_') || primaryRole === 'admin';
    const prefillEmail = new URLSearchParams(location.search).get('email') || '';

    overlay.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'lg-sheet';
    card.innerHTML = `
      <div class="lg-sheet__eyebrow">Legacy Properties</div>
      <h2 class="lg-sheet__title">${isAgent ? 'Open the desk.' : 'See your dashboard.'}</h2>
      ${isAgent ? '' : '<p class="lg-sheet__intro">Enter your email and we will send you a one-click link. No password to remember.</p>'}
      <form id="leg-auth" class="lg-sheet__form">
        <input name="email" type="email" class="lg-field" placeholder="Email" required value="${prefillEmail.replace(/"/g,'')}">
        ${isAgent ? '<input name="password" type="password" class="lg-field" placeholder="Password" required>' : ''}
        <button type="submit" class="lg-btn lg-btn--gold">${isAgent ? 'Sign in' : 'Email me the link'}</button>
        <div id="leg-auth-msg" class="lg-sheet__err" style="color:rgba(255,253,248,.6);"></div>
      </form>`;
    overlay.appendChild(card);

    const form = card.querySelector('#leg-auth');
    const msg  = card.querySelector('#leg-auth-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      msg.textContent = 'Working…';
      if (isAgent) {
        const r = await api('/api/auth/login', { body: data });
        if (!r.ok) { msg.textContent = r.json?.error || 'Sign-in failed.'; return; }
        await api('/api/auth/session', {
          body: { access_token: r.json.session.access_token, refresh_token: r.json.session.refresh_token }
        });
        location.reload();
      } else {
        const r = await api('/api/auth/magic-link', { body: { email: data.email } });
        if (r.ok) {
          form.innerHTML = `
            <div class="lg-sheet__title" style="font-size:24px;margin-bottom:10px;">Check your email.</div>
            <p class="lg-sheet__intro" style="margin:0 0 8px;">We just sent a one-click sign-in link to <strong style="color:var(--lg-cream);">${data.email.replace(/</g,'')}</strong>.</p>
            <p class="lg-sheet__intro" style="font-size:13px;margin:0;opacity:.75;">It can take up to a minute. Look in spam if you do not see it.</p>`;
        } else {
          msg.textContent = r.json?.error || 'Could not send link.';
        }
      }
    });
    return null;
  }

  // ---------------------------------------------------------------------------
  // Phase 1D — CRM live data wiring
  // ---------------------------------------------------------------------------
  function fmtUSD(n) {
    if (!n) return '$0';
    if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `$${Math.round(n/1_000)}K`;
    return `$${n}`;
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const diffMin = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diffMin < 1)   return 'just now';
    if (diffMin < 60)  return `${Math.round(diffMin)} min ago`;
    if (diffMin < 1440) return `${Math.round(diffMin/60)}h ago`;
    return `${Math.round(diffMin/1440)}d ago`;
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  // Signed-in agent's first name (this IIFE's scope) — the Today brief speaks
  // to whoever's logged in, not a hardcoded Sara.
  let agentFirst = 'Sara';
  function agentFirstFrom(session) {
    const full = ((session && session.profile && session.profile.display_name) || '').trim();
    if (full) return full.split(/\s+/)[0];
    const role = (session && session.profile && session.profile.role) || '';
    return /james/i.test(role) ? 'James' : 'Sara';
  }

  async function wireCrmPage(session) {
    // Establish the signed-in agent up front so every render speaks as them.
    agentFirst = agentFirstFrom(session);
    // Run all loaders in parallel
    window.LegacyDealColors.ready();
    const [briefRes, inboxRes, pipelineRes, metricsRes] = await Promise.all([
      api('/api/crm/morning-brief', { method: 'GET' }),
      api('/api/crm/inbox?filter=awaiting_reply&limit=20', { method: 'GET' }),
      api('/api/crm/pipeline', { method: 'GET' }),
      api('/api/crm/metrics', { method: 'GET' })
    ]);

    if (briefRes.ok) {
      paintMorningBrief(briefRes.json, session);
      paintLiveFeed(briefRes.json);
      paintActiveDeals(briefRes.json.active_deals || []);
      paintHours(briefRes.json.hours || []);
      paintReportsFunnel(briefRes.json.funnel || null);
    }
    paintNeedsQueue(briefRes.ok ? briefRes.json : {}, inboxRes.ok ? (inboxRes.json.messages || []) : []);
    // Deadline-watch band retired — every contingency/COE now lives inline in the
    // Deals-in-motion table below, so the cross-deal countdown was a third copy.
    loadLeadHygiene();
    startTodayPulse();
    if (pipelineRes.ok) paintPipelineStats(pipelineRes.json);
    if (metricsRes.ok)  paintCrmMetrics(metricsRes.json);
  }

  // ---------------------------------------------------------------------------
  // Today-view panels (signals, active deals, hours, reports funnel)
  // ---------------------------------------------------------------------------
  // ---- Lead hygiene (Reports view) ---------------------------------------
  async function loadLeadHygiene() {
    const card = document.querySelector('[data-hygiene-card]');
    if (!card) return;
    const r = await api('/api/crm/lead-hygiene', { method: 'GET' });
    if (!r.ok) return;
    const d = r.json || {};
    const b = d.buckets || {};
    const noisy = (b.dormant?.count || 0) + (b.no_contact_info?.count || 0);
    if (!noisy) return; // clean book — stay hidden
    card.style.display = '';
    document.querySelector('[data-hyg-summary]').textContent =
      `${d.total_active} active leads — ${noisy} look like noise (${b.dormant?.count || 0} dormant ${d.days}+ days, ${b.no_contact_info?.count || 0} with no contact info).`;
    const wrap = document.querySelector('[data-hyg-buckets]');
    const bucketHtml = (key, label, bb) => {
      if (!bb || !bb.count) return '';
      const sample = (bb.sample || []).map((l) => escapeHtml(l.name)).slice(0, 3).join(', ');
      return `<div style="flex:1 1 260px;border:1px solid var(--rule);background:#fff;padding:12px 14px;">
        <div style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute);">${label}</div>
        <div style="font-size:26px;font-family:var(--serif);margin:4px 0 2px;">${bb.count}${bb.capped ? '+' : ''}</div>
        <div style="font-size:11.5px;color:var(--ink-soft);">${sample ? 'e.g. ' + sample : ''}</div>
        <button class="btn btn-ghost btn-sm" data-hyg-archive="${key}" style="margin-top:10px;">Archive these ${bb.count}${bb.capped ? '+' : ''}</button>
      </div>`;
    };
    wrap.innerHTML =
      bucketHtml('dormant', `Dormant · no contact in ${d.days}+ days`, b.dormant) +
      bucketHtml('no_contact_info', 'No email or phone on file', b.no_contact_info);
    wrap.querySelectorAll('[data-hyg-archive]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bucket = btn.getAttribute('data-hyg-archive');
        if (!confirm(`Archive this whole bucket? They leave the active pipeline but are never deleted.`)) return;
        btn.disabled = true; btn.textContent = 'Archiving…';
        const rr = await api('/api/crm/lead-hygiene', { method: 'POST', body: { action: 'archive', bucket } });
        if (rr.ok) { btn.textContent = `Archived ${rr.json.archived}`; setTimeout(loadLeadHygiene, 800); }
        else { btn.disabled = false; btn.textContent = 'Archive failed — retry'; }
      });
    });
  }

  document.addEventListener('lgc:dealcolors', () => {
    document.querySelectorAll('[data-open-deal]').forEach((el) => {
      const c = window.LegacyDealColors.get(el.getAttribute('data-open-deal'));
      if (c) el.style.borderLeft = '5px solid ' + c.border;
    });
  });
  document.addEventListener('click', (e) => {
    const dl = e.target.closest('[data-open-deal]');
    if (dl && typeof window.openDealByKey === 'function') { window.openDealByKey(dl.getAttribute('data-open-deal')); return; }
    const pp = e.target.closest('[data-open-person]');
    if (pp && typeof window.openPeople === 'function') { window.openPeople(pp.getAttribute('data-open-person')); }
  });

  function emptyPanel(msg) {
    return `<div style="grid-column:1/-1;padding:24px;text-align:left;opacity:.55;font-style:italic;font-size:14px;">${escapeHtml(msg)}</div>`;
  }

  // ---- Local per-device dismissals — hide a stale nudge or feed item for good.
  // Kept in localStorage (no server round-trip); a nudge re-appears only if its
  // collection is re-pushed (the key includes pushed_at). Capped so it can't grow
  // without bound.
  function lgDismissedSet() { try { return new Set(JSON.parse(localStorage.getItem('lgDismissed') || '[]')); } catch (_) { return new Set(); } }
  function lgIsDismissed(k) { return !!k && lgDismissedSet().has(k); }
  function lgDismiss(k) { if (!k) return; try { const s = lgDismissedSet(); s.add(k); localStorage.setItem('lgDismissed', JSON.stringify(Array.from(s).slice(-500))); } catch (_) {} }
  function lgUndismiss(k) { if (!k) return; try { const s = lgDismissedSet(); s.delete(k); localStorage.setItem('lgDismissed', JSON.stringify(Array.from(s).slice(-500))); } catch (_) {} }
  // Per-DAY cross-off key for the (derived) day list, so a tick survives a refresh
  // but the list is fresh again tomorrow. Old dated keys simply never re-match.
  function dayOffKey(title) {
    const d = new Date().toISOString().slice(0, 10);
    const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `dayoff:${d}:${slug}`;
  }
  function nudgeKey(n) { return 'ndg:' + (n.collection_id || '') + ':' + (n.pushed_at || ''); }
  function feedKey(i) { return 'sig:' + (i.ts || '') + '|' + String(i.body || '').slice(0, 64); }

  // ---- The decision queue: everything that needs Sara, one ranked list ----
  // Timeline approvals (maroon), collection nudges (green), then AI drafts.
  function paintNeedsQueue(brief, drafts) {
    const needs = $('.needs');
    if (!needs) return;
    needs.querySelectorAll('.need-card').forEach(el => el.remove());
    const approvals = brief.timeline_approvals || [];
    // Follow-ups land per agent: yours show by default; the broker gets a toggle
    // to reveal the other agent's (each nudge is tagged mine:true/false).
    const allNudges = (brief.collection_nudges || []).filter((n) => !lgIsDismissed(nudgeKey(n)));
    const nudges = allNudges.filter((n) => n.mine !== false);
    const otherNudges = allNudges.filter((n) => n.mine === false);
    // Gone-quiet leads + deal data-flags: morning-brief computes these, but they
    // were only ever "called out" inside the AI prose — never as something you
    // could act on. Surface them in the queue so nothing needs hunting for.
    const silent  = brief.radio_silence || [];
    const gaps    = brief.data_gaps || [];
    const parties = brief.party_reconcile || [];
    const flags   = gaps.length + parties.length;
    const total = approvals.length + nudges.length + drafts.length + silent.length + flags;

    const eyebrow = needs.querySelector('.eyebrow');
    if (eyebrow) eyebrow.textContent = total
      ? ['Needs you', approvals.length ? `${approvals.length} approval${approvals.length === 1 ? '' : 's'}` : '',
         drafts.length ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : '',
         nudges.length ? `${nudges.length} follow-up${nudges.length === 1 ? '' : 's'}` : '',
         silent.length ? `${silent.length} gone quiet` : '',
         flags ? `${flags} data flag${flags === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
      : 'Needs you · clear desk';
    const h2 = needs.querySelector('.h-section');
    if (h2) h2.textContent = total ? 'Your decision queue.' : 'Nothing pending.';
    const greet = $('.tb-greet');
    if (greet) greet.innerHTML = total
      ? `${total === 1 ? 'One thing needs' : `${total} things need`} <em>you, ${escapeHtml(agentFirst)}.</em>`
      : `Clear desk, <em>${escapeHtml(agentFirst)}.</em>`;

    const changeLabel = (c) => !c ? 'update' : c.status === 'done' ? 'mark done'
      : c.status === 'action' ? 'flag as needs-you' : c.status === 'waived' ? 'mark waived' : 'update';

    approvals.forEach((pr) => {
      const card = document.createElement('article');
      card.className = 'need-card q-dec';
      card.innerHTML = `
        <div class="nc-rank">✓</div>
        <div class="nc-body">
          <div class="nc-meta"><span class="nc-tag">Timeline · ${escapeHtml(pr.address || 'deal')}</span></div>
          <h3>${escapeHtml((pr.item_key || '').replace(/^custom:/, '').replace(/_/g, ' '))} — ${escapeHtml(changeLabel(pr.change))}</h3>
          <p>${escapeHtml(pr.reason || '')}</p>
          <div class="nc-foot"><div class="nc-foot-l"><span>Applies to the seller's page the moment you approve</span></div>
            <div class="nc-foot-r">
              <button class="btn btn-ghost btn-sm" data-tl-reject="${escapeHtml(pr.id)}">Reject</button>
              <button class="btn btn-ink btn-sm" data-tl-approve="${escapeHtml(pr.id)}">Approve</button>
            </div></div>
          <div data-reject-panel style="display:none;margin-top:10px;">
            <textarea data-reject-note rows="2" placeholder="What's off? Cowork reads this to correct itself — e.g. “CRB No. 2 removes all but the loan” or “misread — not signed yet.”" style="width:100%;font:inherit;font-size:13px;line-height:1.5;padding:8px 10px;border:1px solid #D9CFB7;background:#fff;"></textarea>
            <div style="display:flex;gap:8px;margin-top:6px;">
              <button class="btn btn-ghost btn-sm" data-reject-cancel>Cancel</button>
              <button class="btn btn-ink btn-sm" data-reject-send="${escapeHtml(pr.id)}">Send rejection</button>
            </div>
          </div>
          <div data-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
        </div>`;
      needs.appendChild(card);
      const resEl = card.querySelector('[data-result]');
      const rejectPanel = card.querySelector('[data-reject-panel]');
      const footR = card.querySelector('.nc-foot-r');
      card.querySelector('[data-tl-approve]').addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Applying…';
        const r = await api('/api/crm/timeline', { body: { op: 'approve', proposal_id: pr.id } });
        if (r.ok) { card.style.opacity = '.5'; card.querySelectorAll('button').forEach((b) => { b.disabled = true; }); resEl.style.color = '#2E5C3D'; resEl.textContent = '✓ Applied — the seller page is updated.'; }
        else { btn.disabled = false; btn.textContent = 'Approve'; resEl.style.color = '#9B2C2C'; resEl.textContent = r.json?.error || 'Failed — try again.'; }
      });
      // Reject reveals a reason box (the correction Cowork reads back). Sending
      // it rejects the proposal WITHOUT applying the change — the item stays live.
      card.querySelector('[data-tl-reject]').addEventListener('click', () => { if (footR) footR.style.display = 'none'; rejectPanel.style.display = 'block'; const ta = rejectPanel.querySelector('[data-reject-note]'); if (ta) ta.focus(); });
      card.querySelector('[data-reject-cancel]').addEventListener('click', () => { rejectPanel.style.display = 'none'; if (footR) footR.style.display = ''; });
      card.querySelector('[data-reject-send]').addEventListener('click', async (e) => {
        const btn = e.currentTarget; const note = (rejectPanel.querySelector('[data-reject-note]').value || '').trim();
        btn.disabled = true; btn.textContent = 'Sending…';
        const r = await api('/api/crm/timeline', { body: { op: 'reject', proposal_id: pr.id, note } });
        if (r.ok) { card.style.opacity = '.5'; card.querySelectorAll('button,textarea').forEach((b) => { b.disabled = true; }); resEl.style.color = '#2E5C3D'; resEl.textContent = note ? '✓ Rejected — Cowork will see your note.' : '✓ Rejected — the item stays live.'; }
        else { btn.disabled = false; btn.textContent = 'Send rejection'; resEl.style.color = '#9B2C2C'; resEl.textContent = r.json?.error || 'Failed — try again.'; }
      });
    });

    const renderNudge = (n, beforeEl) => {
      const card = document.createElement('article');
      card.className = 'need-card q-cli';
      const ownerTag = n.mine === false ? ` · <strong style="text-transform:capitalize;">${escapeHtml(n.agent || 'agent')}</strong>'s client` : '';
      card.innerHTML = `
        <div class="nc-rank">…</div>
        <div class="nc-body">
          <div class="nc-meta"><span class="nc-tag">Client · curated collection${ownerTag}</span></div>
          <h3>${escapeHtml(n.client_name || 'Your client')} hasn't reacted to “${escapeHtml(n.title)}”</h3>
          <p>Pushed ${n.days_since_push} days ago · no reaction yet. Worth a nudge.</p>
          <div class="nc-foot"><div class="nc-foot-l"></div><div class="nc-foot-r">
            <button class="btn btn-ghost btn-sm" data-nudge-dismiss>Dismiss</button>
            <button class="btn btn-ghost btn-sm" data-open-curate>Open collection →</button>
          </div></div>
        </div>`;
      if (beforeEl) needs.insertBefore(card, beforeEl); else needs.appendChild(card);
      const dbtn = card.querySelector('[data-nudge-dismiss]');
      if (dbtn) dbtn.addEventListener('click', () => { lgDismiss(nudgeKey(n)); card.remove(); });
      card.querySelector('[data-open-curate]').addEventListener('click', () => {
        if (typeof window.showView === 'function') window.showView(null, 'curate');
        // Open THIS client's collection, not just the Curate tab.
        if (n.collection_id && window.LegacyCurate && window.LegacyCurate.open) {
          setTimeout(() => window.LegacyCurate.open(n.collection_id), 80);
        }
      });
    };
    nudges.forEach((n) => renderNudge(n));

    // Gone quiet — the leads morning-brief flagged as 14+ days no contact, now
    // shown BY NAME with a one-click jump to each so "who are they?" is answered
    // and you can actually reach out. Reaching out logs contact → drops next brief.
    if (silent.length) {
      const daysSince = (iso) => { if (!iso) return null; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return isNaN(d) ? null : d; };
      const card = document.createElement('article');
      card.className = 'need-card q-cli';
      const rows = silent.map((l) => {
        const nm = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Lead';
        const fn = l.first_name || nm;
        const d = daysSince(l.last_contact_at);
        const temp = l.temperature ? `<span style="text-transform:capitalize;color:var(--ink-mute);">${escapeHtml(l.temperature)}</span> · ` : '';
        const tel = l.phone ? String(l.phone).replace(/[^0-9+]/g, '') : '';
        const opener = `Hi ${fn}, it's ${agentFirst} — it's been a little while. Anything I can help you look at right now?`;
        return `<div data-rs-row style="padding:9px 0;border-top:1px solid rgba(0,0,0,.06);">
            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <span style="font-size:14px;">${temp}<strong>${escapeHtml(nm)}</strong>${d != null ? ` · ${d} days quiet` : ''}</span>
              <span style="display:flex;gap:6px;flex-wrap:wrap;">
                ${tel ? `<a class="btn btn-ghost btn-sm" href="tel:${escapeHtml(tel)}">Call</a>` : ''}
                <button class="btn btn-ghost btn-sm" data-rs-text${tel ? '' : ' disabled title="No phone on file"'}>Text</button>
                <button class="btn btn-ghost btn-sm" data-rs-dismiss="${escapeHtml(l.id)}" title="Already reached out (e.g. by phone) — clears this and resets the 14-day clock">Dismiss</button>
                <button class="btn btn-ink btn-sm" data-open-lead="${escapeHtml(l.id)}">Open →</button>
              </span>
            </div>
            <div data-rs-composer style="display:none;margin-top:8px;">
              <textarea data-rs-body rows="2" style="width:100%;font:inherit;font-size:13px;line-height:1.5;padding:7px 9px;border:1px solid #D9CFB7;background:#fff;">${escapeHtml(opener)}</textarea>
              <div style="display:flex;gap:6px;margin-top:5px;align-items:center;">
                <button class="btn btn-ink btn-sm" data-rs-send="${escapeHtml(l.id)}">Send text</button>
                <button class="btn btn-ghost btn-sm" data-rs-cancel>Cancel</button>
                <span data-rs-status style="font-size:12px;"></span>
              </div>
            </div>
          </div>`;
      }).join('');
      card.innerHTML = `
        <div class="nc-rank">…</div>
        <div class="nc-body">
          <div class="nc-meta"><span class="nc-tag">Follow-up · gone quiet 14+ days</span></div>
          <h3>${silent.length} lead${silent.length === 1 ? '' : 's'} ${silent.length === 1 ? 'has' : 'have'} gone quiet</h3>
          <p>No contact logged in over two weeks. Call or text right here, or open the full lead.</p>
          <div style="margin-top:8px;">${rows}</div>
        </div>`;
      needs.appendChild(card);
      card.querySelectorAll('[data-open-lead]').forEach((b) => b.addEventListener('click', () => {
        const id = b.getAttribute('data-open-lead');
        if (window.Legacy && window.Legacy.openLead) window.Legacy.openLead(id);
      }));
      // Inline quick-text: sends through the CRM (Twilio, logged), no need to open the lead.
      card.querySelectorAll('[data-rs-text]').forEach((b) => b.addEventListener('click', () => {
        const comp = b.closest('[data-rs-row]').querySelector('[data-rs-composer]');
        if (comp) { comp.style.display = 'block'; const ta = comp.querySelector('[data-rs-body]'); if (ta) ta.focus(); }
      }));
      card.querySelectorAll('[data-rs-cancel]').forEach((b) => b.addEventListener('click', () => {
        const comp = b.closest('[data-rs-composer]'); if (comp) comp.style.display = 'none';
      }));
      // Dismiss: "I already reached out (usually by phone)." Records contact so
      // the lead drops off the next brief — the truest fix for a false nudge,
      // and it never asks you to text a DNC contact. Updates the header count.
      card.querySelectorAll('[data-rs-dismiss]').forEach((b) => b.addEventListener('click', async () => {
        const row = b.closest('[data-rs-row]');
        b.disabled = true; b.textContent = 'Dismissing…';
        const r = await api('/api/crm/log-contact', { body: { lead_id: b.getAttribute('data-rs-dismiss'), note: 'Marked contacted from Today — reached out outside the CRM.' } });
        if (r.ok && r.json && r.json.logged) {
          if (row) { row.style.opacity = '.4'; row.querySelectorAll('button,a,textarea').forEach((el) => { el.disabled = true; }); }
          const rank = card.querySelector('.nc-rank');
          const remaining = card.querySelectorAll('[data-rs-row]').length
            - card.querySelectorAll('[data-rs-row][data-rs-done]').length - 1;
          if (row) row.setAttribute('data-rs-done', '1');
          const h = card.querySelector('h3');
          if (h && remaining >= 0) h.textContent = `${remaining} lead${remaining === 1 ? '' : 's'} ${remaining === 1 ? 'has' : 'have'} gone quiet`;
          if (remaining <= 0 && rank) card.style.opacity = '.55';
        } else {
          b.disabled = false; b.textContent = 'Dismiss';
        }
      }));
      card.querySelectorAll('[data-rs-send]').forEach((b) => b.addEventListener('click', async () => {
        const row = b.closest('[data-rs-row]');
        const ta = row.querySelector('[data-rs-body]');
        const statusEl = row.querySelector('[data-rs-status]');
        const text = (ta && ta.value || '').trim();
        if (!text) { statusEl.style.color = '#9B2C2C'; statusEl.textContent = 'Write something first'; return; }
        b.disabled = true; b.textContent = 'Sending…'; statusEl.style.color = ''; statusEl.textContent = '';
        const r = await api('/api/crm/message', { body: { lead_id: b.getAttribute('data-rs-send'), channel: 'sms', body: text } });
        if (r.ok && r.json && r.json.status === 'sent') {
          const comp = row.querySelector('[data-rs-composer]'); if (comp) comp.style.display = 'none';
          row.style.opacity = '.55';
          statusEl.style.color = '#2E5C3D'; statusEl.textContent = '✓ Sent';
        } else {
          b.disabled = false; b.textContent = 'Send text';
          statusEl.style.color = '#9B2C2C'; statusEl.textContent = (r.json && r.json.error) || 'Failed — open the lead to send.';
        }
      }));
    }

    // Data flags — deal-level items morning-brief computed for Cowork to fix (a
    // pending deal missing its price, a party edit awaiting reconcile). Shown so
    // they're visible and not a surprise; tagged so it's clear Cowork handles them.
    if (flags) {
      const card = document.createElement('article');
      card.className = 'need-card q-info';
      const rows = [
        ...gaps.map((g) => `<li>${escapeHtml(g.address || g.source_key)} — <span style="color:var(--ink-mute);">missing price on a pending deal</span></li>`),
        ...parties.map((p) => `<li>${escapeHtml(p.address || p.source_key)} — <span style="color:var(--ink-mute);">party edit awaiting reconcile</span></li>`)
      ].join('');
      card.innerHTML = `
        <div class="nc-rank">i</div>
        <div class="nc-body">
          <div class="nc-meta"><span class="nc-tag">Data · your briefing handles these</span></div>
          <h3>${flags} deal${flags === 1 ? '' : 's'} flagged for a data fix</h3>
          <p>Your morning briefing corrects these in the master file — listed here so nothing slips by silently.</p>
          <ul style="margin:8px 0 0;padding-left:18px;font-size:13.5px;line-height:1.7;color:var(--ink-soft);">${rows}</ul>
        </div>`;
      needs.appendChild(card);
    }

    // Broker toggle — reveal the other agent's follow-ups on demand.
    if (otherNudges.length) {
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-ghost btn-sm';
      toggle.style.cssText = 'margin:4px 0 8px;align-self:flex-start;';
      toggle.textContent = `＋ Show ${otherNudges.length} follow-up${otherNudges.length === 1 ? '' : 's'} on the other agent's clients`;
      let shown = false;
      toggle.addEventListener('click', () => {
        if (shown) return;
        shown = true;
        otherNudges.forEach((n) => renderNudge(n, toggle));
        toggle.textContent = `Showing all agents' follow-ups`;
        toggle.disabled = true;
        toggle.style.opacity = '.6';
      });
      needs.appendChild(toggle);
    }

    paintQuietAsks(drafts, { embedded: true, queueEmpty: total === 0 });
  }

  // Phase 2D — builds a human summary + tag for a recent_comms group that may
  // mix texts, calls, AND email (contacts are grouped by contact_id, so one
  // person's text + email today land in the same group). Keeps the existing
  // "Texts & calls" wording when there's no email in the mix, so old groups
  // read exactly as before; only adds an "& email" distinction when present.
  function commsSummary(c) {
    const parts = [];
    if (c.texts)  parts.push(`${c.texts} text${c.texts === 1 ? '' : 's'}`);
    if (c.calls)  parts.push(`${c.calls} call${c.calls === 1 ? '' : 's'}`);
    if (c.emails) parts.push(`${c.emails} email${c.emails === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }
  function commsTag(c) {
    const hasEmail = !!c.emails;
    const hasPhone = !!(c.texts || c.calls);
    if (hasEmail && hasPhone) return 'Texts, calls & email';
    if (hasEmail) return 'Email';
    return 'Texts & calls';
  }

  // ---- Live feed: signals + Twilio comms merged, filterable, one stream ----
  let feedItems = [], feedFilter = 'all';
  function paintLiveFeed(brief) {
    const grid = document.querySelector('[data-signal-grid]');
    if (!grid) return;
    const comms = document.querySelector('[data-comms-section]');
    if (comms) comms.style.display = 'none';
    const sec = grid.closest('.signals');
    if (sec) {
      const eb = sec.querySelector('.eyebrow');
      if (eb) eb.textContent = 'Live feed · signals, texts and calls, portal activity';
      const h = sec.querySelector('.h-section');
      if (h) h.textContent = 'What’s happening.';
      if (!sec.querySelector('.feed-chips')) {
        const chips = document.createElement('div');
        chips.className = 'feed-chips';
        chips.innerHTML = ['all', 'clients', 'deals'].map((k) =>
          `<button class="feed-chip${k === 'all' ? ' on' : ''}" data-chip-k="${k}">${k}</button>`).join('');
        grid.parentNode.insertBefore(chips, grid);
        chips.addEventListener('click', (e) => {
          const b = e.target.closest('[data-chip-k]'); if (!b) return;
          feedFilter = b.getAttribute('data-chip-k');
          chips.querySelectorAll('.feed-chip').forEach((c) => c.classList.toggle('on', c === b));
          renderFeed();
        });
      }
    }
    const DEAL_TAGS = /follow up|deadline|coe|deal|offer|escrow/i;
    feedItems = (brief.signals || []).map((sg) => ({
      time: sg.time, body: sg.body, tag: sg.tag, ts: sg.time_iso || '',
      kind: DEAL_TAGS.test(sg.tag || '') ? 'deals' : 'clients'
    })).concat((brief.recent_comms || []).map((c) => ({
      time: fmtRelative(c.last_at), ts: c.last_at, kind: 'clients', tag: commsTag(c),
      body: `${c.name} — ${commsSummary(c)} in the last day`
    })));
    feedItems.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    renderFeed();
  }
  function renderFeed() {
    const grid = document.querySelector('[data-signal-grid]');
    if (!grid) return;
    const items = feedItems.filter((i) => (feedFilter === 'all' || i.kind === feedFilter) && !lgIsDismissed(feedKey(i))).slice(0, 9);
    if (!items.length) { grid.innerHTML = emptyPanel('Quiet right now. Signals, texts, and portal activity land here as they happen.'); return; }
    grid.innerHTML = items.map((i) => `
      <article class="signal" data-fk="${escapeHtml(feedKey(i))}" style="position:relative">
        <button data-feed-dismiss title="Dismiss" aria-label="Dismiss" style="position:absolute;top:6px;right:8px;border:none;background:none;cursor:pointer;font-size:15px;line-height:1;color:var(--ink-faint);padding:2px 5px;">×</button>
        <span class="sig-time">${escapeHtml(i.time || '')}</span>
        <p>${escapeHtml(i.body)}</p>
        <span class="sig-tag">${escapeHtml(i.tag || 'Signal')}</span>
      </article>`).join('');
    if (!grid._dismissWired) {
      grid._dismissWired = true;
      grid.addEventListener('click', (e) => {
        const x = e.target.closest('[data-feed-dismiss]'); if (!x) return;
        const art = x.closest('[data-fk]'); if (!art) return;
        lgDismiss(art.getAttribute('data-fk')); renderFeed();
      });
    }
  }

  // ---- Pulse: the page stays alive without a reload ----
  let pulseLast = Date.now();
  function startTodayPulse() {
    const label = document.querySelector('[data-live-stamp]');
    const tick = () => {
      if (!label) return;
      const m = Math.round((Date.now() - pulseLast) / 60000);
      label.innerHTML = `<span class="live-dot"></span>live · updated ${m < 1 ? 'just now' : m + 'm ago'}`;
    };
    tick();
    setInterval(tick, 30000);
    setInterval(async () => {
      try {
        const [b, i] = await Promise.all([
          api('/api/crm/morning-brief', { method: 'GET' }),
          api('/api/crm/inbox?filter=awaiting_reply&limit=20', { method: 'GET' })
        ]);
        if (b.ok) { paintLiveFeed(b.json); paintHours(b.json.hours || []); paintActiveDeals(b.json.active_deals || []); }
        paintNeedsQueue(b.ok ? b.json : {}, i.ok ? (i.json.messages || []) : []);
        pulseLast = Date.now(); tick();
      } catch (_) { /* next pulse */ }
    }, 180000);
  }

  function paintSignals(signals) {
    const grid = document.querySelector('[data-signal-grid]');
    if (!grid) return;
    if (!signals.length) {
      grid.innerHTML = emptyPanel('Quiet overnight. No new signals in the last 24 hours.');
      return;
    }
    grid.innerHTML = signals.slice(0, 8).map((s) => `
      <article class="signal">
        <span class="sig-time">${escapeHtml(s.time)}</span>
        <p>${escapeHtml(s.body)}</p>
        <span class="sig-tag">${escapeHtml(s.tag)}</span>
      </article>`).join('');
  }

  function fmtUsdBrief(n) {
    if (n == null) return '—';
    const v = Math.abs(+n);
    if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 2)}M`;
    if (v >= 1_000)     return `$${Math.round(+n / 1_000)}K`;
    return `$${Math.round(+n)}`;
  }

  function paintActiveDeals(deals) {
    const grid = document.querySelector('[data-deal-grid]');
    if (!grid) return;
    if (!deals.length) {
      grid.innerHTML = emptyPanel('No deals currently in motion. Leads at touring/offer/close will show up here.');
      return;
    }
    grid.innerHTML = deals.map((d) => {
      const addressLine = d.address ? `${escapeHtml(d.address)}${d.city ? ' · ' + escapeHtml(d.city) : ''}` : escapeHtml(d.lead_name);
      const dc = window.LegacyDealColors ? window.LegacyDealColors.get(d.lead_id) : null;
      // ONE SHARED TIMELINE: when the deal has milestones, the card shows the
      // four At-a-Glance columns (the same grouping the seller portal + buyer
      // dashboard use); otherwise fall back to the linear track.
      const glance = d.at_a_glance ? renderGlance(d.at_a_glance) : null;
      const body = glance || `<div class="deal-track">${
        (d.track || []).map((step) => {
          const cls = step.done ? 'dt dt-done' : (step.on ? 'dt dt-on' : 'dt');
          return `<span class="${cls}">${escapeHtml(step.label)}</span>`;
        }).join('')
      }</div>`;
      return `
        <article class="deal${glance ? ' deal-wide' : ''}" data-open-deal="${escapeHtml(d.lead_id || '')}" style="cursor:pointer;${dc ? `border-left:5px solid ${dc.border};` : ''}" title="Open this deal's command center" role="link" tabindex="0">
          <div class="deal-h">
            <span class="deal-stage">${escapeHtml(d.stage_label)}</span>
            <span class="deal-amt">${escapeHtml(fmtUsdBrief(d.amount))}</span>
          </div>
          <h4>${addressLine}</h4>
          <p class="deal-buyer">${escapeHtml(d.lead_name)}</p>
          ${body}
        </article>`;
    }).join('');
  }

  // Render a deal's At-a-Glance as four dated columns (Complete / This Week /
  // Inspections & Contingencies / Closing). Shared shape with the seller portal.
  function renderGlance(g) {
    return '<div class="deal-glance">' + (g.columns || []).map((c) => {
      const items = (c.items && c.items.length)
        ? c.items.map((it) => (
            `<li class="dg-item dg-${escapeHtml(it.status || 'upcoming')}">` +
              (it.date_label ? `<span class="dg-date">${escapeHtml(it.date_label)}</span>` : '') +
              `<span class="dg-label">${escapeHtml(it.label)}</span>` +
              (it.desc ? `<span class="dg-desc">${escapeHtml(it.desc)}</span>` : '') +
            `</li>`
          )).join('')
        : '<li class="dg-empty">—</li>';
      return `<div class="dg-col"><span class="dg-h">${escapeHtml(c.heading)}</span><ul class="dg-list">${items}</ul></div>`;
    }).join('') + '</div>';
  }

  // Phase 2C — "Recent Communications" (Twilio deal inbox). Groups of active
  // texts/calls from the last 24h, plus a link to the unmatched-number review
  // queue. Hidden entirely when there's nothing recent AND nothing to review.
  function paintRecentComms(data) {
    const section = document.querySelector('[data-comms-section]');
    const grid    = document.querySelector('[data-comms-grid]');
    const link    = document.querySelector('[data-comms-review]');
    if (!section || !grid) return;
    const groups  = (data && data.recent_comms) || [];
    const pending = (data && data.review_pending_count) || 0;

    if (link) {
      if (pending > 0) {
        link.textContent = `${pending} unreviewed →`;
        link.style.display = '';
      } else {
        link.style.display = 'none';
      }
    }

    if (!groups.length && pending === 0) { section.style.display = 'none'; return; }
    section.style.display = '';

    if (!groups.length) {
      grid.innerHTML = emptyPanel('No new texts, calls, or emails in the last 24 hours.');
      return;
    }
    grid.innerHTML = groups.map((g) => {
      const summary = commsSummary(g);
      const clickable = g.contact_id ? ` data-comm-contact="${escapeHtml(g.contact_id)}" style="cursor:pointer;"` : '';
      return `
        <article class="deal"${clickable}>
          <div class="deal-h">
            <span class="deal-stage">${g.count} new</span>
            <span class="deal-amt" style="font-size:13px;">${escapeHtml(fmtRelative(g.last_at))}</span>
          </div>
          <h4>${escapeHtml(g.name)}</h4>
          <p class="deal-buyer">${escapeHtml(summary || 'Activity')} <span class="label-cap" style="font-size:9px;opacity:.6;">${escapeHtml(commsTag(g))}</span></p>
        </article>`;
    }).join('');

    grid.querySelectorAll('[data-comm-contact]').forEach((card) => {
      card.addEventListener('click', () => {
        if (typeof window.showView === 'function') window.showView(null, 'inbox');
        if (typeof selectLeadId === 'function') selectLeadId(card.getAttribute('data-comm-contact'), true);
      });
    });
  }

  // ===== RULE: every deal is its own BOLD, distinct colour ====================
  // One deal = one bold colour, everywhere, forever. The palette below is 12
  // high-chroma, well-separated hues, chosen so two deals never read as "the same
  // colour" at a glance. (The old palette was muted pastels — browns and greens
  // blurred together and you couldn't tell deals apart; that is exactly what this
  // rule forbids.) Slot = hash(source_key) with deterministic probing so ACTIVE
  // deals (escrow/offer) never collide. If you add colours, keep them BOLD and far
  // apart in hue — never reintroduce muted/pastel tones — and mirror the change in
  // DEAL_PALETTE (the calendar fallback) so the two stay identical.
  // Exposed as window.LegacyDealColors for every module + page.
  const LGC_DEAL_PALETTE = [
    { name: 'red',     border: '#D32F2F', bg: '#FADEDE' },
    { name: 'orange',  border: '#EF6C00', bg: '#FCE7D6' },
    { name: 'gold',    border: '#F9A825', bg: '#FDF1D3' },
    { name: 'green',   border: '#2E7D32', bg: '#DFEFE1' },
    { name: 'teal',    border: '#00838F', bg: '#D5ECEE' },
    { name: 'blue',    border: '#1565C0', bg: '#DBE8F6' },
    { name: 'indigo',  border: '#4527A0', bg: '#E4DFF2' },
    { name: 'purple',  border: '#8E24AA', bg: '#F1DFF5' },
    { name: 'magenta', border: '#C2185B', bg: '#F9DBE8' },
    { name: 'brown',   border: '#5D4037', bg: '#E8DED9' },
    { name: 'slate',   border: '#37474F', bg: '#DEE4E7' },
    { name: 'lime',    border: '#9E9D24', bg: '#EFEFCF' }
  ];
  function lgcDealHash(k) { let v = 0; for (let i = 0; i < k.length; i++) v = (v * 31 + k.charCodeAt(i)) % 997; return v % 12; }
  window.LegacyDealColors = (function () {
    let map = null, index = null, pending = null;
    function assign(list) {
      const taken = new Array(12).fill(false), m = {};
      const act  = list.filter((d) => d.active).sort((a, b) => (a.key < b.key ? -1 : 1));
      const rest = list.filter((d) => !d.active).sort((a, b) => (a.key < b.key ? -1 : 1));
      for (const d of act) {
        let slot = lgcDealHash(d.key), tries = 0;
        while (taken[slot] && tries < 12) { slot = (slot + 1) % 12; tries++; }
        taken[slot] = true; m[d.key] = LGC_DEAL_PALETTE[slot];
      }
      for (const d of rest) m[d.key] = LGC_DEAL_PALETTE[lgcDealHash(d.key)];
      return m;
    }
    function load() {
      if (pending) return pending;
      pending = fetch('/api/crm/listings', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const all = [].concat(j?.pending || [], j?.offers || [], j?.active || [], j?.preparing || [], j?.closed || []);
          index = all.filter((d) => d.source_key).map((d) => ({
            key: d.source_key,
            street: (d.address || '').split(',')[0].trim().toLowerCase(),
            active: d.stage === 'pending' || d.stage === 'offer'
          }));
          map = assign(index);
          document.dispatchEvent(new CustomEvent('lgc:dealcolors'));
          return map;
        }).catch(() => (map = {}));
      return pending;
    }
    return {
      ready: load,
      get(key) { if (!key) return null; if (map && map[key]) return map[key]; return LGC_DEAL_PALETTE[lgcDealHash(key)]; },
      match(text) {
        if (!index || !text) return null;
        const t = String(text).toLowerCase();
        for (const d of index) {
          if (d.key && t.includes(d.key.toLowerCase())) return { key: d.key, color: this.get(d.key) };
          if (d.street && d.street.length > 5 && t.includes(d.street)) return { key: d.key, color: this.get(d.key) };
        }
        return null;
      }
    };
  })();

  // Jump to the lead list pre-searched to a person's name (used by task badges,
  // day-list rows, anywhere a client name appears).
  window.openPeople = function (name) {
    if (typeof window.showView === 'function') window.showView(null, 'inbox');
    const box = document.querySelector('[data-global-search]');
    if (box && name) {
      box.value = name;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  // The day strip is now the WEEK AHEAD: today + the next 6 days from the real
  // calendar (tours, appointments, contingency deadlines, COEs), deal-colored.
  async function paintHours(items) {
    const body = document.querySelector('[data-hours-body]');
    if (!body) return;
    const now = new Date();
    const todayEl = document.querySelector('[data-hours-today]');
    if (todayEl) todayEl.textContent = `Next 7 days`;
    const nowEl = body.querySelector('[data-hours-now]');
    Array.from(body.querySelectorAll('.hr-row, .hr-day')).forEach((r) => r.remove());
    let days = [], events = [];
    try {
      const r = await api('/api/crm/calendar?week=0&span=2', { method: 'GET' });
      if (r.ok && Array.isArray(r.json.days)) { days = r.json.days; events = r.json.events || []; }
    } catch (_) {}
    if (window.LegacyDealColors) { try { await window.LegacyDealColors.ready(); } catch (_) {} }
    const todayKey = days.find((d) => d.is_today)?.date || now.toISOString().slice(0, 10);
    const week = days.filter((d) => d.date >= todayKey).slice(0, 7);
    const byDate = {};
    events.forEach((ev) => { (byDate[ev.date] = byDate[ev.date] || []).push(ev); });
    const totalAhead = week.reduce((n, d) => n + (byDate[d.date] || []).length, 0);
    if (nowEl) nowEl.innerHTML = `<span class="hr-now-l">Now · ${escapeHtml(now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span><span class="hr-now-d">${totalAhead ? totalAhead + ' scheduled this week' : 'Clear week so far'}</span>`;
    week.forEach((d) => {
      const evs = byDate[d.date] || [];
      if (!evs.length && !d.is_today) return;   // skip empty future days, keep today
      const head = document.createElement('div');
      head.className = 'hr-day';
      head.style.cssText = 'font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:' + (d.is_today ? 'var(--brass)' : 'var(--ink-mute)') + ';padding:10px 2px 2px;';
      head.textContent = (d.is_today ? 'Today · ' : '') + d.dow + ' ' + d.num;
      body.appendChild(head);
      if (!evs.length) {
        const empt = document.createElement('div');
        empt.className = 'hr-row';
        empt.innerHTML = '<span class="hr-time"></span><div class="hr-card hr-card-soft"><span class="hr-sub">Nothing scheduled today.</span></div>';
        body.appendChild(empt);
        return;
      }
      evs.slice(0, 4).forEach((ev) => {
        const c = ev.deal_key && window.LegacyDealColors ? window.LegacyDealColors.get(ev.deal_key) : null;
        const row = document.createElement('div');
        row.className = 'hr-row';
        row.innerHTML = `
          <span class="hr-time">${escapeHtml(ev.time_label || (ev.all_day ? 'All day' : ''))}</span>
          <div class="hr-card${ev.type === 'deadline' || ev.type === 'coe' ? ' hr-card-brass' : ''}" style="${c ? `border-left:4px solid ${c.border};` : ''}${ev.client ? 'cursor:pointer;' : ''}" ${ev.client ? `data-open-person="${escapeHtml(ev.client)}" title="Open ${escapeHtml(ev.client)}"` : ''}>
            <span class="label-cap">${escapeHtml(ev.type || 'event')}</span>
            <strong>${escapeHtml(ev.title || '')}</strong>
            ${ev.client || ev.location ? `<span class="hr-sub">${escapeHtml([ev.client, ev.location].filter(Boolean).join(' · '))}</span>` : ''}
          </div>`;
        body.appendChild(row);
      });
      if (evs.length > 4) {
        const more = document.createElement('div');
        more.className = 'hr-row';
        more.innerHTML = `<span class="hr-time"></span><div class="hr-card hr-card-soft"><span class="hr-sub">+${evs.length - 4} more — open the calendar</span></div>`;
        body.appendChild(more);
      }
    });
  }

  // Deadline Watch — one ranked, day-counted list of the next contingency/COE
  // deadlines across every active deal (the briefing's Deadline Watch, live).
  async function paintDeadlineWatch() {
    const sec = document.querySelector('[data-deadline-watch]');
    const list = document.querySelector('[data-dw-list]');
    if (!sec || !list) return;
    let rows = [];
    try {
      const r = await api('/api/crm/deadlines', { method: 'GET' });
      if (r.ok && Array.isArray(r.json.deadlines)) rows = r.json.deadlines;
    } catch (_) {}
    if (!rows.length) { sec.style.display = 'none'; return; }
    if (window.LegacyDealColors) { try { await window.LegacyDealColors.ready(); } catch (_) {} }
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmtD = (s) => { if (!s) return ''; return `${MO[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}`; };
    const shown = rows.slice(0, 12);
    list.innerHTML = shown.map((d) => {
      const c = d.deal && window.LegacyDealColors ? window.LegacyDealColors.get(d.deal) : null;
      const dd = d.days;
      const cnt = d.overdue ? `${Math.abs(dd)}d late` : (dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : `${dd} days`);
      const urg = d.overdue ? 'over' : (dd <= 2 ? 'soon' : (dd <= 7 ? 'wk' : ''));
      const agentTag = d.agent && d.agent !== 'sara' ? ` · ${d.agent}` : '';
      const sub = [d.address, d.client].filter(Boolean).join(' · ') + agentTag;
      return `<div class="dw-row${d.type === 'coe' ? ' coe' : ''}"${c ? ` style="border-left-color:${c.border};"` : ''}${d.client ? ` data-open-person="${escapeHtml(d.client)}" style="cursor:pointer;${c ? `border-left-color:${c.border};` : ''}"` : ''}>
        <span class="dw-days ${urg}">${escapeHtml(cnt)}</span>
        <span class="dw-main"><strong>${escapeHtml(d.label)}</strong><span class="dw-sub">${escapeHtml(sub)}</span></span>
        <span class="dw-date">${escapeHtml(fmtD(d.date))}${d.weekend ? ' ⚠' : ''}</span>
      </div>`;
    }).join('');
    const more = rows.length > shown.length ? `<div class="dw-more">+${rows.length - shown.length} more on the calendar</div>` : '';
    if (more) list.insertAdjacentHTML('beforeend', more);
    sec.style.display = '';
  }

  function paintReportsFunnel(funnel) {
    const container = document.querySelector('[data-funnel]');
    const sub       = document.querySelector('[data-funnel-sub]');
    if (!container) return;
    if (!funnel) {
      container.innerHTML = emptyPanel('Funnel will appear once 90 days of lead data have accumulated.');
      if (sub) sub.textContent = '— leads in · — closes out';
      return;
    }
    const steps = [
      { key: 'new_leads', label: 'New leads',   brass: false },
      { key: 'engaged',   label: 'Engaged',     brass: false },
      { key: 'toured',    label: 'Toured',      brass: false },
      { key: 'offered',   label: 'Made offer',  brass: true  },
      { key: 'closed',    label: 'Closed',      brass: true  }
    ];
    const top = Math.max(1, funnel.new_leads || 0);
    container.innerHTML = steps.map((s) => {
      const v = funnel[s.key] || 0;
      const pct = Math.max(0, Math.min(100, Math.round((v / top) * 100)));
      return `<div class="funnel-step"><span class="l">${escapeHtml(s.label)}</span><div class="b" style="width:${pct}%;${s.brass ? 'background:var(--brass);' : ''}"></div><span class="v">${v}</span></div>`;
    }).join('');
    if (sub) sub.textContent = `${funnel.new_leads || 0} leads in · ${funnel.closed || 0} closes out`;
  }

  // ---------------------------------------------------------------------------
  // Phase 1J — Today-foot panels, Pipeline header, Reports KPIs / chart / closings
  // Driven by GET /api/crm/metrics
  // ---------------------------------------------------------------------------
  function fmtUSDshort(n) {
    if (!n || n < 1000) return '$' + (n || 0);
    if (n < 1000000)    return '$' + Math.round(n / 1000) + 'K';
    return '$' + (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  }

  let lastMetrics = null;
  function paintCrmMetrics(m) {
    lastMetrics = m;
    paintDayList(m.day_list || [], m.day_total_min || 0);
    paintDayStats(m.yesterday || {});
    paintPipelineHeader(m.pipeline || {});
    paintClosedChart(m.closed_by_month || []);
    paintRecentClosings(m.recent_closings || []);
    paintRepKpi(m.rep_kpi || {});
  }

  // Reports → Export: download the closings + KPI summary as a CSV.
  function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportReportsCsv() {
    const m = lastMetrics || {};
    const rows = [];
    rows.push(['Recent closings']);
    rows.push(['Date', 'Property', 'Side', 'Sale price']);
    (m.recent_closings || []).forEach((r) => rows.push([r.date, r.address, r.side, r.price]));
    rows.push([]);
    const k = m.rep_kpi || {};
    rows.push(['KPIs']);
    rows.push(['Closed volume (trailing 12 mo)', k.trailing_12_vol]);
    rows.push(['Transactions (trailing 12 mo)', k.trailing_12_count]);
    rows.push(['Total closed to date', k.total_closed]);
    rows.push(['Average sale price', k.avg_sale_price]);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'legacy-reports.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-report-export]')) { e.preventDefault(); exportReportsCsv(); }
  });

  // The day list is recomputed fresh from live signals on every load (drafts
  // awaiting approval, dark leads, today's tours, new leads) — there's no stable
  // server-side id, so a check-off is persisted LOCALLY for the day (dayOffKey):
  // it stays crossed off across refreshes today, and the list is fresh tomorrow.
  // If the underlying signal is still live tomorrow the item returns — that
  // mirrors reality — but ticking it no longer "un-does" itself on refresh.
  function paintDayList(items, totalMin) {
    const ul = document.querySelector('[data-day-list]');
    if (!ul) return;
    if (!items.length) {
      ul.innerHTML = `<li style="opacity:.55;font-style:italic;padding:14px 0;">Quiet day list. No drafts, no radio silence, no new leads in the last 24 hours.</li>`;
    } else {
      ul.innerHTML = items.map((t) => {
        const key = dayOffKey(t.title);
        const off = lgIsDismissed(key);
        return `<li data-tk-min="${parseInt(t.time) || 0}" data-tk-key="${escapeHtml(key)}"${off ? ' class="done"' : ''}><input type="checkbox" class="tk-box" data-tk-check title="Cross off for today"${off ? ' checked' : ''}><span class="tk-body"><strong>${escapeHtml(t.title)}</strong>${t.sub ? ' · ' + escapeHtml(t.sub) : ''}</span><span class="tk-time">${escapeHtml(t.time || '')}</span></li>`;
      }).join('');
    }
    renderDayTotal();
  }

  function renderDayTotal() {
    const foot = document.querySelector('[data-day-total]');
    const ul = document.querySelector('[data-day-list]');
    if (!foot) return;
    const rows = ul ? Array.from(ul.querySelectorAll('li[data-tk-min]')) : [];
    if (!rows.length) { foot.innerHTML = `<strong>0 min</strong> · inbox is clear`; return; }
    const remaining = rows.filter((li) => !li.classList.contains('done'))
      .reduce((s, li) => s + (parseInt(li.getAttribute('data-tk-min')) || 0), 0);
    if (!remaining) { foot.innerHTML = `<strong>All crossed off</strong> · nice work`; return; }
    const done = new Date(Date.now() + remaining * 60000);
    const hh = done.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    foot.innerHTML = `<strong>${remaining} min</strong> · if you start now, done by ${hh}`;
  }
  document.addEventListener('change', (e) => {
    const box = e.target.closest('[data-tk-check]');
    if (!box) return;
    const li = box.closest('li');
    if (li) {
      li.classList.toggle('done', box.checked);
      const key = li.getAttribute('data-tk-key');
      if (key) { box.checked ? lgDismiss(key) : lgUndismiss(key); }   // persist for the day
      renderDayTotal();
    }
  });

  function paintDayStats(y) {
    const grid = document.querySelector('[data-day-stats]');
    if (!grid) return;
    const cells = [
      [y.emails_sent      || 0,                                    'Emails sent'],
      [`${y.drafts_total  || 0}`,                                  `AI drafts · ${y.drafts_approved || 0} approved`],
      [y.showings_led     || 0,                                    'Showings led'],
      [y.new_leads        || 0,                                    'New leads'],
      [fmtUSDshort(y.pipeline_added || 0),                         'Pipeline added'],
      [`${y.inbox_pct ?? 0}<em>%</em>`,                            'Inbox handled']
    ];
    grid.innerHTML = cells.map(([num, lab]) => `
      <div class="ds-cell"><span class="ds-num">${num}</span><span class="ds-lab">${escapeHtml(lab)}</span></div>`).join('');
  }

  function paintPipelineHeader(p) {
    const inflight = document.querySelector('[data-bind-pipe-inflight]');
    // total in-flight $ is painted by paintKanban; we own month / week / rate.
    const month = document.querySelector('[data-bind-pipe-month]');
    if (month) month.textContent = fmtUSDshort(p.expected_month || 0);
    const week = document.querySelector('[data-bind-pipe-week]');
    if (week)  week.textContent  = String(p.closing_week || 0);
    const rate = document.querySelector('[data-bind-pipe-rate]');
    if (rate)  rate.textContent  = `${p.tour_to_offer_pct || 0}%`;
  }

  function paintClosedChart(months) {
    const bars = document.querySelector('[data-closed-chart]');
    const labels = document.querySelector('[data-closed-chart-labels]');
    if (!bars || !labels || !months.length) return;
    const peak = Math.max(1, ...months.map((m) => m.amount));
    bars.innerHTML = months.map((m) => {
      const pct = Math.max(4, Math.round((m.amount / peak) * 100));
      const brass = m.amount >= peak * 0.7 && !m.current;
      const opacity = m.current ? 0.5 : 1;
      return `<div class="chart-bar${brass ? ' brass' : ''}" style="height:${pct}%;${m.current ? 'opacity:0.5;' : ''}" data-v="${fmtUSDshort(m.amount)}${m.current ? '*' : ''}"></div>`;
    }).join('');
    labels.innerHTML = months.map((m) => `<span>${escapeHtml(m.label)}${m.current ? '*' : ''}</span>`).join('');
  }

  function paintRecentClosings(rows) {
    const box = document.querySelector('[data-recent-closings]');
    const sub = document.querySelector('[data-closings-sub]');
    const foot = document.querySelector('[data-closings-foot]');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = `<div style="padding:24px;opacity:.55;font-style:italic;font-size:14px;">No closed deals yet. As leads move into the Close stage they'll appear here.</div>`;
      if (sub) sub.textContent = 'No closings yet';
      if (foot) foot.textContent = '';
      return;
    }
    box.innerHTML = rows.map((r) => `
      <div class="income-row">
        <span class="name">${escapeHtml(r.date)}</span>
        <span class="home">${escapeHtml(r.address)}</span>
        <span class="v" style="font-family: var(--mono); font-size: 11px; font-style: normal; letter-spacing: 0.12em; color: var(--ink-mute); text-transform: uppercase;">${escapeHtml(r.side)}</span>
        <span class="v brass">${escapeHtml(fmtUSDshort(r.price))}</span>
      </div>`).join('');
    if (sub) sub.textContent = `Last ${rows.length} transaction${rows.length === 1 ? '' : 's'}`;
    if (foot) foot.textContent = '';
  }

  function paintRepKpi(k) {
    const v = document.querySelector('[data-kpi-volume]');
    if (v) v.textContent = fmtUSDshort(k.trailing_12_vol || 0);
    const vs = document.querySelector('[data-kpi-volume-sub]');
    if (vs) vs.textContent = `${k.trailing_12_count || 0} transaction${k.trailing_12_count === 1 ? '' : 's'}`;
    const t = document.querySelector('[data-kpi-total]');
    if (t) t.textContent = String(k.total_closed || 0);
    const a = document.querySelector('[data-kpi-avg]');
    if (a) a.textContent = fmtUSDshort(k.avg_sale_price || 0);
  }

  function paintMorningBrief(data, session) {
    // 1. Date label
    const now = new Date();
    const dateLabel = now.toLocaleString(undefined, {
      weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit'
    });
    const labelEl = $('.today-brief .label-cap');
    if (labelEl) labelEl.textContent = `${dateLabel} brief`;
    const briefDateEl = document.querySelector('[data-bind-brief-date]');
    if (briefDateEl) briefDateEl.textContent = `${dateLabel} brief`;

    // 2. Greeting — personalise to the signed-in agent
    const name = (session?.profile?.display_name || '').split(' ')[0] || 'Sara';
    const greet = $('.tb-greet');
    if (greet) greet.innerHTML = `Good morning, <em>${escapeHtml(name)}.</em>`;

    // 3. Narrative
    const line = $('.tb-line');
    if (line) {
      if (data.narrative) {
        line.textContent = data.narrative;
      } else {
        const n = data.drafts?.length || 0;
        line.textContent = n
          ? `${n} draft${n === 1 ? '' : 's'} want your eyes before they go out.`
          : 'No drafts in the queue. Quiet morning.';
      }
    }

    // 3b. At-a-glance assessment — replaces the old hardcoded market/weather
    // widgets with live numbers from the brief. Only real counts, no fabrication.
    const assessEl = document.querySelector('[data-bind-assessment]');
    if (assessEl) {
      // "Closing soon" is now a money summary only — the per-deal COE/countdown
      // list moved to the Deals-in-motion table below (one home for deadlines).
      // Here we keep what the table doesn't total: expected commission this month
      // and over the next 60 days, plus the single next deal to close as a hook.
      const escrow = (data.active_deals || []).filter((d) => d.in_escrow).sort((a, b) => String(a.coe_date || '9999').localeCompare(String(b.coe_date || '9999')));
      const fmtCoe = (iso) => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'TBD';
      const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
      const now = new Date(); const eom = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      let totalMonth = 0, total60 = 0;
      escrow.forEach((d) => {
        if (d.commission_usd == null || !d.coe_date) return;
        const coe = new Date(d.coe_date);
        if (coe < eom) totalMonth += d.commission_usd;
        if (coe.getTime() - now.getTime() < 60 * 86400000) total60 += d.commission_usd;
      });
      // One row per deal in escrow (sorted by COE), each with its countdown, so
      // every live transaction is named here — not just the nearest. Full
      // deadlines/contingencies still live in the Deals-in-motion table below.
      const whenFor = (d) => {
        const dtc = d.days_to_coe;
        return dtc == null ? fmtCoe(d.coe_date)
          : dtc < 0 ? `${Math.abs(dtc)}d late`
          : dtc === 0 ? 'closes today'
          : `${dtc} day${dtc === 1 ? '' : 's'}`;
      };
      const withCoe = escrow.filter((d) => d.coe_date);
      const nextRow = withCoe.slice(0, 6).map((d, i) => `
        <div class="tb-pulse-row tb-esc" data-open-deal="${escapeHtml(d.lead_id || '')}" style="cursor:pointer;" title="Open this deal">
          <span>${i === 0 ? 'Next to close' : ''}</span>
          <span class="v">${escapeHtml((d.address || d.lead_id || '').split(',')[0])} · ${escapeHtml(whenFor(d))}</span></div>`).join('');
      assessEl.innerHTML = `
        <div class="tb-pulse">
          <span class="label-cap">Closing soon · ${escrow.length} in escrow</span>
          ${nextRow || '<div class="tb-pulse-row"><span>Nothing in escrow right now.</span><span class="v"></span></div>'}
          <div class="tb-pulse-row" style="border-top:1px solid var(--rule);margin-top:8px;padding-top:8px;font-weight:600;"><span>Expected this month</span><span class="v">${money(totalMonth)}</span></div>
          <div class="tb-pulse-row" style="font-weight:600;"><span>Next 60 days</span><span class="v">${money(total60)}</span></div>
          <div class="tb-pulse-row" style="opacity:.6;font-size:11.5px;"><span>Every deadline &amp; contingency is in the deals table below ↓</span><span class="v"></span></div>
        </div>`;
    }

    // 4. Sidebar + tab badge counts (only present on crm.html)
    if (data.roster) {
      const r = data.roster;
      const setAll = (selector, value) => {
        if (value == null) return; // never print "undefined" over a pill
        document.querySelectorAll(selector).forEach((el) => { el.textContent = String(value); });
      };
      setAll('[data-roster-today]',        r.today_count);
      setAll('[data-roster-inbox]',        r.inbox_count);
      setAll('[data-roster-calendar]',     r.calendar_week);
      setAll('[data-roster-calendar-week]', r.calendar_week);
      setAll('[data-roster-pipeline]',     r.pipeline_count);
      // NOTE: the roster segment pills (Leads / Clients / Past / Sphere) are
      // owned SOLELY by the People-roster loader (crm.html), which counts each
      // bucket the same way it lists it (crm-roster.js classify()). Writing them
      // here from the morning-brief's differently-defined counts made the pills
      // change the moment the roster loaded — so we leave them alone.
      // NOTE: the Active/Pending listing pills are owned by the Listings loader
      // (crm.html), which counts the deals table directly. Metrics must not
      // overwrite them — it was clobbering the real count (9) back to 0.
    }
  }

  function paintQuietAsks(drafts, opts = {}) {
    const needs = $('.needs');
    if (!needs) return;

    if (!opts.embedded) {
      const eyebrow = needs.querySelector('.eyebrow');
      if (eyebrow) eyebrow.textContent = drafts.length
        ? `Needs you · ${drafts.length} draft${drafts.length === 1 ? '' : 's'} awaiting approval`
        : 'Needs you · inbox at zero';
      const h2 = needs.querySelector('.h-section');
      if (h2) h2.textContent = drafts.length
        ? (drafts.length === 1 ? 'One quiet ask.' : `${drafts.length} quiet ask${drafts.length === 1 ? '' : 's'}.`)
        : 'Nothing pending.';
      needs.querySelectorAll('.need-card').forEach(el => el.remove());
    }

    if (drafts.length === 0 && opts.embedded && !opts.queueEmpty) return;
    if (drafts.length === 0) {
      const empty = document.createElement('article');
      empty.className = 'need-card';
      // Include the .nc-rank cell — without it the lone .nc-body lands in the
      // 56px rank column of the card's 2-col grid and the text wraps one word
      // per line.
      empty.innerHTML = `<div class="nc-rank">✓</div><div class="nc-body"><p style="opacity:.7;font-style:italic;">All drafts approved. ${escapeHtml(agentFirst)}, take the morning off.</p></div>`;
      needs.appendChild(empty);
      return;
    }

    // Render one .need-card per draft, preserving existing CSS classes
    drafts.forEach((m, idx) => {
      const lead = m.leads || {};
      const rank = String(idx + 1).padStart(2, '0');
      const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || 'Lead';
      const tempPill = ({
        hot:  '<span class="pill-status pill-hot">Hot</span>',
        warm: '<span class="pill-status pill-warm">Warm</span>',
        cold: '<span class="pill-status pill-brass">Cold</span>',
        new:  '<span class="pill-status pill-brass">New</span>'
      })[lead.temperature] || '';

      const subjectLine = m.channel === 'email' && m.subject
        ? `<h3>${escapeHtml(fullName)} — ${escapeHtml(m.subject)}</h3>`
        : `<h3>${escapeHtml(fullName)} — ${m.channel === 'sms' ? 'SMS draft' : 'Email draft'}</h3>`;

      const card = document.createElement('article');
      card.className = idx === 0 && lead.temperature === 'hot' ? 'need-card q-app need-card-hot' : 'need-card q-app';
      card.setAttribute('data-message-id', m.id);
      card.innerHTML = `
        <div class="nc-rank">${rank}</div>
        <div class="nc-body">
          <div class="nc-meta">
            ${tempPill}
            <span class="nc-tag">${m.channel === 'sms' ? 'SMS' : 'Email'} draft · awaiting your approval · ${escapeHtml(fmtRelative(m.created_at))}</span>
          </div>
          ${subjectLine}
          <p data-draft-body style="white-space:pre-wrap;">${escapeHtml(m.body || '')}</p>
          ${m.ai_draft_reasoning ? `<p style="font-size:12px;color:var(--ink-mute,#7C6A4D);font-style:italic;margin-top:6px;">AI angle: ${escapeHtml(m.ai_draft_reasoning)}</p>` : ''}
          <div class="nc-foot">
            <div class="nc-foot-l"><span>${escapeHtml(lead.email || '')} · ${(lead.lead_type || 'buyer')} · score ${lead.score ?? 0}</span></div>
            <div class="nc-foot-r">
              <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
              <button class="btn btn-ink btn-sm" data-action="approve">Approve &amp; send</button>
            </div>
          </div>
          <div data-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
        </div>`;
      needs.appendChild(card);

      // Wire buttons
      const editBtn    = card.querySelector('[data-action="edit"]');
      const approveBtn = card.querySelector('[data-action="approve"]');
      const bodyEl     = card.querySelector('[data-draft-body]');
      const resultEl   = card.querySelector('[data-result]');

      let editedBody = null;
      editBtn.addEventListener('click', () => {
        if (bodyEl.querySelector('textarea')) return; // already editing
        const ta = document.createElement('textarea');
        ta.value = m.body || '';
        ta.style.cssText = 'width:100%;min-height:120px;padding:10px;border:1px solid #D9CFB7;background:#fff;font:inherit;font-size:14px;line-height:1.55;';
        bodyEl.innerHTML = '';
        bodyEl.appendChild(ta);
        editedBody = ta;
        editBtn.textContent = 'Done editing';
      });

      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        approveBtn.textContent = 'Sending…';
        resultEl.textContent = '';
        const body = {
          message_id:    m.id,
          edited_body:   editedBody ? editedBody.value : undefined,
          edited_subject: undefined
        };
        const r = await api('/api/crm/approve', { body });
        if (r.ok && r.json?.status === 'sent') {
          const via = r.json.provider?.via
            ? r.json.provider.via.replace(/^(.)/, c => c.toUpperCase())
            : (m.channel === 'sms' ? 'Twilio' : 'email');
          resultEl.style.color = '#2E5C3D';
          resultEl.textContent = `✓ Sent via ${via}.`;
          approveBtn.textContent = 'Sent';
          card.style.opacity = '0.55';
        } else {
          resultEl.style.color = '#9B2C2C';
          resultEl.textContent = r.json?.error || 'Send failed.';
          approveBtn.disabled = false;
          approveBtn.textContent = 'Approve & send';
        }
      });
    });
  }

  function paintPipelineStats(data) {
    // Total pipeline value shown if there's an obvious target element.
    // The prototype uses .ds-num for big numbers — we update the second one
    // (which displays "$X.XM in pipeline" in the prototype) if present.
    const valueNodes = $$('.ds-num');
    const target = valueNodes.find(n => /\$[\d.]+M/.test(n.textContent || ''));
    if (target && data.total_estimated_value) {
      target.textContent = fmtUSD(data.total_estimated_value);
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    const path = location.pathname;

    if (path === '/' || /\/index\.html$/.test(path)) wireHomepage();
    wireFindMyMatch(); // every page
    wireListingsPage();
    wireListingDetailPage();

    if (/\/crm\.html$/.test(path)) {
      const session = await gate(['agent_sara','agent_james','admin']);
      if (session) await wireCrmPage(session);
    }
    if (/\/dashboard\.html$/.test(path)) await gate(['buyer','agent_sara','agent_james','admin']);
    if (window.LGPortal.isPath()) {
      // Private-link access (?t=<portal_token>, or /buyer|/seller/<token>) needs
      // no login — the token is the credential. The public sample portal needs
      // no login either. Only gate when there's neither a token nor sample mode.
      const hasToken = window.LGPortal.token();
      if (!hasToken && !window.LGPortal.isSample()) await gate(['seller','agent_sara','agent_james','admin']);
    }
  });

  // expose for debugging
  // openLead(id): jump to the inbox and load that contact's detail by id — used
  // by the People roster so clicking a person opens THAT person (not a name
  // search that lands on whoever was last open). Works for any contact, incl.
  // archived/closed clients, because selectLeadId→loadLead fetches by id.
  window.Legacy = {
    api, openModal, submitLead, toast,
    openLead: function (id) {
      if (!id) return;
      if (typeof window.showView === 'function') window.showView(null, 'inbox');
      if (typeof selectLeadId === 'function') selectLeadId(id, true);
    }
  };
})();

/* ===========================================================================
 * Phase 1E — Buyer dashboard live data (APPEND-ONLY)
 * ---------------------------------------------------------------------------
 * Self-contained module. Does NOT touch the IIFE above, its auth logic, or any
 * CRM paint function. It runs only on dashboard.html, fetches the buyer's own
 * dashboard payload, and paints it over the existing markup using the
 * data-* hook contract added to dashboard.html.
 *
 * Endpoint expected (to be built by the backend team): GET /api/me/dashboard
 * Returns the signed-in buyer's own data only (server derives identity from
 * the session cookie — no id is sent from the client).
 *
 * Hook contract (see dashboard.html):
 *   [data-bind="path"]        textContent (or <img> src) from dotted path
 *   [data-bind-href="path"]   sets href
 *   [data-toggle="path"]      toggles `.on` class from a boolean
 *   [data-sign]               on a [data-bind] cell: adds .up / .dn by +/- sign
 *   [data-optional]           hides the element when its value is empty
 *   [data-list="key"]         array container; clones its [data-row] per item
 *   [data-row]                the template row inside a list
 *   [data-after-rows]         rows are inserted before this element (footers)
 *   [data-state="loading"|"empty"]  placeholder shown by the painter
 * ======================================================================== */
(function () {
  'use strict';
  if (!/\/dashboard\.html$/.test(location.pathname)) return;

  const tplStore = new WeakMap();

  const dget = (obj, path) =>
    String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const isEmpty = (v) =>
    v == null || v === '' || (Array.isArray(v) && v.length === 0);

  function bindEl(el, val) {
    if (el.hasAttribute('data-optional')) {
      if (isEmpty(val)) { el.style.display = 'none'; return; }
      el.style.display = '';
    }
    if (el.tagName === 'IMG') { if (val != null) el.src = val; return; }
    if (val != null) el.textContent = val;
    if (el.hasAttribute('data-sign')) {
      const neg = String(val).trim().charAt(0) === '-';
      el.classList.toggle('up', !neg);
      el.classList.toggle('dn', neg);
    }
  }

  function setState(container, name, show) {
    const el = container.querySelector(':scope > [data-state="' + name + '"]');
    if (el) el.style.display = show ? '' : 'none';
  }

  // Fill one cloned row from a single item (also handles nested tag lists).
  function fillRow(row, item) {
    row.querySelectorAll('[data-bind]').forEach((el) => {
      if (el.closest('[data-list]')) return;        // nested list handled below
      bindEl(el, dget(item, el.getAttribute('data-bind')));
    });
    row.querySelectorAll('[data-bind-href]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      const v = dget(item, el.getAttribute('data-bind-href'));
      if (v != null) el.setAttribute('href', v);
    });
    // Generic attribute binding: data-bind-attr="attr:path[,attr2:path2]".
    row.querySelectorAll('[data-bind-attr]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      (el.getAttribute('data-bind-attr') || '').split(',').forEach((pair) => {
        const i = pair.indexOf(':'); if (i < 0) return;
        const attr = pair.slice(0, i).trim();
        const v = dget(item, pair.slice(i + 1).trim());
        if (attr && v != null) el.setAttribute(attr, v);
      });
    });
    row.querySelectorAll('[data-toggle]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      el.classList.toggle('on', !!dget(item, el.getAttribute('data-toggle')));
    });
    row.querySelectorAll('[data-list]').forEach((c) => {
      const sub = dget(item, c.getAttribute('data-list'));
      if (isEmpty(sub) && c.hasAttribute('data-optional')) { c.style.display = 'none'; return; }
      c.style.display = '';
      paintList(c, sub || []);
    });
  }

  // Replace a list container's rows with one cloned [data-row] per array item.
  function paintList(container, arr) {
    if (!container) return;
    let tpl = tplStore.get(container);
    if (!tpl) {
      const orig = container.querySelector(':scope > [data-row]');
      if (!orig) return;
      tpl = orig.cloneNode(true);
      tpl.removeAttribute('data-row');
      tplStore.set(container, tpl);
    }
    const tag = tpl.tagName;
    const cls = tpl.classList[0] || null;
    // Remove existing rows (prototype mock rows + previously painted clones),
    // but keep the header, state placeholders and the [data-after-rows] footer.
    Array.from(container.children).forEach((ch) => {
      if (ch.hasAttribute('data-state')) return;
      if (ch.hasAttribute('data-after-rows')) return;
      if (ch.classList && ch.classList.contains('dash-card-h')) return;
      const isRow = ch.tagName === tag && (cls ? ch.classList.contains(cls) : ch.className === tpl.className);
      if (isRow || ch.hasAttribute('data-row') || ch.hasAttribute('data-painted')) ch.remove();
    });

    setState(container, 'loading', false);
    if (isEmpty(arr)) { setState(container, 'empty', true); return; }
    setState(container, 'empty', false);

    const anchor = container.querySelector(':scope > [data-after-rows]');
    arr.forEach((item) => {
      const row = tpl.cloneNode(true);
      row.setAttribute('data-painted', '');
      row.style.display = '';
      fillRow(row, item);
      if (anchor) container.insertBefore(row, anchor);
      else container.appendChild(row);
    });
  }

  // Top-level scalar binds (identity, greeting, stats, brief, digest, nav).
  function paintScalars(data) {
    document.querySelectorAll('[data-bind]').forEach((el) => {
      if (el.closest('[data-row]') || el.closest('[data-painted]') || el.closest('[data-list]')) return;
      bindEl(el, dget(data, el.getAttribute('data-bind')));
    });
    document.querySelectorAll('[data-bind-href]').forEach((el) => {
      if (el.closest('[data-row]') || el.closest('[data-painted]') || el.closest('[data-list]')) return;
      const v = dget(data, el.getAttribute('data-bind-href'));
      if (v != null) el.setAttribute('href', v);
    });
  }

  function topLevelLists() {
    return Array.from(document.querySelectorAll('[data-list]')).filter(
      (c) => !c.closest('[data-row]') && !c.closest('[data-painted]') &&
             !(c.parentElement && c.parentElement.closest('[data-list]'))
    );
  }

  function rowSig(tpl) {
    return { tag: tpl.tagName, cls: tpl.classList[0] || null, className: tpl.className };
  }

  // Hide mock rows + show spinners while the request is in flight.
  function enterLoading(lists) {
    lists.forEach((c) => {
      const orig = c.querySelector(':scope > [data-row]');
      if (!orig) return;
      const sig = rowSig(orig);
      Array.from(c.children).forEach((ch) => {
        const isRow = ch.tagName === sig.tag && (sig.cls ? ch.classList.contains(sig.cls) : ch.className === sig.className);
        if (isRow || ch.hasAttribute('data-row')) ch.style.display = 'none';
      });
      setState(c, 'loading', true);
    });
  }

  // Restore the prototype view if the request fails (e.g. offline preview).
  function exitLoading(lists) {
    lists.forEach((c) => {
      const orig = c.querySelector(':scope > [data-row]');
      if (orig) {
        const sig = rowSig(orig);
        Array.from(c.children).forEach((ch) => {
          const isRow = ch.tagName === sig.tag && (sig.cls ? ch.classList.contains(sig.cls) : ch.className === sig.className);
          if (isRow || ch.hasAttribute('data-row')) ch.style.display = '';
        });
      }
      setState(c, 'loading', false);
    });
  }

  function paintDashboard(data) {
    if (!data || typeof data !== 'object') return;
    paintScalars(data);
    topLevelLists().forEach((c) => {
      const arr = dget(data, c.getAttribute('data-list'));
      if (arr === undefined) { exitLoading([c]); return; } // section not supplied → keep mock
      // Sections flagged data-optional collapse entirely when their list is
      // empty (e.g. the "From your agent" card for buyers not yet in a deal).
      if (c.hasAttribute('data-optional')) c.style.display = (Array.isArray(arr) && arr.length) ? '' : 'none';
      paintList(c, arr);
    });
  }

  // Clear scalar [data-bind] text so prototype copy (e.g. "Renee Dawson") is
  // never visible before the real payload arrives. Lists are hidden by
  // enterLoading(), which swaps in the [data-state="loading"] placeholders.
  function clearScalars() {
    document.querySelectorAll('[data-bind]').forEach((el) => {
      if (el.closest('[data-row]') || el.closest('[data-painted]') || el.closest('[data-list]')) return;
      if (el.tagName === 'IMG') return;
      el.textContent = '';
    });
  }

  async function loadDashboard() {
    const lists = topLevelLists();
    // Hide the prototype mock immediately and show the [data-state="loading"]
    // placeholders so the buyer never sees "Renee" before her own data arrives.
    enterLoading(lists);
    clearScalars();
    let res;
    try {
      res = await fetch('/api/me/dashboard', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
    } catch (_) {
      exitLoading(lists); return;
    }
    if (!res.ok) { exitLoading(lists); return; }   // 401 (gate handles sign-in) / 404
    let json = null;
    try { json = await res.json(); } catch (_) { exitLoading(lists); return; }
    paintDashboard(json && json.dashboard ? json.dashboard : json);
  }

  document.addEventListener('DOMContentLoaded', loadDashboard);
})();


/* ===========================================================================
 * Phase 1F — Seller portal live data (APPEND-ONLY)
 * ---------------------------------------------------------------------------
 * Self-contained module. Runs only on seller.html. Fetches the signed-in
 * seller's portal payload from GET /api/seller/portal and paints it over
 * the existing markup using the same data-* hook contract as the buyer
 * dashboard. If the current seller.html has no data-bind attributes yet,
 * the payload is still fetched and exposed on window.__legacySellerPortal
 * for debugging — the painter is a safe no-op until Claude Design adds
 * the data-* hooks to the page.
 *
 * Hook contract (identical to the buyer dashboard module):
 *   [data-bind="path"]        textContent (or <img> src) from dotted path
 *   [data-bind-href="path"]   sets href
 *   [data-bind-class="path"]  sets className (replaces, useful for status pills)
 *   [data-add-class="path"]   appends classes from a string value
 *   [data-bind-style="prop:path"]   sets a CSS style property
 *   [data-toggle="path"]      toggles `.on` class from a boolean
 *   [data-optional]           hides the element when its value is empty
 *   [data-list="key"]         array container; clones its [data-row] per item
 *   [data-row]                the template row inside a list
 *   [data-html="path"]        innerHTML from dotted path (escaped server-side)
 * ======================================================================== */
(function () {
  'use strict';
  if (!window.LGPortal.isPath()) return;   // /seller.html or /buyer|/seller/<token>

  const tplStore = new WeakMap();

  const dget = (obj, path) =>
    String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const isEmpty = (v) =>
    v == null || v === '' || (Array.isArray(v) && v.length === 0);

  function bindEl(el, val) {
    if (el.hasAttribute('data-optional')) {
      if (isEmpty(val)) { el.style.display = 'none'; return; }
      el.style.display = '';
    }
    if (el.tagName === 'IMG') { if (val != null) el.src = val; return; }
    if (val != null) el.textContent = val;
  }

  function applyExtraBindings(root, item) {
    root.querySelectorAll('[data-html]').forEach((el) => {
      if (el.closest('[data-list]') && el !== root) return;
      const v = dget(item, el.getAttribute('data-html'));
      if (v != null) el.innerHTML = String(v);
    });
    root.querySelectorAll('[data-bind-class]').forEach((el) => {
      if (el.closest('[data-list]') && el !== root) return;
      const v = dget(item, el.getAttribute('data-bind-class'));
      if (v != null) el.className = String(v);
    });
    root.querySelectorAll('[data-add-class]').forEach((el) => {
      if (el.closest('[data-list]') && el !== root) return;
      const v = dget(item, el.getAttribute('data-add-class'));
      if (v) String(v).split(/\s+/).forEach((c) => c && el.classList.add(c));
    });
    root.querySelectorAll('[data-bind-style]').forEach((el) => {
      if (el.closest('[data-list]') && el !== root) return;
      const spec = el.getAttribute('data-bind-style') || '';
      const [prop, path] = spec.split(':').map((s) => s.trim());
      if (!prop || !path) return;
      const v = dget(item, path);
      if (v != null) el.style.setProperty(prop, String(v));
    });
  }

  function fillRow(row, item) {
    row.querySelectorAll('[data-bind]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      bindEl(el, dget(item, el.getAttribute('data-bind')));
    });
    row.querySelectorAll('[data-bind-href]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      const v = dget(item, el.getAttribute('data-bind-href'));
      if (v != null) el.setAttribute('href', v);
    });
    // Generic attribute binding: data-bind-attr="attr:path[,attr2:path2]".
    row.querySelectorAll('[data-bind-attr]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      (el.getAttribute('data-bind-attr') || '').split(',').forEach((pair) => {
        const i = pair.indexOf(':'); if (i < 0) return;
        const attr = pair.slice(0, i).trim();
        const v = dget(item, pair.slice(i + 1).trim());
        if (attr && v != null) el.setAttribute(attr, v);
      });
    });
    row.querySelectorAll('[data-toggle]').forEach((el) => {
      if (el.closest('[data-list]')) return;
      el.classList.toggle('on', !!dget(item, el.getAttribute('data-toggle')));
    });
    applyExtraBindings(row, item);
    row.querySelectorAll('[data-list]').forEach((c) => {
      const sub = dget(item, c.getAttribute('data-list'));
      if (isEmpty(sub) && c.hasAttribute('data-optional')) { c.style.display = 'none'; return; }
      c.style.display = '';
      paintList(c, sub || []);
    });
  }

  function paintList(container, arr) {
    if (!container) return;
    let tpl = tplStore.get(container);
    if (!tpl) {
      const orig = container.querySelector(':scope > [data-row]');
      if (!orig) return;
      tpl = orig.cloneNode(true);
      tpl.removeAttribute('data-row');
      tplStore.set(container, tpl);
    }
    const tag = tpl.tagName;
    const cls = tpl.classList[0] || null;
    Array.from(container.children).forEach((ch) => {
      const isRow = ch.tagName === tag && (cls ? ch.classList.contains(cls) : ch.className === tpl.className);
      if (isRow || ch.hasAttribute('data-row') || ch.hasAttribute('data-painted')) ch.remove();
    });
    if (isEmpty(arr)) return;
    arr.forEach((item) => {
      const row = tpl.cloneNode(true);
      row.setAttribute('data-painted', '');
      row.style.display = '';
      fillRow(row, item);
      container.appendChild(row);
    });
  }

  function paintScalars(data) {
    document.querySelectorAll('[data-bind]').forEach((el) => {
      if (el.closest('[data-row]') || el.closest('[data-painted]') || el.closest('[data-list]')) return;
      bindEl(el, dget(data, el.getAttribute('data-bind')));
    });
    document.querySelectorAll('[data-bind-href]').forEach((el) => {
      if (el.closest('[data-row]') || el.closest('[data-painted]') || el.closest('[data-list]')) return;
      const v = dget(data, el.getAttribute('data-bind-href'));
      if (v != null) el.setAttribute('href', v);
    });
    applyExtraBindings(document, data);
  }

  function topLevelLists() {
    return Array.from(document.querySelectorAll('[data-list]')).filter(
      (c) => !c.closest('[data-row]') && !c.closest('[data-painted]') &&
             !(c.parentElement && c.parentElement.closest('[data-list]'))
    );
  }

  function paintPortal(data) {
    if (!data || typeof data !== 'object') return;
    paintScalars(data);
    topLevelLists().forEach((c) => {
      const arr = dget(data, c.getAttribute('data-list'));
      if (arr === undefined) return;
      // Optional list sections collapse entirely when empty (mirrors
      // paintDashboard). Without this a section carrying static header/label
      // text — e.g. the agent-only "Completed / Only you see this…" list —
      // would render its shell to a real client even with zero rows, leaking
      // agent-facing copy. The server already sends tasks_done:[] to a client,
      // so this reliably hides it there while keeping it in the agent preview.
      if (c.hasAttribute('data-optional')) c.style.display = (Array.isArray(arr) && arr.length) ? '' : 'none';
      paintList(c, arr);
    });
  }

  // Reveal the portal only once it's painted — the page ships with seller-framed
  // placeholder text, so showing it before the (side-aware) payload paints would
  // flash "Your home"/"Sara" to a buyer. A cover hides everything until ready.
  function revealPortal() {
    const pl = document.getElementById('portal-loading');
    if (!pl) return;
    pl.style.transition = 'opacity .18s ease';
    pl.style.opacity = '0';
    setTimeout(() => { if (pl && pl.parentNode) pl.parentNode.removeChild(pl); }, 200);
  }

  async function loadSeller() {
    // Safety: never let the cover hang if the fetch stalls or the gate redirects.
    setTimeout(revealPortal, 6000);
    let res;
    const params = new URLSearchParams(location.search);
    const token = window.LGPortal.token();   // ?t= or /buyer|/seller/<token>
    const deal  = params.get('deal');   // agent preview of a specific deal
    // "View as seller" (?as=seller|client) must ride along on the ?deal= preview,
    // or this main painter fetches the AGENT view while the inline hero script
    // (which does forward it) fetches the client view — the two disagree and the
    // preview shows agent-only extras (Completed list, private note, tickable
    // tasks) that the real /seller/<token> link never shows. A real client token
    // (?t=) is already the client, so `as` only matters on the ?deal= path.
    const asClient = /^(seller|client)$/i.test(params.get('as') || '');
    let url = '/api/seller/portal';
    if (window.LGPortal.isSample()) url += '?sample=1';
    else if (token) url += '?t=' + encodeURIComponent(token);
    else if (deal)  url += '?deal=' + encodeURIComponent(deal) + (asClient ? '&as=seller' : '');
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
    } catch (_) { revealPortal(); return; }
    if (!res.ok) { revealPortal(); return; }   // 401 → gate handles sign-in
    let json = null;
    try { json = await res.json(); } catch (_) { revealPortal(); return; }
    const portal = json && json.portal ? json.portal : json;
    window.__legacySellerPortal = portal;
    paintPortal(portal);
    revealPortal();
  }

  document.addEventListener('DOMContentLoaded', loadSeller);
})();

/* ===========================================================================
 * Phase 1D+ — CRM lead list, lead detail, lead profile, pipeline kanban
 * ---------------------------------------------------------------------------
 * Scoped to crm.html only. Sits next to the existing wireCrmPage() (which
 * paints the Today view). This block paints the Inbox view (lead list +
 * lead detail + lead profile) and the Pipeline view (kanban).
 *
 * READ endpoints used (all exist today):
 *   GET /api/crm/pipeline             — every active lead grouped by stage
 *   GET /api/crm/inbox?filter=all     — newest messages joined with leads
 *                                       (used for lead-list preview text)
 *   GET /api/crm/lead?id=<uuid>       — full picture for the selected lead
 *
 * WRITE endpoints intentionally NOT wired (no backend yet — reported to user):
 *   - PATCH /api/crm/lead    (kanban drag, Reassign, pipeline-stage move)
 *   - POST  /api/crm/message (composer Send button)
 *   - POST  /api/crm/note    (Note tab, Internal tab)
 *   - POST  /api/ai/regenerate (Regenerate AI draft)
 *   - DELETE /api/crm/message/:id (Discard AI draft)
 * ======================================================================== */
(function () {
  'use strict';
  if (!/\/crm\.html$/.test(location.pathname)) return;

  function escHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // Minimal transient toast (bottom-right).
  function toast(msg, ok) {
    let t = document.getElementById('leg-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'leg-toast';
      t.style.cssText = 'position:fixed;bottom:22px;right:22px;z-index:99999;max-width:360px;padding:12px 16px;background:#1A1714;color:#FAF6EC;font-family:Manrope,system-ui,sans-serif;font-size:13.5px;line-height:1.45;box-shadow:0 10px 30px rgba(20,18,15,.3);opacity:0;transition:opacity .2s;';
      document.body.appendChild(t);
    }
    t.style.borderLeft = '3px solid ' + (ok === false ? '#9B2C2C' : '#2E5C3D');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, 3200);
  }
  if (window.Legacy) window.Legacy.toast = toast;   // share the toast with other modules (calendar)
  function initialsOf(first, last, fallback) {
    const a = (first || '').trim()[0] || '';
    const b = (last  || '').trim()[0] || '';
    return (a + b).toUpperCase() || (fallback || '?').trim()[0]?.toUpperCase() || '?';
  }
  function fullName(lead) {
    return [lead && lead.first_name, lead && lead.last_name].filter(Boolean).join(' ')
      || (lead && lead.email) || 'Lead';
  }

  // "Set a reminder" — a small modal on a contact's card that books a follow-up
  // or call for THIS contact on the calendar (and the agent's subscribed .ics
  // feed) without leaving the page. POSTs to the same /api/crm/calendar endpoint
  // the Calendar view uses; the event is internal (never shared to the client).
  function openReminderModal(lead) {
    if (document.querySelector('[data-reminder-modal]')) return; // one at a time
    const name = fullName(lead);
    // Local date/time helpers — the API reads date (YYYY-MM-DD) + time (HH:MM)
    // as Pacific wall-clock, which matches the agent's own clock.
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const atHour = (daysAhead, hour) => { const d = new Date(); d.setDate(d.getDate() + daysAhead); d.setHours(hour, 0, 0, 0); return d; };
    const nextMonday9 = () => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return d; };
    const def = atHour(1, 9); // default: tomorrow 9 AM

    const wrap = document.createElement('div');
    wrap.setAttribute('data-reminder-modal', '1');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(26,23,20,.45);display:flex;align-items:center;justify-content:center;padding:20px;';
    wrap.innerHTML = `
      <div role="dialog" aria-label="Set a reminder" style="background:#FAF6EC;color:#1A1714;width:100%;max-width:440px;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden;font-family:system-ui,sans-serif;">
        <div style="padding:16px 20px;border-bottom:1px solid #E7DCC4;display:flex;align-items:center;justify-content:space-between;">
          <b style="font-size:15px;">Set a reminder</b>
          <button type="button" data-rm-x style="background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:#8A7B60;">×</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px;">
          <div style="font-size:13px;color:#6B5F49;">For <b>${escHtml(name)}</b>${lead.phone ? ' · ' + escHtml(lead.phone) : ''}</div>
          <div style="display:flex;gap:8px;">
            <button type="button" data-rm-kind="follow_up" class="rm-kind" style="flex:1;">Follow up</button>
            <button type="button" data-rm-kind="call" class="rm-kind" style="flex:1;">Call</button>
          </div>
          <label style="font-size:12px;font-weight:600;color:#6B5F49;">Reminder
            <input data-rm-title type="text" value="Follow up with ${escHtml(name)}" style="width:100%;margin-top:5px;border:1px solid #D9CFB7;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px;background:#fff;">
          </label>
          <div>
            <div style="font-size:12px;font-weight:600;color:#6B5F49;margin-bottom:5px;">When</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
              <button type="button" data-rm-when="tom" style="font-size:12px;border:1px solid #D9CFB7;border-radius:14px;padding:5px 11px;background:#fff;cursor:pointer;">Tomorrow 9 AM</button>
              <button type="button" data-rm-when="d3" style="font-size:12px;border:1px solid #D9CFB7;border-radius:14px;padding:5px 11px;background:#fff;cursor:pointer;">In 3 days</button>
              <button type="button" data-rm-when="mon" style="font-size:12px;border:1px solid #D9CFB7;border-radius:14px;padding:5px 11px;background:#fff;cursor:pointer;">Next Monday</button>
            </div>
            <div style="display:flex;gap:8px;">
              <input data-rm-date type="date" value="${ymd(def)}" style="flex:2;border:1px solid #D9CFB7;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px;background:#fff;">
              <input data-rm-time type="time" value="09:00" style="flex:1;border:1px solid #D9CFB7;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px;background:#fff;">
            </div>
          </div>
          <div data-rm-status style="font-size:12.5px;min-height:16px;color:#8A3B2B;"></div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid #E7DCC4;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" data-rm-cancel class="btn btn-ghost btn-sm">Cancel</button>
          <button type="button" data-rm-save class="btn btn-ink btn-sm">Set reminder</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const q = (s) => wrap.querySelector(s);
    let kind = 'follow_up';
    const paintKind = () => wrap.querySelectorAll('[data-rm-kind]').forEach((b) => {
      const on = b.getAttribute('data-rm-kind') === kind;
      b.style.cssText = `flex:1;border-radius:8px;padding:9px;font:inherit;font-size:13px;cursor:pointer;border:1px solid ${on ? '#1A1714' : '#D9CFB7'};background:${on ? '#1A1714' : '#fff'};color:${on ? '#FAF6EC' : '#1A1714'};font-weight:600;`;
    });
    paintKind();
    wrap.querySelectorAll('[data-rm-kind]').forEach((b) => b.addEventListener('click', () => {
      kind = b.getAttribute('data-rm-kind');
      const t = q('[data-rm-title]');
      // Keep the title in step with the type unless the agent has customised it.
      if (t && (t.value === `Follow up with ${name}` || t.value === `Call ${name}`)) {
        t.value = kind === 'call' ? `Call ${name}` : `Follow up with ${name}`;
      }
      paintKind();
    }));
    const setWhen = (d) => { q('[data-rm-date]').value = ymd(d); q('[data-rm-time]').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    q('[data-rm-when="tom"]').addEventListener('click', () => setWhen(atHour(1, 9)));
    q('[data-rm-when="d3"]').addEventListener('click', () => setWhen(atHour(3, 9)));
    q('[data-rm-when="mon"]').addEventListener('click', () => setWhen(nextMonday9()));

    const close = () => wrap.remove();
    q('[data-rm-x]').addEventListener('click', close);
    q('[data-rm-cancel]').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

    q('[data-rm-save]').addEventListener('click', async () => {
      const date = q('[data-rm-date]').value;
      const time = q('[data-rm-time]').value;
      const title = (q('[data-rm-title]').value || '').trim() || (kind === 'call' ? `Call ${name}` : `Follow up with ${name}`);
      const status = q('[data-rm-status]');
      if (!date || !time) { status.textContent = 'Pick a date and time.'; return; }
      const saveBtn = q('[data-rm-save]');
      saveBtn.disabled = true; saveBtn.textContent = 'Setting…'; status.style.color = '#8A7B60'; status.textContent = '';
      const r = await window.Legacy.api('/api/crm/calendar', {
        method: 'POST',
        body: { kind, title, date, time, duration_minutes: 30, lead_id: lead.id, email: lead.email || '', notes: `Reminder set from ${name}'s contact card.` }
      });
      if (r.ok && r.json && (r.json.appointment || r.json.source)) {
        close();
        const when = new Date(date + 'T' + time);
        const nice = isNaN(when) ? `${date} ${time}` : when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        toast(`Reminder set for ${nice} — it's on your calendar.`, true);
      } else {
        saveBtn.disabled = false; saveBtn.textContent = 'Set reminder';
        status.style.color = '#8A3B2B';
        status.textContent = (r.json && r.json.error) || 'Could not set the reminder — try again.';
      }
    });

    setTimeout(() => { const t = q('[data-rm-title]'); if (t) t.focus(); }, 60);
  }
  function fmtUSD(n) {
    if (n == null || !Number.isFinite(+n)) return '—';
    const v = Math.abs(+n);
    if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
    if (v >= 1_000)     return `$${Math.round(+n / 1_000)}K`;
    return `$${Math.round(+n)}`;
  }
  function fmtRel(iso) {
    if (!iso) return '';
    const m = (Date.now() - new Date(iso).getTime()) / 60000;
    if (m < 1)    return 'just now';
    if (m < 60)   return `${Math.round(m)} min`;
    if (m < 1440) return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const d = Math.round(m / 1440);
    if (d < 7)    return `${d}d`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function tempBadge(temperature) {
    if (temperature === 'hot')  return '<span class="badge hot">● Hot</span>';
    if (temperature === 'warm') return '<span class="badge warm">● Warm</span>';
    if (temperature === 'cold') return '<span class="badge">● Cold</span>';
    return '<span class="badge">● New</span>';
  }
  function tempPill(temperature) {
    if (temperature === 'hot')  return 'pill-hot';
    if (temperature === 'warm') return 'pill-warm';
    if (temperature === 'cold') return 'pill-cold';
    return '';
  }
  function leadTypeLabel(lead) {
    if (lead.lead_type === 'seller') return 'Seller';
    if (lead.lead_type === 'buyer')  return (lead.areas && lead.areas[0]) ? `${lead.areas[0]} buyer` : 'Buyer';
    if (lead.lead_type === 'land')   return 'Land · James';
    return (lead.lead_type || 'lead').replace(/^./, (c) => c.toUpperCase());
  }
  // Pipeline-status pill for a roster row — the SAME stage the contact card
  // header shows (pipeline_stage is derived from the side stages server-side,
  // so this stays in sync when you change a contact's status). Legacy stage
  // keys are normalized first.
  const PIPE_STATUS_LABEL = {
    new: 'New', nurture: 'Nurture', consult: 'Consult', signed: 'Signed',
    active: 'Active', under_contract: 'In Escrow', closed: 'Closed', sphere: 'Sphere'
  };
  function statusBadge(lead) {
    const stage = STAGE_NORM[lead.pipeline_stage] || lead.pipeline_stage || 'new';
    const label = PIPE_STATUS_LABEL[stage] || 'New';
    return `<span class="badge st st-${escHtml(stage)}">${escHtml(label)}</span>`;
  }
  function avatarClassFor(temperature) {
    if (temperature === 'hot')  return 'avatar avatar-sm hot';
    if (temperature === 'warm') return 'avatar avatar-sm warm';
    return 'avatar avatar-sm';
  }

  // The brokerage's agents. Comms surfaces (brief, drafts, sent bubbles,
  // "Send as X") reference these instead of a hardcoded Sara — the Today brief
  // follows whoever is signed in; a lead's drafts/messages follow the agent who
  // owns that lead.
  const AGENTS = {
    sara:  { key: 'sara',  first: 'Sara',  full: 'Sara Cooper',      initials: 'SC', headshot: 'art/sara-headshot.png' },
    james: { key: 'james', first: 'James', full: 'James Beyersdorf', initials: 'JB', headshot: 'art/james-headshot.png' }
  };
  function agentInfo(key) { return AGENTS[key] || AGENTS.sara; }

  const state = {
    leads: [],
    leadsById: new Map(),
    messageByLead: new Map(),
    activeFilter: 'all',
    segment: 'all',      // roster segment: all | clients | past | sphere
    search: '',          // topbar global search over leads
    selectedLeadId: null
  };

  function matchSearch(l, q) {
    const hay = [l.first_name, l.last_name, l.email, l.phone, (l.areas && l.areas[0])]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  // Roster segments over pipeline_stage (legacy keys normalized).
  const STAGE_NORM = { touring: 'active', offer: 'under_contract', close: 'closed' };
  const SEGMENTS = {
    all:     () => true,
    clients: (s) => ['signed', 'active', 'under_contract'].includes(s),
    past:    (s) => s === 'closed',
    sphere:  (s) => s === 'sphere'
  };
  const SEGMENT_LABEL = { all: 'leads', clients: 'clients', past: 'past clients', sphere: 'sphere' };

  function filterLeads() {
    // Topbar search is a global override — matches across everyone, ignoring
    // the current segment / chip.
    const q = (state.search || '').trim().toLowerCase();
    if (q) return state.leads.filter((l) => matchSearch(l, q));
    const segFn = SEGMENTS[state.segment] || SEGMENTS.all;
    let leads = state.leads.filter((l) => segFn(STAGE_NORM[l.pipeline_stage] || l.pipeline_stage));
    const f = state.activeFilter;
    if (f === 'all') return leads;
    if (f === 'awaiting_reply') {
      return leads.filter((l) => {
        const m = state.messageByLead.get(l.id);
        return m && m.direction === 'inbound';
      });
    }
    return leads.filter((l) => l.temperature === f);
  }

  function paintLeadCounts() {
    // Only the inbox/pipeline temperature chips (all/hot/warm/new) live here.
    const counts = { all: state.leads.length, hot: 0, warm: 0, new: 0, cold: 0 };
    state.leads.forEach((l) => {
      if (counts[l.temperature] != null) counts[l.temperature]++;
    });
    document.querySelectorAll('[data-count]').forEach((el) => {
      const k = el.getAttribute('data-count');
      if (counts[k] != null) el.textContent = String(counts[k]);
    });
    // NOTE: the roster sidebar pills (Leads / Clients / Past / Sphere) are NOT
    // written here. They're owned by the People-roster loader (crm.html), which
    // counts each bucket the same way it lists it (crm-roster.js classify()).
    // This function's pipeline-based segment counts used a different definition,
    // so writing them here made the pills change as soon as the roster loaded.
  }

  // One rendered lead row.
  function leadRowHtml(l) {
    const msg = state.messageByLead.get(l.id);
    const preview = msg
      ? (msg.subject ? `<strong>${escHtml(msg.subject)}</strong> — ` : '') + escHtml((msg.body || '').slice(0, 140))
      : (l.areas && l.areas[0] ? `Browsing ${escHtml(l.areas[0])}` : '<em>No conversation yet</em>');
    const when = msg ? fmtRel(msg.created_at) : fmtRel(l.updated_at);
    const isActive = l.id === state.selectedLeadId;
    const initials = initialsOf(l.first_name, l.last_name, l.email);
    return `
      <div class="lead-row ${isActive ? 'on' : ''}" data-lead-id="${escHtml(l.id)}">
        <div class="${avatarClassFor(l.temperature)}">${escHtml(initials)}</div>
        <div class="lead-content">
          <div class="lead-name-row">
            <span class="lead-name">${escHtml(fullName(l))}</span>
            <span class="lead-when">${escHtml(when)}</span>
          </div>
          <p class="lead-preview">${preview}</p>
          <div class="lead-meta">
            ${statusBadge(l)}
            ${tempBadge(l.temperature)}
            ${(l.lead_type === 'buyer' || l.lead_type === 'seller' || l.lead_type === 'land') ? `<span class="badge">${escHtml(leadTypeLabel(l))}</span>` : ''}
            <span class="score">${l.score == null ? '—' : l.score}</span>
          </div>
        </div>
        <button class="lead-del" type="button" data-lead-del="${escHtml(l.id)}" title="Delete contact permanently" aria-label="Delete contact">🗑</button>
      </div>`;
  }

  const LEAD_PAGE = 50;   // render 50 rows at a time; infinite-scroll the rest

  // Append the next page of already-filtered leads to the list.
  function appendLeadRows(container) {
    const leads = state._leadView || [];
    const start = state._leadShown || 0;
    const slice = leads.slice(start, start + LEAD_PAGE);
    if (!slice.length) return;
    container.insertAdjacentHTML('beforeend', slice.map(leadRowHtml).join(''));
    state._leadShown = start + slice.length;
  }

  // Wire delegated click + infinite scroll on the list container (once).
  function wireLeadList(container) {
    if (container._wired) return;
    container._wired = true;
    container.addEventListener('click', (e) => {
      const del = e.target.closest('[data-lead-del]');
      if (del) {
        e.stopPropagation();
        const row = del.closest('[data-lead-id]');
        const nameEl = row && row.querySelector('.lead-name');
        deleteLeadFlow(del.getAttribute('data-lead-del'), nameEl ? nameEl.textContent : '');
        return;
      }
      const row = e.target.closest('[data-lead-id]');
      if (row) selectLeadId(row.getAttribute('data-lead-id'));
    });
    container.addEventListener('scroll', () => {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 240) {
        appendLeadRows(container);   // near the bottom → load the next 50
      }
    });
  }

  // Segment-browse mode: clicking a roster eyebrow (Leads / Clients / Past /
  // Sphere) opens a search-first pane rather than dumping every contact. The
  // list stays empty until Sara types, then shows matches she can open.
  function renderSegmentBrowse(container) {
    const segLeads = filterLeads();   // segment + chip, no global search (state.search is empty here)
    const segName  = SEGMENT_LABEL[state.segment] || 'contacts';
    container.innerHTML = `
      <div class="lead-seg">
        <input type="text" class="lead-seg-input" data-roster-search placeholder="Search ${escHtml(segName)} by name, email, area…" value="${escHtml(state.rosterSearch || '')}" autocomplete="off">
        <div class="lead-seg-hint">${segLeads.length} ${escHtml(segName)} · type a name to open one</div>
      </div>
      <div class="lead-seg-results" data-roster-results></div>`;
    wireLeadList(container);
    renderSegmentResults(container);
    const inp = container.querySelector('[data-roster-search]');
    if (inp) { const v = inp.value; inp.focus(); inp.setSelectionRange(v.length, v.length); }
  }
  // Only the results sub-list re-renders on each keystroke, so the search input
  // keeps focus and the caret doesn't jump.
  function renderSegmentResults(container) {
    const results = container.querySelector('[data-roster-results]');
    if (!results) return;
    const q = (state.rosterSearch || '').trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }
    const matches = filterLeads().filter((l) => matchSearch(l, q));
    results.innerHTML = matches.length
      ? matches.slice(0, 50).map(leadRowHtml).join('')
      : `<div class="lead-row" style="opacity:.55;"><div class="lead-content"><div class="lead-name-row"><span class="lead-name" style="font-style:italic;">No match for “${escHtml(state.rosterSearch)}.”</span></div></div></div>`;
  }

  function paintLeadList() {
    const container = document.querySelector('[data-lead-list]');
    if (!container) return;
    // Eyebrow-driven browse → search-first (unless a global topbar search is active).
    if (state.segmentBrowse && !(state.search || '').trim()) {
      renderSegmentBrowse(container);
      return;
    }
    // Filtering/search still resolve the full set; only the RENDER is paged, so
    // a 2,000-lead roster no longer paints 2,000 DOM rows at once (the INP hit).
    const leads = filterLeads();
    state._leadView = leads;
    state._leadShown = 0;
    if (!leads.length) {
      container.innerHTML = `<div class="lead-row" style="opacity:.55;"><div class="lead-content"><div class="lead-name-row"><span class="lead-name" style="font-style:italic;">No leads in this filter yet.</span></div></div></div>`;
      return;
    }
    container.innerHTML = '';
    container.scrollTop = 0;
    appendLeadRows(container);
    wireLeadList(container);
  }

  function paintFilters() {
    document.querySelectorAll('[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.activeFilter = chip.getAttribute('data-filter');
        document.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('on', c === chip));
        paintLeadList();
      });
    });
  }

  // Close any open contact-action menu on an outside click (registered once).
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-detail-action="actions-menu"]') || e.target.closest('[data-actions-menu]')) return;
    document.querySelectorAll('[data-actions-menu]').forEach((m) => { m.style.display = 'none'; });
  });

  // Topbar global search — jump to the Inbox and filter leads by the query.
  document.addEventListener('input', (e) => {
    const box = e.target.closest('[data-global-search]');
    if (!box) return;
    state.search = box.value || '';
    if (state.search.trim()) { state.segmentBrowse = false; if (typeof window.showView === 'function') window.showView(null, 'inbox'); }
    paintLeadList();
    const first = filterLeads()[0];
    if (first) selectLeadId(first.id, true);
  });

  // In-pane roster search (segment-browse mode) — filter within the segment and
  // only re-render the results sub-list so the input keeps focus.
  document.addEventListener('input', (e) => {
    const box = e.target.closest('[data-roster-search]');
    if (!box) return;
    state.rosterSearch = box.value || '';
    const container = document.querySelector('[data-lead-list]');
    if (container) renderSegmentResults(container);
  });

  // Roster sidebar segments (Leads / Clients / Past clients / Sphere) — re-filter
  // the lead list even when already on the Inbox view, so clicking between them
  // actually changes what's shown.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-roster-nav]');
    if (!link) return;
    state.segment = link.getAttribute('data-roster-nav') || 'all';
    state.activeFilter = 'all';
    // Search-first: show a search box for this segment instead of listing
    // everyone. Clear any prior query and topbar search so the pane starts fresh.
    state.segmentBrowse = true;
    state.rosterSearch  = '';
    state.search        = '';
    // Deselect — otherwise clicking the contact that was already open would
    // early-return in selectLeadId and never replace this pane's prompt.
    state.selectedLeadId = null;
    document.querySelectorAll('[data-global-search]').forEach((b) => { b.value = ''; });
    document.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('on', c.getAttribute('data-filter') === 'all'));
    paintLeadList();
    // Don't auto-open a contact — Sara picks one from the search results.
    const detailEl = document.querySelector('[data-lead-detail]');
    const segLeads = filterLeads();
    if (detailEl) detailEl.innerHTML = segLeads.length
      ? `<div style="padding:32px;opacity:.55;font-style:italic;">Search ${escHtml(SEGMENT_LABEL[state.segment] || 'contacts')} on the left, then pick a contact to open it here.</div>`
      : `<div style="padding:32px;opacity:.55;font-style:italic;">No contacts in this group yet.</div>`;
  });

  function paintLeadDetail(payload) {
    const detailEl  = document.querySelector('[data-lead-detail]');
    const profileEl = document.querySelector('[data-lead-profile]');
    if (!detailEl || !profileEl) return;
    if (!payload || !payload.lead) {
      detailEl.innerHTML = `<div style="padding:24px;opacity:.55;">Lead not found.</div>`;
      profileEl.innerHTML = '';
      return;
    }
    const lead = payload.lead;
    const messages = payload.messages || [];
    const events   = payload.events || [];
    const saved    = payload.saved_properties || [];
    const tours    = payload.tours || [];
    const offers   = payload.offers || [];
    const tasks    = payload.tasks || [];
    const appts    = payload.appointments || [];
    const collections = payload.collections || [];
    const deals    = payload.deals || [];
    const related  = payload.related || [];

    const initials = initialsOf(lead.first_name, lead.last_name, lead.email);
    // Comms on this lead speak as the agent who owns it (assigned_agent), so a
    // James lead never shows Sara's name/headshot and vice-versa.
    const leadAgent = agentInfo(lead.assigned_agent);
    const daysInPipeline = lead.created_at
      ? Math.max(0, Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000))
      : 0;
    const SIDE_LABEL = { buyer: 'Buyer', seller: 'Seller', both: 'Dual · both sides' };
    const metaBits = [
      (lead.areas && lead.areas[0]) || null,
      `${daysInPipeline} days in pipeline`,
      lead.temperature ? lead.temperature.replace(/^./, (c) => c.toUpperCase()) : null,
      `Score ${lead.score == null ? '—' : lead.score}`
    ].filter(Boolean);

    // Header pills — side + side-aware status. A dual (buyer+seller) client
    // shows a pill pair per side. Status comes from buyer_stage/seller_stage;
    // a category (Past Client / Sphere / Do Not Contact) shows as one pill.
    const STAGE_PILL = { new: 'New', nurture: 'Nurturing', consult: 'Consult', signed: 'Signed', active: 'Active', under_contract: 'In Escrow', closed: 'Closed', sphere: 'Sphere' };
    const BUYER_STAGE_LABEL  = { new: 'New', nurture: 'Nurture', showing_homes: 'Showing Homes', writing_offers: 'Writing Offers', in_escrow: 'In Escrow', closed: 'Closed' };
    const SELLER_STAGE_LABEL = { new: 'New', nurture: 'Nurture', preparing: 'Preparing to List', on_market: 'On Market', reviewing_offers: 'Reviewing Offers', in_escrow: 'In Escrow', closed: 'Closed' };
    const CATEGORY_LABEL     = { past_client: 'Past Client', sphere: 'Sphere', do_not_contact: 'Do Not Contact' };
    const side = lead.contact_type || lead.deal_side || '';
    const pill = (cls, label) => `<span class="lp-hpill ${cls}">${escHtml(label)}</span>`;
    let headPills = '';
    if (side === 'buyer' || side === 'both') headPills += pill('side', 'Buyer') + (lead.buyer_stage ? pill('stage', BUYER_STAGE_LABEL[lead.buyer_stage] || lead.buyer_stage) : '');
    if (side === 'seller' || side === 'both') headPills += pill('side', 'Seller') + (lead.seller_stage ? pill('stage', SELLER_STAGE_LABEL[lead.seller_stage] || lead.seller_stage) : '');
    if (CATEGORY_LABEL[side]) headPills += pill('side', CATEGORY_LABEL[side]);
    if (!headPills) headPills = pill('stage', STAGE_PILL[lead.pipeline_stage] || 'New');

    // Contact card + "Update contact" editor: name/phone/email + Side + the
    // side-aware status dropdown(s). Buyer/Seller show one; Dual shows both.
    const optTags = (map, cur) => '<option value="">— set —</option>' + Object.keys(map).map((k) => `<option value="${k}"${cur === k ? ' selected' : ''}>${escHtml(map[k])}</option>`).join('');
    const showBuy  = (side === 'buyer' || side === 'both');
    const showSell = (side === 'seller' || side === 'both');
    const fld = 'font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--rule);background:#fff;color:var(--ink);';
    const cap = 'font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute);min-width:72px;';
    // The deal(s) this contact is a party to. A live deal shows its stage + COE;
    // a closed one flips to "Closed · <date>" with a green rail. Links to the
    // deal page. This is what tells the agent "this contact is in the Baldwin
    // deal" — the payoff of linking them.
    const DEAL_STAGE_LABEL = { pending: 'In escrow', offer: 'Offer out', listing: 'On market', preparing: 'Preparing to list', closed: 'Closed', dead: 'Fell through', inactive: 'Inactive', dispute: 'In dispute', 'buyer-prospect': 'Prospect' };
    const fmtDealDate = (s) => { if (!s) return ''; const dd = new Date(s); if (isNaN(dd)) return ''; const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${MO[dd.getUTCMonth()]} ${dd.getUTCDate()}`; };
    const dealsHtml = deals.length ? `
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;max-width:540px;">
        ${deals.map((dl) => {
          const closed = dl.stage === 'closed';
          const roleLabel = (dl.roles && dl.roles[0]) ? dl.roles[0].replace(/^./, (c) => c.toUpperCase()) : '';
          const statusLabel = DEAL_STAGE_LABEL[dl.stage] || dl.stage || '';
          const dateLabel = dl.coe_date ? (closed ? `Closed ${fmtDealDate(dl.coe_date)}` : `COE ${fmtDealDate(dl.coe_date)}`) : (closed ? 'Closed' : '');
          // For a closed deal the date label already reads "Closed <date>", so
          // don't also show the standalone "Closed" status — avoids "Closed · Closed".
          const meta = (closed ? [roleLabel, dateLabel || 'Closed'] : [roleLabel, statusLabel, dateLabel]).filter(Boolean).map(escHtml).join(' · ');
          const url = `/seller.html?deal=${encodeURIComponent(dl.source_key)}`;
          return `<a href="${url}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;text-decoration:none;background:var(--shell);border:1px solid var(--rule);border-left:4px solid ${closed ? '#2E5C3D' : 'var(--brass)'};padding:9px 12px;color:var(--ink);">
            <span aria-hidden="true" style="font-size:15px;">🏡</span>
            <span style="flex:1;min-width:0;">
              <span style="font-weight:600;font-size:13.5px;">${escHtml(dl.address || dl.source_key)}</span>
              ${meta ? `<span style="display:block;font-size:11.5px;color:var(--ink-mute);">${meta}</span>` : ''}
            </span>
            <span style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--brass);white-space:nowrap;">Deal ↗</span>
          </a>`;
        }).join('')}
      </div>` : '';

    const contactEditorHtml = `
      <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink-soft);">
        ${lead.phone ? `<span>📞 ${escHtml(lead.phone)}</span>` : ''}
        ${lead.email ? `<span>✉ ${escHtml(lead.email)}</span>` : ''}
        <button class="btn-link lp-editlink" data-detail-action="edit-consent" style="font-size:12px;background:none;border:none;cursor:pointer;padding:0;color:var(--brass);">Update contact</button>
      </div>
      ${dealsHtml}
      ${related.length ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;max-width:540px;">
        <span style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);">Related</span>
        ${related.map((r) => {
          const on = r.include_on_comms !== false;
          const nm = escHtml([r.first_name, r.last_name].filter(Boolean).join(' ') || 'Contact');
          // Two controls in one chip: the name opens their card, the trailing
          // pill flips whether they ride along on outreach to this contact.
          return `<span class="lp-related-chip" style="background:var(--shell);border:1px solid var(--rule);border-radius:14px;padding:2px 3px 2px 11px;font-size:12.5px;color:var(--ink);display:inline-flex;gap:6px;align-items:center;">
            <button type="button" data-open-related="${escHtml(r.id)}" style="background:none;border:none;padding:0;cursor:pointer;font:inherit;color:inherit;display:inline-flex;gap:6px;align-items:center;">${nm}<span style="color:var(--ink-mute);font-size:11px;">${escHtml(r.relationship || 'related')}</span></button>
            <button type="button" data-rel-include="${escHtml(r.id)}" data-rel-on="${on ? '1' : '0'}" title="${on ? 'Included on outreach — click to exclude' : 'Not included on outreach — click to include'}" aria-pressed="${on ? 'true' : 'false'}" style="border:1px solid ${on ? '#2E5C3D' : 'var(--rule)'};background:${on ? '#2E5C3D' : 'transparent'};color:${on ? '#fff' : 'var(--ink-mute)'};border-radius:11px;padding:2px 8px;cursor:pointer;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;line-height:1.5;">${on ? 'cc ✓' : 'cc off'}</button>
          </span>`;
        }).join('')}
        <button type="button" class="btn-link" data-detail-action="add-related" style="font-size:12px;background:none;border:none;cursor:pointer;padding:0;color:var(--brass);">+ Add</button>
      </div>` : `<div style="margin-top:8px;"><button type="button" class="btn-link" data-detail-action="add-related" style="font-size:12px;background:none;border:none;cursor:pointer;padding:0;color:var(--brass);">+ Add spouse / related contact</button></div>`}
      <div data-related-editor style="display:none;margin-top:10px;padding:14px 16px;background:var(--shell);border:1px solid var(--rule);font-size:13px;max-width:540px;">
        <div style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:10px;">Add a related contact</div>
        <div style="position:relative;margin-bottom:10px;">
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Search your contacts
            <input data-rel-search placeholder="Start typing a name, email or phone…" autocomplete="off" style="${fld}"></label>
          <div data-rel-results style="position:relative;"></div>
          <div data-rel-picked style="display:none;margin-top:7px;font-size:12.5px;color:var(--ink);"></div>
          <div style="margin-top:6px;font-size:11.5px;color:var(--ink-mute);">Already in your database? Pick them above — no duplicate card. Otherwise fill in the fields below.</div>
        </div>
        <div data-rel-newfields style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:10px;">
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">First name<input data-rel-first style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Last name<input data-rel-last value="${escHtml(lead.last_name || '')}" style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Email<input data-rel-email type="email" style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Phone<input data-rel-phone style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Relationship
            <select data-rel-type style="${fld}">
              <option value="spouse">Spouse</option><option value="partner">Partner</option>
              <option value="co-buyer">Co-buyer</option><option value="co-seller">Co-seller</option>
              <option value="parent">Parent</option><option value="child">Child</option>
              <option value="family">Family</option><option value="other">Other</option>
            </select>
          </label>
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:2px 0 10px;font-size:12.5px;color:var(--ink);line-height:1.5;cursor:pointer;">
          <input type="checkbox" data-rel-include-new checked style="margin-top:2px;">
          <span>Include them on outreach to ${escHtml(lead.first_name || 'this contact')} — emails and texts offer both names</span>
        </label>
        <div style="display:flex;gap:10px;align-items:center;">
          <button class="btn btn-ink btn-sm" data-detail-action="save-related">Add contact</button>
          <button class="btn-link" data-detail-action="cancel-related" style="font-size:12px;background:none;border:none;cursor:pointer;color:var(--ink-mute);">Cancel</button>
          <span data-rel-result style="font-size:12.5px;margin-left:auto;"></span>
        </div>
      </div>
      <div data-consent-editor style="display:none;margin-top:10px;padding:14px 16px;background:var(--shell);border:1px solid var(--rule);font-size:13px;max-width:540px;">
        <div style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:10px;">Update contact</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:12px;">
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">First name<input data-lead-first value="${escHtml(lead.first_name || '')}" style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Last name<input data-lead-last value="${escHtml(lead.last_name || '')}" style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Phone<input data-lead-phone value="${escHtml(lead.phone || '')}" style="${fld}"></label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--ink-mute);">Email<input data-lead-email value="${escHtml(lead.email || '')}" style="${fld}"></label>
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:2px 0 10px;font-size:12.5px;color:var(--ink);line-height:1.5;cursor:pointer;">
          <input type="checkbox" data-lead-sms-consent ${lead.sms_consent ? 'checked' : ''} style="margin-top:2px;">
          <span>Client has given SMS consent (verbal or written)${lead.sms_consent_at ? ` <em style="color:var(--ink-mute);">— recorded ${escHtml(new Date(lead.sms_consent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}${lead.sms_consent_source ? ' · ' + escHtml(lead.sms_consent_source) : ''}</em>` : ''}</span>
        </label>
        <div style="display:flex;align-items:center;gap:8px;margin:2px 0 8px;">
          <span style="${cap}">Side</span>
          <select data-lead-side style="${fld}">
            ${(() => { const opts = [['', '— not set —'], ['buyer', 'Buyer'], ['seller', 'Seller'], ['both', 'Buyer and Seller'], ['past_client', 'Past Client'], ['sphere', 'Sphere'], ['do_not_contact', 'Do Not Contact'], ['__trash__', '🗑 Trash — delete permanently']]; return opts.map((o) => `<option value="${o[0]}"${side === o[0] ? ' selected' : ''}>${escHtml(o[1])}</option>`).join(''); })()}
          </select>
        </div>
        <div data-buy-status style="display:${showBuy ? 'flex' : 'none'};align-items:center;gap:8px;margin:6px 0;">
          <span style="${cap}">Buy status</span>
          <select data-buyer-stage style="${fld}">${optTags(BUYER_STAGE_LABEL, lead.buyer_stage || '')}</select>
        </div>
        <div data-sell-status style="display:${showSell ? 'flex' : 'none'};align-items:center;gap:8px;margin:6px 0;">
          <span style="${cap}">Sell status</span>
          <select data-seller-stage style="${fld}">${optTags(SELLER_STAGE_LABEL, lead.seller_stage || '')}</select>
        </div>
        <div data-assign-buy-row style="display:${showBuy ? 'flex' : 'none'};align-items:center;gap:8px;margin:6px 0;">
          <span style="${cap}">Buy-side deal</span>
          <select data-assign-deal-buy style="${fld}"><option value="">— none —</option></select>
        </div>
        <div data-assign-sell-row style="display:${showSell ? 'flex' : 'none'};align-items:center;gap:8px;margin:6px 0;">
          <span style="${cap}">Sell-side deal</span>
          <select data-assign-deal-sell style="${fld}"><option value="">— none —</option></select>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px;">
          <button class="btn btn-ink btn-sm" data-detail-action="save-consent">Save contact</button>
          <span data-consent-status-msg style="font-size:12px;"></span>
        </div>
      </div>`;

    // Any outbound draft awaiting approval — AI-written OR verbatim (e.g. the
    // Expired sequence, which is ai_generated=false). Previously this required
    // ai_generated, so verbatim sequence drafts showed with no way to act.
    const pendingDraft = messages.find((m) => m.status === 'pending_approval' && m.direction === 'outbound');
    const otherMessages = messages.filter((m) => m !== pendingDraft).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const draftChannelLabel = pendingDraft && (pendingDraft.channel === 'sms' ? 'SMS' : pendingDraft.channel === 'portal' ? 'Portal' : 'Email');
    const draftHtml = pendingDraft ? `
      <div class="ai-draft" data-message-id="${escHtml(pendingDraft.id)}">
        <div class="ai-draft-head">
          <span class="ai-tag">Draft for your review</span>
          <span class="ai-source">${escHtml(pendingDraft.ai_draft_reasoning || 'AI-drafted reply awaiting approval')}</span>
        </div>
        <div class="ai-draft-body">
          <div class="ai-from">
            <div class="avatar avatar-sm"><img src="${escHtml(leadAgent.headshot)}" alt="${escHtml(leadAgent.first)}"></div>
            <div>
              <div class="ld">From <strong>you</strong> · to <strong>${escHtml(fullName(lead))}</strong></div>
              <div class="sub">${draftChannelLabel} · Will send only after you approve</div>
            </div>
          </div>
          ${pendingDraft.subject ? `<div class="ai-subject">${escHtml(pendingDraft.subject)}</div>` : ''}
          <p class="ai-msg" style="white-space:pre-wrap;" data-draft-body>${escHtml(pendingDraft.body || '')}</p>
        </div>
        <div class="ai-foot">
          <div class="ai-foot-l"><span><strong>Channel:</strong> ${draftChannelLabel}</span></div>
          <div class="ai-foot-r">
            <button class="btn btn-ghost btn-sm" data-detail-action="discard" title="Delete this suggestion, write your own instead">Discard</button>
            <button class="btn btn-ghost btn-sm" data-detail-action="edit">Edit</button>
            ${pendingDraft.channel === 'email' ? `<button class="btn btn-ghost btn-sm" data-detail-action="preview" title="See exactly how the recipient's email will look">Preview email</button>` : ''}
            <button class="btn btn-brass btn-sm" data-detail-action="approve">Send as ${escHtml(leadAgent.first)} →</button>
          </div>
        </div>
        <div data-detail-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
      </div>` : '';

    // A persistent send-confirmation chip on every OUTBOUND message, so a sent
    // reply can always be told apart from an unsent draft or a failed send just
    // by looking at the thread — no need to remember the moment you clicked send.
    // sent/delivered/approved (or a logged past message with no status) → "✓ Sent";
    // pending_approval → still a draft; anything else → didn't send.
    const SENT_OK = ['sent', 'delivered', 'approved'];
    const sendChip = (m) => {
      if (m.direction === 'inbound') return '';
      const s = String(m.status || '').toLowerCase();
      if (!s || SENT_OK.indexOf(s) >= 0) {
        const when = m.approved_at ? fmtRel(m.approved_at) : (m.created_at ? fmtRel(m.created_at) : '');
        return `<span class="mb-sent" title="This message was sent${when ? ' ' + escHtml(when) : ''}" style="color:#2E5C3D;font-weight:600;font-size:11px;">✓ Sent</span>`;
      }
      if (s === 'pending_approval') {
        return `<span class="mb-unsent" title="Still a draft — not sent yet" style="color:#9A7B2E;font-weight:600;font-size:11px;">◷ Draft · not sent</span>`;
      }
      return `<span class="mb-failed" title="This message did not send (${escHtml(s)})" style="color:#9B2C2C;font-weight:600;font-size:11px;">✗ Not sent</span>`;
    };
    const threadHtml = otherMessages.length === 0
      ? `<div style="padding:16px;opacity:.55;font-style:italic;">No conversation yet.</div>`
      : otherMessages.map((m) => {
          const them = m.direction === 'inbound';
          // Outbound: attribute to WHO ACTUALLY SENT it (messages.approved_by),
          // not the lead's assigned agent — so James's send never shows as Sara.
          const sender = them ? null : agentInfo(m.approved_by || lead.assigned_agent);
          const who  = them ? fullName(lead) : sender.full;
          const init = them ? initials : sender.initials;
          return `
            <div class="msg-bubble ${them ? 'them' : 'us'}" data-msg-id="${escHtml(m.id)}" data-msg-source="${escHtml(m._source || 'messages')}">
              <div class="avatar avatar-sm">${escHtml(init)}</div>
              <div>
                <div class="mb-head">
                  <span class="mb-name">${escHtml(who)}</span>
                  <span class="mb-when">${escHtml(fmtRel(m.created_at))}</span>
                  <span class="mb-ch">${m.channel === 'call' ? 'Call' : (m.channel === 'sms' ? 'SMS' : 'Email')}</span>
                  ${sendChip(m)}
                  <button type="button" class="mb-del" data-msg-del aria-label="Delete message" title="Delete this message">&times;</button>
                </div>
                <p class="mb-text">${escHtml(m.body || '')}</p>
              </div>
            </div>`;
        }).join('');

    // --- Shared-with-client panel -----------------------------------------
    // Every shareable item (tasks, tours, appointments) with a per-row toggle
    // that flips it between internal and client-visible. Client-visible rows
    // surface in this contact's private portal. A wire-fraud guard on the
    // server refuses to share anything that reads like payment instructions.
    const tourTitle = (t) => (t.properties && t.properties.address)
      ? `Tour · ${t.properties.address}`
      : `${(t.tour_type || 'Property').replace(/^./, (c) => c.toUpperCase())} tour`;
    const fmtWhen = (iso) => {
      if (!iso) return '';
      const d = new Date(iso); if (isNaN(d)) return '';
      const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${MO[d.getMonth()]} ${d.getDate()} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    };
    // Client-side mirror of the server wire-fraud guard. An item whose text
    // reads like wire/payment instructions can NEVER be shared — its toggle
    // renders locked (red) and disabled, matching the server, which is still
    // the real enforcement point.
    const WIRE_RE = [/\bwir(?:e|ing|ed)\b/i, /\brouting\b/i, /\baba\b/i, /\bswift\b/i, /\biban\b/i, /\baccount\s*(?:#|no\.?\b|number\b)/i, /\bacct\b/i, /\b\d{9}\b/];
    const isWire = (...t) => { const b = t.filter(Boolean).join(' \n '); return WIRE_RE.some((re) => re.test(b)); };
    const shareables = [
      ...tasks.map((t) => ({ kind: 'task', id: t.id, tag: 'Task', when: '', title: t.title || 'Task', label: t.client_label || '', shared: t.visibility === 'client', done: !!t.done, locked: isWire(t.title, t.note, t.client_label) })),
      ...tours.map((t) => ({ kind: 'tour', id: t.id, tag: 'Tour', when: fmtWhen(t.scheduled_at), title: tourTitle(t), label: t.client_label || '', shared: t.visibility === 'client', locked: isWire(tourTitle(t), t.notes, t.client_label) })),
      ...appts.map((a) => ({ kind: 'appointment', id: a.id, tag: 'Appt', when: fmtWhen(a.starts_at), title: a.title || 'Appointment', label: a.client_label || '', shared: a.visibility === 'client', locked: isWire(a.title, a.location, a.notes, a.client_label) }))
    ];
    const sharedCount = shareables.filter((s) => s.shared).length;
    const clientFirst = lead.first_name || 'your client';

    // Live client-portal preview — a faithful mirror of what this client sees
    // at their private link. Renders only shared (non-locked) items, in the
    // client's language (client_label), and repaints whenever a toggle flips.
    function buildPreview(items) {
      const inEscrow = lead.pipeline_stage === 'under_contract';
      const ptype = (s) => (s.kind === 'task' ? 'To do' : 'Appointment');
      const psub  = (s) => (s.kind === 'task' ? (s.done ? 'Done' : 'Action needed') : (s.when ? 'On the calendar' : ''));
      const mask  = (t) => t ? `${String(t).slice(0, 4)}…${String(t).slice(-4)}` : '';
      const shared = items.filter((s) => s.shared && !s.locked);
      const cards = shared.length
        ? shared.map((s) => `
            <div class="lp-pcard">
              <div class="lp-pcard-top"><span class="lp-ptype"><span class="dot"></span>${escHtml(ptype(s))}</span>${s.when ? `<span class="lp-pdate">${escHtml(s.when)}</span>` : ''}</div>
              <div class="lp-pcard-title">${escHtml(s.label || s.title)}</div>
              ${psub(s) ? `<div class="lp-pcard-sub">${escHtml(psub(s))}</div>` : ''}
            </div>`).join('')
        : `<div class="lp-preview-empty">Nothing shared with ${escHtml(clientFirst)} yet. Flip a toggle and it appears here, live.</div>`;
      const wire = inEscrow ? `
        <div class="lp-wirecard">
          <div class="lp-wire-h"><span class="lp-wire-glyph">◆</span> Wire-fraud protection</div>
          <div class="lp-wire-b">We will never send wire instructions through this portal, by email, or by text. Before wiring funds, always call the title company directly at a phone number you have independently verified.</div>
        </div>` : '';
      const isBuyer  = lead.deal_side === 'buyer';
      // The transaction portal (seller.html?t=…) is side-aware — a buyer opens
      // their purchase view — so a buyer with a token has a real portal link too.
      const portalOk = !!lead.portal_token;
      const previewTitle = isBuyer
        ? 'Your Search'
        : `Your Sale — ${(lead.areas && lead.areas[0]) || 'Your listing'}`;
      return `
        <div class="lp-preview">
          ${portalOk ? `<div class="lp-urlchip"><span class="dot"></span>${escHtml(location.host)}/${isBuyer ? 'buyer' : 'seller'}/${escHtml(mask(lead.portal_token))}</div>` : ''}
          <div class="lp-preview-head">
            <div>
              <div class="lp-preview-title">${escHtml(previewTitle)}</div>
              <div class="lp-preview-sub">What ${escHtml(clientFirst)} sees, live</div>
            </div>
            <div class="lp-preview-avatar">${escHtml(initials)}</div>
          </div>
          ${wire}
          ${curatedBlockHtml()}
          <div class="lp-eyebrow" style="margin-top:18px;margin-bottom:10px;">Upcoming</div>
          ${cards}
        </div>`;
    }

    // Curated searches sent to this lead, rendered as the real MLS listing
    // cards (photo + price + specs) with the client's own interaction on each —
    // views, dwell, reactions and any comment they left. Reads payload.collections.
    function curatedBlockHtml() {
      if (!collections.length) return '';
      const REACT = { love: '❤️ Loved', want_to_see: '👀 Wants to see', tell_me_more: '💬 Tell me more', not_for_me: '✕ Not for me' };
      const dwellTxt = (ms) => { const m = Math.round((+ms || 0) / 60000); return m >= 1 ? `${m}m` : ''; };
      const when = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${MO[d.getMonth()]} ${d.getDate()}`; };
      const money = (n) => (n == null || n === '') ? '' : '$' + Number(n).toLocaleString('en-US');
      const specLine = (l) => [
        l.beds != null ? `${l.beds} bd` : '', l.baths != null ? `${l.baths} ba` : '',
        l.sqft != null ? `${Number(l.sqft).toLocaleString('en-US')} sqft` : '',
        l.mls_number ? `MLS ${l.mls_number}` : ''
      ].filter(Boolean).join(' · ');

      const listingCard = (l) => {
        const uniqReacts = [];
        (l.reactions || []).forEach((r) => { if (r.reaction && !uniqReacts.includes(r.reaction)) uniqReacts.push(r.reaction); });
        const comments = (l.reactions || []).filter((r) => r.comment).map((r) => r.comment);
        const viewsTxt = l.views ? `👁 ${l.views} view${l.views === 1 ? '' : 's'}${dwellTxt(l.dwell_ms) ? ` · ${dwellTxt(l.dwell_ms)}` : ''}` : '';
        const chips = uniqReacts.map((r) => `<span class="lp-lreact lp-lreact-${escHtml(r)}">${escHtml(REACT[r] || r)}</span>`).join('');
        const hasInteraction = viewsTxt || chips || comments.length;
        const interact = hasInteraction
          ? `<div class="lp-lcard-interact">
               ${viewsTxt ? `<span class="lp-lviews">${viewsTxt}</span>` : ''}${chips}
               ${comments.map((c) => `<div class="lp-lcomment">“${escHtml(c)}”</div>`).join('')}
             </div>`
          : `<div class="lp-lcard-interact lp-lcard-quiet">No views or reactions yet</div>`;
        const photo = l.photo ? `<div class="lp-lcard-photo" style="background-image:url('${escHtml(l.photo)}')"></div>` : `<div class="lp-lcard-photo lp-lcard-nophoto">No photo</div>`;
        return `
          <div class="lp-lcard">
            ${photo}
            <div class="lp-lcard-body">
              <div class="lp-lcard-top"><span class="lp-lcard-price">${escHtml(money(l.price) || '—')}</span>${l.status ? `<span class="lp-lcard-status">${escHtml(String(l.status).replace(/^./, (x) => x.toUpperCase()))}</span>` : ''}</div>
              <div class="lp-lcard-addr">${escHtml([l.address, l.city].filter(Boolean).join(' · ') || 'Listing')}</div>
              ${specLine(l) ? `<div class="lp-lcard-specs">${escHtml(specLine(l))}</div>` : ''}
              ${interact}
            </div>
          </div>`;
      };

      const blocks = collections.map((c) => {
        const cards = (c.listings && c.listings.length)
          ? c.listings.map(listingCard).join('')
          : `<div class="lp-cur-empty">This collection has no listings yet.</div>`;
        const openedChip = c.opens ? `${c.opens} open${c.opens === 1 ? '' : 's'}` : (c.total_views || c.total_reactions ? 'Viewed' : 'Not opened yet');
        const meta = [
          `${c.listing_count || 0} listing${(c.listing_count === 1) ? '' : 's'}`,
          openedChip,
          c.total_reactions ? `${c.total_reactions} reaction${c.total_reactions === 1 ? '' : 's'}` : '',
          c.created_at ? `sent ${when(c.created_at)}` : ''
        ].filter(Boolean).join(' · ');
        return `
          <div class="lp-cur-card">
            <div class="lp-cur-top">
              <span class="lp-cur-title">${escHtml(c.title || 'Curated search')}</span>
              ${c.share_path ? `<a class="lp-cur-link" href="${escHtml(c.share_path)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
            </div>
            <div class="lp-cur-meta">${escHtml(meta)}</div>
            <div class="lp-lcard-wrap">${cards}</div>
          </div>`;
      }).join('');
      return `
        <div class="lp-eyebrow" style="margin-top:18px;margin-bottom:10px;">Curated searches &amp; what they clicked</div>
        <div class="lp-cur-wrap">${blocks}</div>`;
    }

    const shareRowHtml = (s) => `
      <div class="share-row${s.shared ? ' is-shared' : ''}" data-kind="${escHtml(s.kind)}" data-id="${escHtml(s.id)}">
        <div class="share-main">
          <div class="share-tagline"><span class="share-tag">${escHtml(s.tag)}</span>${s.when ? `<span class="share-when">${escHtml(s.when)}</span>` : ''}</div>
          <div class="share-title"${s.done ? ' style="text-decoration:line-through;opacity:.6;"' : ''}>${escHtml(s.title)}</div>
          <div class="share-sees" data-share-label-wrap${s.shared ? '' : ' style="display:none;"'}>
            <span class="lp-sees-mark"></span><span class="who">${escHtml(clientFirst)} sees:</span>
            <input data-share-label value="${escHtml(s.label)}" placeholder="${escHtml(s.title)}">
          </div>
        </div>
        <label class="lp-toggle${s.locked ? ' is-locked' : ''}" title="${s.locked ? 'Contains wire or payment language — this can never be shared' : 'Show this to the client in their private portal'}">
          <input type="checkbox" data-share-toggle ${s.shared && !s.locked ? 'checked' : ''} ${s.locked ? 'disabled' : ''}>
          <span class="lp-toggle-track"></span>
          <span class="lp-toggle-cap" data-share-cap>${s.locked ? 'Locked' : (s.shared ? 'Visible' : 'Internal')}</span>
        </label>
      </div>`;
    const sharedPanelHtml = shareables.length === 0 ? '' : `
      <div class="ld-shared" data-shared-panel>
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:14px;flex-wrap:wrap;">
          <div>
            <div class="lp-deal-title">Deal Workspace</div>
            <div class="lp-deal-sub">one record · two audiences</div>
          </div>
          <div style="display:flex;align-items:center;gap:14px;">
            <span class="lp-shared-count"><b data-share-count>${sharedCount}</b> of ${shareables.length} shared with ${escHtml(clientFirst)}</span>
            <button type="button" class="lp-sharedonly" data-sharedonly title="Show only the items this client can see"><span class="dot"></span>Shared only</button>
          </div>
        </div>
        <div class="lp-eyebrow" style="margin-bottom:10px;">Tasks &amp; Appointments</div>
        ${shareables.map(shareRowHtml).join('')}
      </div>`;

    detailEl.innerHTML = `
      <button class="ld-focus-back" data-focus-back title="Back to the leads list">‹ All leads</button>
      <div class="ld-head">
        <div class="ld-head-l">
          <div class="avatar avatar-lg" style="background: var(--hot); color: var(--shell); font-family: var(--serif); font-style: italic;">${escHtml(initials)}</div>
          <div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <h2>${escHtml(fullName(lead))}</h2>
              ${headPills}
            </div>
            <div class="ld-head-meta">${escHtml(metaBits.join(' · '))}</div>
            ${contactEditorHtml}
            ${lead.notes ? `<div class="lp-leadnote" style="margin-top:12px;padding:11px 14px;background:var(--shell);border:1px solid var(--rule);border-left:3px solid var(--brass);border-radius:8px;max-width:600px;">
              <div style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:5px;">Lead notes</div>
              <div style="font-size:13.5px;line-height:1.5;color:var(--ink);white-space:pre-wrap;">${escHtml(lead.notes)}</div>
            </div>` : ''}
          </div>
        </div>
        <div class="ld-head-actions">
          ${lead.portal_token
            ? `<span class="lp-hpill live" title="This client has a live private portal link"><span class="dot"></span>Portal live · token active</span>`
            : ''}
          ${lead.phone
            ? `<a class="btn btn-ghost btn-sm" href="tel:${escHtml(lead.phone)}" title="Call ${escHtml(lead.phone)}">Call</a>`
            : `<button class="btn btn-ghost btn-sm" disabled title="No phone number on file">Call</button>`}
          <button class="btn btn-ghost btn-sm" data-detail-action="remind" title="Set a follow-up reminder — lands on your calendar">Set a reminder</button>
          <button class="btn btn-ghost btn-sm" data-detail-action="schedule" title="Open the calendar to book a tour">Schedule</button>
          ${lead.portal_token
            ? `<button class="btn btn-ghost btn-sm" data-detail-action="portal-link" title="Copy this client's private, no-login portal link">Copy portal link</button>`
            : ''}
          <span style="position:relative;display:inline-block;">
            <button class="btn btn-ink btn-sm" data-detail-action="actions-menu" title="Actions available for this contact">Actions ▾</button>
            <div class="lp-actions-menu" data-actions-menu style="display:none;position:absolute;z-index:60;right:0;top:100%;margin-top:6px;min-width:288px;text-align:left;"></div>
          </span>
        </div>
      </div>
      ${draftHtml}
      <div class="composer" data-composer>
        <div class="composer-head">
          <span class="composer-tab on" data-composer-tab="email">Email</span>
          <span class="composer-tab" data-composer-tab="sms">SMS</span>
          <span class="composer-tab" data-composer-tab="portal" title="Shows in the message drawer on their portal / collection pages">Portal</span>
          <span class="composer-tab" data-composer-tab="note" title="A note on this contact · agents only">Note</span>
        </div>
        <div data-composer-cc style="display:none;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:7px;font-size:12.5px;">
          <span style="font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-mute);">Also to</span>
        </div>
        <input data-composer-subject placeholder="Subject" style="width:100%;border:1px solid #D9CFB7;padding:8px 10px;background:#fff;font:inherit;font-size:14px;margin-bottom:6px;">
        <textarea data-composer-body placeholder="Write to ${escHtml(fullName(lead))}…"></textarea>
        <div class="composer-foot">
          <div class="composer-tools"><span data-composer-status style="font-size:11px;opacity:.7;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;"></span></div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-ghost btn-sm" data-detail-action="suggest-reply" title="Let AI draft a reply based on this conversation">✦ Suggest a reply</button>
            <button class="btn btn-ink btn-sm" data-detail-action="send">Send</button>
          </div>
        </div>
      </div>
      ${sharedPanelHtml}
      <div class="ld-thread">
        <div class="ld-thread-h">Conversation · ${messages.length} message${messages.length === 1 ? '' : 's'}</div>
        ${threadHtml}
      </div>`;

    const draftEl = detailEl.querySelector('.ai-draft');
    if (draftEl && pendingDraft) wireDraftActions(draftEl, pendingDraft, lead);
    const enrollBtn = detailEl.querySelector('[data-detail-action="enroll"]');
    if (enrollBtn) enrollBtn.addEventListener('click', () => promptEnrollSequence(lead));

    // Schedule → jump to the Calendar view (booking lives there).
    const schedBtn = detailEl.querySelector('[data-detail-action="schedule"]');
    if (schedBtn) schedBtn.addEventListener('click', () => {
      if (typeof window.showView === 'function') window.showView(null, 'cal');
      if (typeof window.__openEventCreate === 'function') {
        window.__openEventCreate({ name: fullName(lead), email: lead.email || '', kind: 'tour' });
      }
    });

    // Set a reminder → inline modal that creates a follow-up/call on the
    // calendar for THIS contact, without leaving the page.
    const remindBtn = detailEl.querySelector('[data-detail-action="remind"]');
    if (remindBtn) remindBtn.addEventListener('click', () => openReminderModal(lead));

    // Copy the client's private, no-login portal link.
    const portalBtn = detailEl.querySelector('[data-detail-action="portal-link"]');
    if (portalBtn) portalBtn.addEventListener('click', () => {
      // Side-branded link: a buyer gets /buyer/<token>, a seller /seller/<token>.
      const link = window.LGPortal.link(lead.portal_token, lead.deal_side === 'buyer' ? 'buyer' : 'seller');
      const done = () => { portalBtn.textContent = 'Copied ✓'; setTimeout(() => { portalBtn.textContent = 'Copy portal link'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(() => window.prompt('Copy this private portal link:', link));
      else window.prompt('Copy this private portal link:', link);
    });

    // Registry-driven action menu (contact_actions) — grouped, per this contact.
    const actionsBtn  = detailEl.querySelector('[data-detail-action="actions-menu"]');
    const actionsMenu = detailEl.querySelector('[data-actions-menu]');
    if (actionsBtn && actionsMenu) {
      const GROUP_LABEL = { communicate: 'Communicate', schedule: 'Schedule', market: 'Market', transact: 'Transact' };
      const ORDER = ['communicate', 'schedule', 'market', 'transact'];
      const focusComposer = (channel) => {
        const composer = detailEl.querySelector('[data-composer]'); if (!composer) return;
        const tab = composer.querySelector(`[data-composer-tab="${channel}"]`); if (tab) tab.click();
        composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const b = composer.querySelector('[data-composer-body]'); if (b) setTimeout(() => b.focus(), 200);
      };
      const runAction = async (id, ep, label, group) => {
        actionsMenu.style.display = 'none';
        if (ep === 'copy-portal-link') { if (portalBtn) portalBtn.click(); else toast('No portal link on this contact.', false); return; }
        if (ep.indexOf('/api/crm/message') === 0) { focusComposer(/text|sms/i.test(label) ? 'sms' : 'email'); return; }
        if (ep.indexOf('/api/crm/note') === 0)    { focusComposer('note'); return; }
        if (ep.indexOf('/api/sequences/enroll') === 0) { promptEnrollSequence(lead); return; }
        const r = await window.Legacy.api('/api/crm/actions', { method: 'POST', body: { lead_id: lead.id, action_id: id } });
        if (!r.ok) { toast((r.json && r.json.error) || 'Action failed.', false); return; }
        // Actions no longer leave a to-do behind — each one takes you to the tool
        // that does the real thing (the artifact is what reaches the portal).
        if (id === 'create-curated-search') {
          if (typeof window.showView === 'function') window.showView(null, 'curate');
          // Actually start the search: open the new-collection flow pre-attached
          // to this contact, instead of just landing on the Curate tab.
          const cl = { id: lead.id, name: fullName(lead) };
          if (window.LegacyCurate && typeof window.LegacyCurate.newForClient === 'function') {
            setTimeout(() => window.LegacyCurate.newForClient(cl), 90);
          } else {
            toast('Opening Curated to build the search.');
          }
        } else if (group === 'schedule') {
          // Scheduling actions open the calendar to create the real event — that
          // event (not a task) is what shows on the client portal + your agenda.
          toast(`Opening the calendar to schedule "${label}".`);
          if (typeof window.showView === 'function') window.showView(null, 'cal');
        } else {
          toast(`"${label}" — ready when you are.`);
        }
      };
      // "Actions for a <side> in <stage>" header — sentence-case, quiet.
      const headSide  = ({ buyer: 'buyer', seller: 'seller', both: 'buyer & seller' }[lead.deal_side]) || 'contact';
      const headStage = lead.pipeline_stage === 'under_contract' ? 'in escrow'
                      : (STAGE_PILL[lead.pipeline_stage] || 'the pipeline').toLowerCase();
      actionsBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (actionsMenu.style.display === 'block') { actionsMenu.style.display = 'none'; return; }
        actionsMenu.innerHTML = '<div style="padding:12px;opacity:.6;">Loading…</div>';
        actionsMenu.style.display = 'block';
        const r = await window.Legacy.api('/api/crm/actions?lead_id=' + encodeURIComponent(lead.id), { method: 'GET' });
        if (!r.ok) { actionsMenu.innerHTML = '<div style="padding:12px;color:#9B2C2C;">Could not load actions.</div>'; return; }
        const groups = (r.json && r.json.groups) || {};
        let html = `<div class="lp-actions-head">Actions for a ${escHtml(headSide)} ${escHtml(headStage)}</div>`;
        ORDER.forEach((g) => {
          const items = groups[g]; if (!items || !items.length) return;
          html += `<div class="lp-actions-group"><span class="lp-mark ${g}"></span>${GROUP_LABEL[g]}</div>`;
          items.forEach((a) => {
            const shares = a.default_visibility === 'client' ? '<span class="lp-shares">Shares</span>' : '';
            html += `<button class="leg-act" data-id="${escHtml(a.id)}" data-ep="${escHtml(a.endpoint)}" data-label="${escHtml(a.label)}" data-group="${escHtml(g)}"><span>${escHtml(a.label)}</span>${shares}</button>`;
          });
        });
        actionsMenu.innerHTML = html.indexOf('leg-act') >= 0 ? html : '<div style="padding:12px;opacity:.6;">No actions for this contact.</div>';
        actionsMenu.querySelectorAll('.leg-act').forEach((b) => {
          b.addEventListener('click', () => runAction(b.getAttribute('data-id'), b.getAttribute('data-ep'), b.getAttribute('data-label'), b.getAttribute('data-group')));
        });
      });
    }

    // Contact-preference editor — toggle the panel, save the flags.
    const consentToggle = detailEl.querySelector('[data-detail-action="edit-consent"]');
    const consentPanel  = detailEl.querySelector('[data-consent-editor]');
    if (consentToggle && consentPanel) {
      consentToggle.addEventListener('click', () => {
        consentPanel.style.display = consentPanel.style.display === 'none' ? 'block' : 'none';
      });
      // Show the right status dropdown(s) as the Side changes (live).
      const sideSel  = consentPanel.querySelector('[data-lead-side]');
      const buyRow   = consentPanel.querySelector('[data-buy-status]');
      const sellRow  = consentPanel.querySelector('[data-sell-status]');
      const buyStageSel  = consentPanel.querySelector('[data-buyer-stage]');
      const sellStageSel = consentPanel.querySelector('[data-seller-stage]');
      const buyDealRow  = consentPanel.querySelector('[data-assign-buy-row]');
      const sellDealRow = consentPanel.querySelector('[data-assign-sell-row]');
      const buyDealSel  = consentPanel.querySelector('[data-assign-deal-buy]');
      const sellDealSel = consentPanel.querySelector('[data-assign-deal-sell]');
      let dealsLoaded = false;
      // Link the contact to the deal(s) they're a party to — a buy-side deal
      // (they're buying) and/or a sell-side deal (their listing). A contact who is
      // both buying and selling can have one of each. Preselect whatever they're
      // already linked to. Populated lazily from /api/crm/listings.
      async function loadDealOptions() {
        if (dealsLoaded || (!buyDealSel && !sellDealSel)) return;
        dealsLoaded = true;
        const r = await window.Legacy.api('/api/crm/listings', { method: 'GET' });
        const j = r.ok ? r.json : {};
        const all = [...(j.active || []), ...(j.pending || []), ...(j.offers || []), ...(j.preparing || []), ...(j.closed || [])];
        // Deals this contact is already a party to, by role (from the linked-deals
        // list shown above), so the pickers open on the current link.
        const linked = Array.isArray(deals) ? deals : [];
        const curBuy  = (linked.find((d) => (d.roles || []).some((rl) => /buyer/i.test(rl))) || {}).source_key || '';
        const curSell = (linked.find((d) => (d.roles || []).some((rl) => /seller/i.test(rl))) || {}).source_key || '';
        const optionsFor = (cur) => '<option value="">— none —</option>' + all.map((d) => {
          const label = [d.address, d.city].filter(Boolean).join(', ') || d.source_key;
          return `<option value="${escHtml(d.source_key)}"${cur === d.source_key ? ' selected' : ''}>${escHtml(label)}</option>`;
        }).join('');
        if (buyDealSel)  buyDealSel.innerHTML  = all.length ? optionsFor(curBuy)  : '<option value="">No deals found</option>';
        if (sellDealSel) sellDealSel.innerHTML = all.length ? optionsFor(curSell) : '<option value="">No deals found</option>';
      }
      const syncRows = () => {
        const v = sideSel ? sideSel.value : '';
        const showBuyV  = (v === 'buyer'  || v === 'both');
        const showSellV = (v === 'seller' || v === 'both');
        if (buyRow)  buyRow.style.display  = showBuyV  ? 'flex' : 'none';
        if (sellRow) sellRow.style.display = showSellV ? 'flex' : 'none';
        // The deal link appears as soon as a side is chosen — no longer gated on
        // "in escrow" — so you can attach the contact to their deal any time.
        if (buyDealRow)  buyDealRow.style.display  = showBuyV  ? 'flex' : 'none';
        if (sellDealRow) sellDealRow.style.display = showSellV ? 'flex' : 'none';
        if (showBuyV || showSellV) loadDealOptions();
      };
      if (sideSel)      sideSel.addEventListener('change', syncRows);
      if (buyStageSel)  buyStageSel.addEventListener('change', syncRows);
      if (sellStageSel) sellStageSel.addEventListener('change', syncRows);
      // Load the deal list on open if a side is already set.
      if ((buyDealRow && buyDealRow.style.display !== 'none') || (sellDealRow && sellDealRow.style.display !== 'none')) loadDealOptions();
      const saveBtn = consentPanel.querySelector('[data-detail-action="save-consent"]');
      const msgEl   = consentPanel.querySelector('[data-consent-status-msg]');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const v = sideSel ? sideSel.value : '';
        // "Trash" is a delete, not a save — confirm and permanently remove.
        if (v === '__trash__') {
          if (deleteLeadFlow(lead.id, fullName(lead))) return;
          if (sideSel) sideSel.value = lead.contact_type || lead.deal_side || '';   // cancelled → reset
          syncRows();
          return;
        }
        const patch = { id: lead.id };
        // Name / phone / email.
        const g = (sel) => { const el = consentPanel.querySelector(sel); return el ? el.value : undefined; };
        patch.first_name = g('[data-lead-first]');
        patch.last_name  = g('[data-lead-last]');
        patch.phone      = g('[data-lead-phone]');
        patch.email      = g('[data-lead-email]');
        const smsCb = consentPanel.querySelector('[data-lead-sms-consent]');
        if (smsCb) patch.sms_consent = smsCb.checked;
        // Side + side-aware status. Only send the stage(s) for the chosen side;
        // clear the other so a mis-set stage doesn't linger.
        patch.contact_type = v || null;
        const buyVal  = g('[data-buyer-stage]') || null;
        const sellVal = g('[data-seller-stage]') || null;
        patch.buyer_stage  = (v === 'buyer'  || v === 'both') ? buyVal  : null;
        patch.seller_stage = (v === 'seller' || v === 'both') ? sellVal : null;
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        const r = await window.Legacy.api('/api/crm/lead', { method: 'PATCH', body: patch });
        if (!r.ok) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save contact';
          msgEl.style.color = '#9B2C2C'; msgEl.textContent = (r.json && r.json.error) || 'Failed to save.';
          return;
        }
        // Link the contact to their deal(s): buy-side (role buyer) and/or sell-side
        // (role seller). A contact who's both buying and selling links to one of each.
        const buyKey  = (buyDealRow  && buyDealRow.style.display  !== 'none' && buyDealSel)  ? buyDealSel.value  : '';
        const sellKey = (sellDealRow && sellDealRow.style.display !== 'none' && sellDealSel) ? sellDealSel.value : '';
        let linkMsg = '';
        if (buyKey || sellKey) {
          const email = (patch.email || lead.email || '').trim();
          if (!email) {
            linkMsg = ' — add an email to link the deal.';
          } else {
            const linkOne = async (dealKey, role) => {
              if (!dealKey) return null;
              const lr = await window.Legacy.api('/api/crm/link-deal-party', {
                method: 'POST',
                body: { deal: dealKey, email, first_name: patch.first_name || undefined, last_name: patch.last_name || undefined, phone: patch.phone || undefined, role, provision: false }
              });
              return !!(lr.ok && lr.json && lr.json.linked);
            };
            const okBuy  = await linkOne(buyKey, 'buyer');
            const okSell = await linkOne(sellKey, 'seller');
            const done = [okBuy && 'buy-side', okSell && 'sell-side'].filter(Boolean);
            const failed = [(buyKey && okBuy === false) && 'buy-side', (sellKey && okSell === false) && 'sell-side'].filter(Boolean);
            if (done.length)   linkMsg += ` Linked ${done.join(' + ')} deal${done.length > 1 ? 's' : ''}.`;
            if (failed.length) linkMsg += ` — ${failed.join(' + ')} link failed.`;
          }
        }
        saveBtn.disabled = false; saveBtn.textContent = 'Save contact';
        msgEl.style.color = '#2E5C3D';
        msgEl.textContent = ((r.json && r.json.warning) ? 'Saved (run pending migration).' : 'Saved.') + linkMsg;
        // Sync the roster row so its status pill + kanban placement update
        // without a reload (pipeline_stage is server-derived from the side
        // stages — one source of truth).
        const sl = state.leadsById && state.leadsById.get(lead.id);
        if (sl) {
          sl.contact_type = patch.contact_type;
          sl.buyer_stage  = patch.buyer_stage;
          sl.seller_stage = patch.seller_stage;
          if (patch.first_name !== undefined) sl.first_name = patch.first_name;
          if (patch.last_name  !== undefined) sl.last_name  = patch.last_name;
          if (patch.phone !== undefined) sl.phone = patch.phone;
          if (patch.email !== undefined) sl.email = patch.email;
          const upd = (r.json && r.json.lead) || {};
          if (upd.pipeline_stage != null) sl.pipeline_stage = upd.pipeline_stage;
          if (typeof paintLeadList === 'function') paintLeadList();
        }
        selectLeadId(lead.id, true); // force refresh so header pills reflect the change
      });
    }

    // Related-contact editor — toggle, save (creates their own card + links
    // both ways), and clicking a related chip opens that contact.
    (function () {
      const panel = detailEl.querySelector('[data-related-editor]');
      detailEl.querySelectorAll('[data-detail-action="add-related"]').forEach((btn) => {
        btn.addEventListener('click', () => { if (panel) { panel.style.display = 'block'; const f = panel.querySelector('[data-rel-first]'); if (f) f.focus(); } });
      });
      if (panel) {
        const cancel = panel.querySelector('[data-detail-action="cancel-related"]');
        if (cancel) cancel.addEventListener('click', () => { panel.style.display = 'none'; });
        const save = panel.querySelector('[data-detail-action="save-related"]');
        const result = panel.querySelector('[data-rel-result]');

        // ---- Typeahead over the whole book ---------------------------------
        // Most spouses Sara "adds" already have a card among 1,600+ contacts.
        // Typing them in again minted a duplicate whenever the email differed or
        // was blank, so search comes FIRST and the blank fields are the fallback.
        const searchIn  = panel.querySelector('[data-rel-search]');
        const resultsEl = panel.querySelector('[data-rel-results]');
        const pickedEl  = panel.querySelector('[data-rel-picked]');
        const newFields = panel.querySelector('[data-rel-newfields]');
        let pickedId = null;

        const clearPick = () => {
          pickedId = null;
          if (pickedEl) { pickedEl.style.display = 'none'; pickedEl.innerHTML = ''; }
          if (newFields) newFields.style.display = 'grid';
        };
        const applyPick = (id, name, sub) => {
          pickedId = id;
          if (searchIn) { searchIn.value = ''; }
          if (resultsEl) resultsEl.innerHTML = '';
          // Picking someone existing makes the create fields meaningless — hide
          // them so it's unambiguous which of the two paths is about to run.
          if (newFields) newFields.style.display = 'none';
          if (pickedEl) {
            pickedEl.style.display = 'block';
            pickedEl.innerHTML = `<span style="display:inline-flex;gap:8px;align-items:center;background:#fff;border:1px solid var(--rule);border-radius:14px;padding:4px 6px 4px 11px;">
              <strong style="font-weight:600;">${escHtml(name)}</strong>
              <span style="color:var(--ink-mute);font-size:11.5px;">${escHtml(sub || '')}</span>
              <button type="button" data-rel-clearpick style="border:none;background:none;cursor:pointer;color:var(--ink-mute);font-size:15px;line-height:1;padding:0 5px;" title="Clear">×</button>
            </span>`;
          }
        };
        if (pickedEl) pickedEl.addEventListener('click', (e) => {
          if (e.target.closest('[data-rel-clearpick]')) clearPick();
        });

        let relT;
        if (searchIn) searchIn.addEventListener('input', () => {
          clearTimeout(relT);
          const q = searchIn.value.trim();
          if (q.length < 2) { if (resultsEl) resultsEl.innerHTML = ''; return; }
          relT = setTimeout(async () => {
            const r = await window.Legacy.api('/api/crm/roster?bucket=all&q=' + encodeURIComponent(q) + '&limit=8', { method: 'GET' });
            let people = (r.ok && r.json && r.json.people) || [];
            // Never offer this contact as their own relation, nor anyone already linked.
            const linked = new Set((related || []).map((x) => x.id));
            people = people.filter((pp) => pp.id !== lead.id && !linked.has(pp.id));
            if (!resultsEl) return;
            resultsEl.innerHTML = people.length
              ? `<div style="position:absolute;z-index:50;left:0;right:0;background:#fff;border:1px solid #D9CFB7;max-height:220px;overflow:auto;">${people.map((pp) => `<div data-rel-pick="${escHtml(pp.id)}" data-rel-name="${escHtml(pp.name)}" data-rel-sub="${escHtml(pp.email || pp.phone || '')}" style="padding:8px 12px;cursor:pointer;font-size:13.5px;border-bottom:1px solid #EFE7D6;">${escHtml(pp.name)} <span style="color:#7A6F60;font-size:12px;">${escHtml(pp.email || pp.phone || 'no email or phone')}</span></div>`).join('')}</div>`
              : `<div style="position:absolute;z-index:50;left:0;right:0;background:#fff;border:1px solid #D9CFB7;padding:8px 12px;font-size:12.5px;color:#7A6F60;">No match — fill in the fields below to create them.</div>`;
          }, 250);
        });
        if (resultsEl) resultsEl.addEventListener('click', (e) => {
          const pick = e.target.closest('[data-rel-pick]');
          if (pick) applyPick(pick.getAttribute('data-rel-pick'), pick.getAttribute('data-rel-name'), pick.getAttribute('data-rel-sub'));
        });

        if (save) save.addEventListener('click', async () => {
          const incEl = panel.querySelector('[data-rel-include-new]');
          const body = {
            lead_id: lead.id,
            relationship: panel.querySelector('[data-rel-type]').value,
            include_on_comms: incEl ? !!incEl.checked : true
          };
          if (pickedId) {
            body.related_lead_id = pickedId;
          } else {
            const first = (panel.querySelector('[data-rel-first]').value || '').trim();
            if (!first) { result.style.color = '#9B2C2C'; result.textContent = 'Search for them above, or enter a first name.'; return; }
            body.first_name = first;
            body.last_name = (panel.querySelector('[data-rel-last]').value || '').trim();
            body.email     = (panel.querySelector('[data-rel-email]').value || '').trim();
            body.phone     = (panel.querySelector('[data-rel-phone]').value || '').trim();
          }
          save.disabled = true; save.textContent = 'Adding…'; result.style.color = '';
          const r = await window.Legacy.api('/api/crm/related-contact', { method: 'POST', body });
          save.disabled = false; save.textContent = 'Add contact';
          if (r.ok && r.json && r.json.related) {
            result.style.color = '#2E5C3D'; result.textContent = r.json.created_new ? 'Added ✓' : 'Linked existing ✓';
            setTimeout(() => { loadLead(lead.id); }, 550);
          } else {
            result.style.color = '#9B2C2C'; result.textContent = (r.json && r.json.error) || 'Could not add.';
          }
        });
      }
      // The cc pill on each related chip — flips include_on_comms for THIS
      // direction only (cc Larry when writing Bev is a separate answer from cc
      // Bev when writing Larry). Optimistic: the pill repaints immediately.
      detailEl.querySelectorAll('[data-rel-include]').forEach((pill) => {
        pill.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const rid = pill.getAttribute('data-rel-include');
          const next = pill.getAttribute('data-rel-on') !== '1';
          const paint = (on) => {
            pill.setAttribute('data-rel-on', on ? '1' : '0');
            pill.setAttribute('aria-pressed', on ? 'true' : 'false');
            pill.textContent = on ? 'cc ✓' : 'cc off';
            pill.title = on ? 'Included on outreach — click to exclude' : 'Not included on outreach — click to include';
            pill.style.borderColor = on ? '#2E5C3D' : 'var(--rule)';
            pill.style.background  = on ? '#2E5C3D' : 'transparent';
            pill.style.color       = on ? '#fff' : 'var(--ink-mute)';
          };
          paint(next);
          pill.disabled = true;
          const r = await window.Legacy.api('/api/crm/related-contact', {
            method: 'POST',
            body: { op: 'set-include', lead_id: lead.id, related_lead_id: rid, include_on_comms: next }
          });
          pill.disabled = false;
          if (!(r.ok && r.json && r.json.updated)) {
            paint(!next);   // server refused — put the pill back so it can't lie
            pill.title = (r.json && r.json.error) || 'Could not save — try again.';
          }
        });
      });
      detailEl.querySelectorAll('[data-open-related]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const rid = chip.getAttribute('data-open-related');
          if (rid && window.Legacy && window.Legacy.openLead) window.Legacy.openLead(rid);
          else if (rid && typeof selectLeadId === 'function') selectLeadId(rid, true);
        });
      });
    })();

    // Wire the composer (channel toggle, Note/Internal placeholders, Send).
    // `related` is passed in because the composer offers this contact's spouse /
    // co-buyer as an "Also to" chip; it lives in paintLeadDetail's scope, not
    // wireComposer's.
    wireComposer(detailEl, lead, related);

    // Per-message delete on each conversation bubble. Two-tap confirm; the row
    // fades and the card reloads so the thread reflects the removal.
    detailEl.querySelectorAll('.msg-bubble [data-msg-del]').forEach((btn) => {
      const bubble = btn.closest('.msg-bubble');
      let armed = false, timer = null;
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!armed) {
          armed = true;
          btn.textContent = 'Delete?';
          btn.classList.add('armed');
          timer = setTimeout(() => { armed = false; btn.innerHTML = '&times;'; btn.classList.remove('armed'); }, 3500);
          return;
        }
        clearTimeout(timer);
        btn.disabled = true;
        btn.textContent = '…';
        const r = await window.Legacy.api('/api/crm/message-delete', {
          body: { id: bubble && bubble.dataset.msgId, source: bubble && bubble.dataset.msgSource }
        });
        if (r.ok && r.json && r.json.deleted) {
          if (bubble) { bubble.style.transition = 'opacity .2s'; bubble.style.opacity = '0'; }
          setTimeout(() => loadLead(lead.id), 220);
        } else {
          btn.disabled = false; armed = false; btn.innerHTML = '&times;'; btn.classList.remove('armed');
        }
      });
    });

    // Wire the shared-with-client toggles + inline labels.
    const sharedPanel = detailEl.querySelector('[data-shared-panel]');
    if (sharedPanel) {
      const countEl = sharedPanel.querySelector('[data-share-count]');
      const recount = () => {
        if (countEl) countEl.textContent = String(sharedPanel.querySelectorAll('[data-share-toggle]:checked').length);
      };
      const cap = (row, shared) => {
        const c = row.querySelector('[data-share-cap]'); if (c) c.textContent = shared ? 'Visible' : 'Internal';
        row.classList.toggle('is-shared', shared);
      };
      // "Shared only" filter — a pure view filter (no data change): hides rows
      // that aren't client-visible.
      const soBtn = sharedPanel.querySelector('[data-sharedonly]');
      if (soBtn) soBtn.addEventListener('click', () => {
        const on = !soBtn.classList.contains('on');
        soBtn.classList.toggle('on', on);
        sharedPanel.querySelectorAll('.share-row').forEach((r) => {
          r.style.display = (on && !r.classList.contains('is-shared')) ? 'none' : '';
        });
      });
      sharedPanel.querySelectorAll('.share-row').forEach((row) => {
        const kind   = row.getAttribute('data-kind');
        const id     = row.getAttribute('data-id');
        const toggle = row.querySelector('[data-share-toggle]');
        const wrap   = row.querySelector('[data-share-label-wrap]');
        const labelI = row.querySelector('[data-share-label]');
        const flip = async (visibility, client_label) => {
          const body = { kind, id, visibility };
          if (client_label !== undefined) body.client_label = client_label;
          return window.Legacy.api('/api/crm/visibility', { method: 'POST', body });
        };
        if (toggle) toggle.addEventListener('change', async () => {
          const nowShared = toggle.checked;
          toggle.disabled = true;
          const r = await flip(nowShared ? 'client' : 'internal', labelI ? labelI.value.trim() : undefined);
          toggle.disabled = false;
          const item = shareables.find((x) => x.kind === kind && String(x.id) === String(id));
          if (r.ok) {
            if (wrap) wrap.style.display = nowShared ? 'flex' : 'none';
            cap(row, nowShared);
            if (item) item.shared = nowShared;
            profileEl.innerHTML = buildPreview(shareables); // live-mirror the client portal
            recount();
            toast(nowShared ? 'Now visible in the client’s portal.' : 'Hidden from the client.');
          } else {
            // Wire guard (409) or any failure — revert the toggle, warn.
            toggle.checked = !nowShared;
            if (wrap) wrap.style.display = toggle.checked ? 'flex' : 'none';
            cap(row, toggle.checked);
            toast((r.json && r.json.error) || 'Could not change visibility.', false);
          }
        });
        // Save an edited client_label on blur (only meaningful when shared).
        if (labelI) labelI.addEventListener('blur', async () => {
          if (!toggle || !toggle.checked) return;
          const r = await flip('client', labelI.value.trim());
          if (r.ok) {
            const item = shareables.find((x) => x.kind === kind && String(x.id) === String(id));
            if (item) item.label = labelI.value.trim();
            profileEl.innerHTML = buildPreview(shareables); // live-mirror the new label
            toast('Label updated.');
          } else toast((r.json && r.json.error) || 'Could not update label.', false);
        });
      });
    }

    const stages = ['new', 'nurture', 'consult', 'signed', 'active', 'under_contract', 'closed'];
    const STAGE_REMAP = { touring: 'active', offer: 'under_contract', close: 'closed' };
    const curStage = STAGE_REMAP[lead.pipeline_stage] || lead.pipeline_stage || 'new';
    const stageIdx = Math.max(0, stages.indexOf(curStage));
    const STAGE_LABELS = { new: 'New', nurture: 'Nurturing', consult: 'Consult', signed: 'Signed', active: 'Active', under_contract: 'Under contract', closed: 'Closed' };
    const stageHtml = stages.map((s, i) => {
      const cls = i < stageIdx ? 'done' : (i === stageIdx ? 'now' : '');
      return `<div class="stage-step ${cls}"><span class="l">${STAGE_LABELS[s] || s}</span></div>`;
    }).join('');

    // Notes get their own visible panel (they used to hide as small print in
    // the activity stream); the stream keeps automated events only.
    const notes  = payload.notes || [];
    const notesPanelHtml = notes.length ? `
      <div class="lp-notes-panel" style="background:var(--shell);border:1px solid var(--rule);border-left:3px solid var(--brass);padding:14px 16px;margin-bottom:16px;">
        <div style="font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:8px;">Notes · ${notes.length}</div>
        ${notes.slice(0, 6).map((n) => `
          <div style="padding:8px 0;border-bottom:1px dashed var(--rule);">
            <div style="font-family:var(--sans);font-size:14px;line-height:1.55;color:var(--ink);white-space:pre-wrap;">${escHtml((n.body || '').length > 400 ? n.body.slice(0, 400) + '…' : (n.body || ''))}</div>
            <div style="font-family:var(--sans);font-size:11px;color:var(--ink-mute);margin-top:3px;">${n.is_internal ? 'Internal · agents only' : 'Note'} · ${escHtml(fmtRel(n.created_at))}</div>
          </div>`).join('')}
        ${notes.length > 6 ? `<div style="font-family:var(--sans);font-size:12px;color:var(--ink-mute);padding-top:6px;">+${notes.length - 6} older in the activity stream</div>` : ''}
      </div>` : '';
    const eventsAndNotes = [
      ...events.map((e) => ({ kind: 'event', at: e.created_at, payload: e })),
      ...notes.map((n)  => ({ kind: 'note',  at: n.created_at, payload: n }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12);

    const activityHtml = eventsAndNotes.map((item) => {
      if (item.kind === 'note') {
        const n = item.payload;
        const tag = n.is_internal ? 'Internal' : 'Note';
        const bodyShort = (n.body || '').length > 240 ? n.body.slice(0, 240) + '…' : (n.body || '');
        return `
          <div class="tl-item">
            <div class="tl-dot ink"></div>
            <div>
              <div class="tl-text"><strong>${escHtml(tag)}</strong> — ${escHtml(bodyShort)}</div>
              <div class="tl-when">${escHtml(fmtRel(n.created_at))}</div>
            </div>
          </div>`;
      }
      const e = item.payload;
      const d = e.event_data || {};
      if (e.event_type === 'score_change' && d.change === 'stage_change') {
        return `
          <div class="tl-item">
            <div class="tl-dot ink"></div>
            <div>
              <div class="tl-text"><strong>Moved to ${escHtml(d.to || '?')}</strong>${d.from ? ` <span style="opacity:.6;">(was ${escHtml(d.from)})</span>` : ''}</div>
              <div class="tl-when">${escHtml(fmtRel(e.created_at))}${d.changed_by ? ' · ' + escHtml(d.changed_by.replace(/^agent_/, '')) : ''}</div>
            </div>
          </div>`;
      }
      if (e.event_type === 'score_change' && d.change === 'reassigned') {
        return `
          <div class="tl-item">
            <div class="tl-dot ink"></div>
            <div>
              <div class="tl-text"><strong>Reassigned to ${escHtml(d.to || '?')}</strong>${d.from ? ` <span style="opacity:.6;">(was ${escHtml(d.from)})</span>` : ''}</div>
              <div class="tl-when">${escHtml(fmtRel(e.created_at))}${d.changed_by ? ' · ' + escHtml(d.changed_by.replace(/^agent_/, '')) : ''}</div>
            </div>
          </div>`;
      }
      const dotClass = e.event_type === 'property_saved' ? 'ink' : e.event_type === 'message_sent' ? '' : 'faint';
      const label    = (e.event_type || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const extra    = d.property && d.property.address ? ` · ${escHtml(d.property.address)}` : '';
      return `
        <div class="tl-item">
          <div class="tl-dot ${dotClass}"></div>
          <div>
            <div class="tl-text"><strong>${escHtml(label)}</strong>${extra}</div>
            <div class="tl-when">${escHtml(fmtRel(e.created_at))}</div>
          </div>
        </div>`;
    }).join('') || `<div style="opacity:.5;font-style:italic;font-size:13px;">No recent activity.</div>`;

    const savedHtml = saved.slice(0, 4).map((s) => {
      const p = s.properties || {};
      const img = (p.photos && p.photos[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=200&q=80';
      return `
        <div class="lp-home">
          <div class="lp-home-img"><img src="${escHtml(img)}" alt=""></div>
          <div>
            <div class="lp-home-p">${escHtml(fmtUSD(p.price))}</div>
            <div class="lp-home-a">${escHtml(p.address || '—')}${p.city ? ' · ' + escHtml(p.city) : ''}</div>
          </div>
        </div>`;
    }).join('') || `<div style="opacity:.5;font-style:italic;font-size:13px;">No saved properties yet.</div>`;

    const assigned = lead.assigned_agent || 'sara';
    // The agent rail (score / pipeline / contact / activity) is relocated into
    // a collapsible in the workspace, because the right pane now hosts the LIVE
    // client-portal preview. Nothing is removed — just moved.
    const railHtml = `
      <div class="lp-section">
        <h3>Score &amp; signal</h3>
        <div class="lp-score">
          <div>
            <span class="v">${lead.score == null ? '—' : lead.score}</span>
            <span class="l">${escHtml((lead.temperature || 'new').replace(/^./, (c) => c.toUpperCase()))} — ${escHtml(lead.journey_stage || 'unknown')}</span>
          </div>
          <div class="trend"><div class="lp-meter"><div class="fill" style="width: ${Math.min(100, Math.max(0, lead.score || 0))}%;"></div></div></div>
        </div>
      </div>
      <div class="lp-section">
        <h3>Pipeline stage</h3>
        <div class="stage-track">${stageHtml}</div>
        <p class="lp-stage-now">${escHtml((STAGE_PILL[lead.pipeline_stage] || lead.pipeline_stage || 'New'))} · ${daysInPipeline} days</p>
      </div>
      <div class="lp-section">
        <h3>Assigned</h3>
        <div class="handoff">
          <div class="a">
            <div class="avatar avatar-sm" style="background: var(--brass); color: var(--shell); font-family: var(--serif); font-style: italic;">${AGENTS[assigned] ? AGENTS[assigned].initials : '—'}</div>
            <span class="lab">${escHtml(assigned.replace(/^./, (c) => c.toUpperCase()))}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-xs" data-detail-action="reassign" style="margin-top: 10px; width: 100%;" title="Reassign to Sara, James, or unassigned">Reassign or share</button>
      </div>
      <div class="lp-section lp-facts">
        <h3>Contact</h3>
        <dl>
          ${lead.phone     ? `<div><dt>Phone</dt><dd>${escHtml(lead.phone)}</dd></div>`         : ''}
          ${lead.email     ? `<div><dt>Email</dt><dd>${escHtml(lead.email)}</dd></div>`         : ''}
          ${lead.source    ? `<div><dt>Source</dt><dd>${escHtml(lead.source)}</dd></div>`       : ''}
          ${(lead.price_min || lead.price_max) ? `<div><dt>Budget</dt><dd>${escHtml(fmtUSD(lead.price_min))} – ${escHtml(fmtUSD(lead.price_max))}</dd></div>` : ''}
          ${lead.timeline  ? `<div><dt>Timeline</dt><dd>${escHtml(lead.timeline)}</dd></div>`   : ''}
          ${(lead.areas && lead.areas.length) ? `<div><dt>Areas</dt><dd>${escHtml(lead.areas.join(', '))}</dd></div>` : ''}
          ${(lead.must_haves && lead.must_haves.length) ? `<div><dt>Must-haves</dt><dd>${escHtml(lead.must_haves.join(' · '))}</dd></div>` : ''}
        </dl>
      </div>
      <div class="lp-section">
        <h3>Activity · ${events.length + notes.length} item${(events.length + notes.length) === 1 ? '' : 's'}</h3>
        ${activityHtml}
      </div>
      <div class="lp-section">
        <h3>Saved · ${saved.length} propert${saved.length === 1 ? 'y' : 'ies'}</h3>
        ${savedHtml}
      </div>
      ${tours.length ? `<div class="lp-section"><h3>Tours · ${tours.length}</h3>${tours.slice(0,3).map((t) => `<div class="tl-item"><div class="tl-dot"></div><div><div class="tl-text"><strong>${escHtml(t.properties && t.properties.address || 'Tour')}</strong></div><div class="tl-when">${escHtml(fmtRel(t.scheduled_at))} · ${escHtml(t.status || '')}</div></div></div>`).join('')}</div>` : ''}
      ${offers.length ? `<div class="lp-section"><h3>Offers · ${offers.length}</h3>${offers.slice(0,3).map((o) => `<div class="tl-item"><div class="tl-dot ink"></div><div><div class="tl-text"><strong>${escHtml(fmtUSD(o.amount))}</strong> · ${escHtml(o.status || '')}</div><div class="tl-when">${escHtml(o.properties && o.properties.address || '')}</div></div></div>`).join('')}</div>` : ''}
    `;
    // Agent details / internal rail — placed at the TOP, just under the header
    // actions (collapsed), so the internal meta is at hand while the body stays
    // focused on the contact and their interaction data.
    const railDetails = `<details class="lp-agent-details"><summary>Agent details · internal</summary><div class="lp-agent-details-body">${railHtml}</div></details>`;
    const headEl = detailEl.querySelector('.ld-head');
    if (headEl) headEl.insertAdjacentHTML('afterend', railDetails);
    else detailEl.insertAdjacentHTML('beforeend', railDetails);

    // Notes belong ABOVE the fold, not buried in the collapsed "Agent details"
    // rail. A saved note that lived only in that rail read as "vanished" on
    // reload — the composer's inline echo is gone after a full page load, and the
    // agent won't think to expand a collapsed accordion to find it (Cowork 8/22:
    // "saved ✓ then empty after reload"). The note was always in lead_notes; it
    // was just hidden. Render the notes panel right under the composer so a saved
    // note stays visible where the agent just typed it.
    if (notesPanelHtml) {
      const composerEl = detailEl.querySelector('[data-composer]');
      if (composerEl) composerEl.insertAdjacentHTML('afterend', notesPanelHtml);
      else if (headEl) headEl.insertAdjacentHTML('afterend', notesPanelHtml);
    }

    // Right pane = LIVE client-portal preview (mirrors exactly what this client
    // sees at their private link; repaints as visibility toggles flip).
    profileEl.innerHTML = buildPreview(shareables);

    // Wire the Reassign button now that the rail markup is in the workspace.
    const reassignBtn = detailEl.querySelector('[data-detail-action="reassign"]');
    if (reassignBtn) reassignBtn.addEventListener('click', () => promptReassign(lead));
  }

  function wireDraftActions(card, message, lead) {
    const editBtn    = card.querySelector('[data-detail-action="edit"]');
    const approveBtn = card.querySelector('[data-detail-action="approve"]');
    const discardBtn = card.querySelector('[data-detail-action="discard"]');
    const bodyEl     = card.querySelector('[data-draft-body]');
    const resultEl   = card.querySelector('[data-detail-result]');
    let editedTa = null;

    // Inline "click again to confirm" instead of a blocking native confirm()
    // dialog — keeps the flow fast and matches the app's own styling. Resets
    // back to "Discard" if the second click doesn't come within 4 seconds.
    let discardArmed = false;
    let discardResetTimer = null;
    if (discardBtn) discardBtn.addEventListener('click', async () => {
      if (!discardArmed) {
        discardArmed = true;
        discardBtn.textContent = 'Click again to confirm';
        discardBtn.style.color = '#9B2C2C';
        discardResetTimer = setTimeout(() => {
          discardArmed = false;
          discardBtn.textContent = 'Discard';
          discardBtn.style.color = '';
        }, 4000);
        return;
      }
      clearTimeout(discardResetTimer);
      discardBtn.disabled = true;
      if (editBtn) editBtn.disabled = true;
      if (approveBtn) approveBtn.disabled = true;
      discardBtn.textContent = 'Discarding…';
      resultEl.textContent = '';
      const r = await window.Legacy.api('/api/crm/discard-draft', {
        body: { message_id: message.id }
      });
      if (r.ok) {
        card.style.opacity = '0.55';
        card.style.pointerEvents = 'none';
        setTimeout(() => loadLead(lead.id), 300);
      } else {
        resultEl.style.color = '#9B2C2C';
        resultEl.textContent = (r.json && r.json.error) || 'Could not discard.';
        discardBtn.disabled = false;
        if (editBtn) editBtn.disabled = false;
        if (approveBtn) approveBtn.disabled = false;
        discardArmed = false;
        discardBtn.textContent = 'Discard';
        discardBtn.style.color = '';
      }
    });

    if (editBtn) editBtn.addEventListener('click', () => {
      if (bodyEl.querySelector('textarea')) return;
      const ta = document.createElement('textarea');
      ta.value = message.body || '';
      ta.style.cssText = 'width:100%;min-height:120px;padding:10px;border:1px solid #D9CFB7;background:#fff;font:inherit;font-size:14px;line-height:1.55;';
      bodyEl.innerHTML = '';
      bodyEl.appendChild(ta);
      editedTa = ta;
      editBtn.textContent = 'Done editing';
    });

    const previewBtn = card.querySelector('[data-detail-action="preview"]');
    if (previewBtn) previewBtn.addEventListener('click', async () => {
      previewBtn.disabled = true; const t0 = previewBtn.textContent; previewBtn.textContent = 'Rendering…';
      const r = await window.Legacy.api('/api/crm/approve', {
        body: { message_id: message.id, preview: true, edited_body: editedTa ? editedTa.value : undefined }
      });
      previewBtn.disabled = false; previewBtn.textContent = t0;
      if (r.ok && r.json && r.json.html) showEmailPreview(r.json.html, r.json.subject);
      else { resultEl.style.color = '#9B2C2C'; resultEl.textContent = (r.json && r.json.error) || 'Could not render the preview.'; }
    });

    if (approveBtn) approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      approveBtn.textContent = 'Sending…';
      resultEl.textContent = '';
      const r = await window.Legacy.api('/api/crm/approve', {
        body: { message_id: message.id, edited_body: editedTa ? editedTa.value : undefined }
      });
      if (r.ok && r.json && r.json.status === 'sent') {
        resultEl.style.color = '#2E5C3D';
        resultEl.textContent = `✓ Sent via ${(r.json.provider && r.json.provider.via) || 'provider'}.`;
        approveBtn.textContent = 'Sent';
        card.style.opacity = '0.55';
        setTimeout(() => loadLead(lead.id), 800);
      } else {
        resultEl.style.color = '#9B2C2C';
        resultEl.textContent = (r.json && r.json.error) || 'Send failed.';
        approveBtn.disabled = false;
        approveBtn.textContent = `Send as ${agentInfo(lead.assigned_agent).first} →`;
      }
    });
  }

  // Show the rendered email exactly as the recipient will see it (server-rendered
  // HTML incl. the signature + any cold footer), in a lightweight overlay.
  function showEmailPreview(html, subject) {
    const prev = document.getElementById('lg-email-preview'); if (prev) prev.remove();
    const m = document.createElement('div'); m.id = 'lg-email-preview';
    m.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(20,18,15,.55);display:flex;align-items:center;justify-content:center;padding:24px;';
    m.innerHTML =
      '<div style="background:#fff;width:640px;max-width:100%;max-height:90vh;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(20,18,15,.4);">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #E4DAC6;font-family:monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7C6A4D;">'
      +   '<span>Email preview' + (subject ? ' · ' + escHtml(subject) : '') + '</span>'
      +   '<button type="button" data-close style="background:none;border:none;font-size:16px;cursor:pointer;color:#7C6A4D;">✕</button>'
      + '</div>'
      + '<iframe title="Email preview" style="border:0;width:100%;height:70vh;background:#E7DFCB;"></iframe></div>';
    document.body.appendChild(m);
    m.querySelector('iframe').srcdoc = html;
    const close = () => m.remove();
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
  }

  // ---- Write helpers (PATCH /api/crm/lead) -------------------------------
  async function patchLead(id, patch) {
    return window.Legacy.api('/api/crm/lead', { method: 'PATCH', body: { id, ...patch } });
  }

  async function promptReassign(lead) {
    const current = (lead.assigned_agent || 'sara').toLowerCase();
    const next = prompt(
      `Reassign ${fullName(lead)} (currently ${current}).\n\nType: sara, james, or unassigned`,
      current
    );
    if (!next) return;
    const cleaned = next.trim().toLowerCase();
    if (!['sara', 'james', 'unassigned'].includes(cleaned)) {
      alert(`Invalid agent: "${cleaned}". Must be sara, james, or unassigned.`);
      return;
    }
    if (cleaned === current) return;

    // Optimistic — flip the lead in module state so the UI feels instant.
    const prev = lead.assigned_agent;
    lead.assigned_agent = cleaned;
    const stateLead = state.leadsById.get(lead.id);
    if (stateLead) stateLead.assigned_agent = cleaned;
    paintLeadList();

    const r = await patchLead(lead.id, { assigned_agent: cleaned });
    if (r.ok && r.json && r.json.lead) {
      // Reconcile: refresh the detail panel with the server-truth row.
      loadLead(lead.id);
    } else {
      // Roll back
      lead.assigned_agent = prev;
      if (stateLead) stateLead.assigned_agent = prev;
      paintLeadList();
      alert((r.json && r.json.error) || 'Reassign failed.');
    }
  }

  // `field` is which column-axis was dropped onto: 'pipeline_stage' for the
  // coarse (All / Dual) board, or 'buyer_stage' / 'seller_stage' for the
  // side-specific boards. When a side stage changes the API re-derives
  // pipeline_stage, so status and pipeline stay one source of truth.
  async function moveLeadToStage(leadId, newStage, field) {
    field = field || 'pipeline_stage';
    const stateLead = state.leadsById.get(leadId);
    if (!stateLead) return;
    const prevStage = stateLead[field];
    if (prevStage === newStage) return;

    // Optimistic
    stateLead[field] = newStage;

    const r = await patchLead(leadId, { [field]: newStage });
    if (r.ok && r.json && r.json.lead) {
      // Keep the local row in sync with any server-derived fields (e.g. a
      // side-stage change re-derives pipeline_stage).
      if (r.json.lead.pipeline_stage != null) stateLead.pipeline_stage = r.json.lead.pipeline_stage;
      if (r.json.lead.buyer_stage  !== undefined) stateLead.buyer_stage  = r.json.lead.buyer_stage;
      if (r.json.lead.seller_stage !== undefined) stateLead.seller_stage = r.json.lead.seller_stage;
      // Server-truth — refresh kanban + (if this lead is open) the detail.
      // Cheapest reconcile: refetch the pipeline to get fresh counts/values.
      const pr = await window.Legacy.api('/api/crm/pipeline', { method: 'GET' });
      if (pr.ok) paintKanban(pr.json);
      if (state.selectedLeadId === leadId) loadLead(leadId);
    } else {
      // Roll back
      stateLead[field] = prevStage;
      // Re-fetch to restore the column visually
      const pr = await window.Legacy.api('/api/crm/pipeline', { method: 'GET' });
      if (pr.ok) paintKanban(pr.json);
      alert((r.json && r.json.error) || 'Stage move failed.');
    }
  }

  // ---- Kanban drag-and-drop wiring ---------------------------------------
  function wireKanbanDnd() {
    const cards = document.querySelectorAll('[data-kanban] [data-lead-id]');
    cards.forEach((card) => {
      card.setAttribute('draggable', 'true');
      card.style.cursor = 'grab';
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', card.getAttribute('data-lead-id'));
        ev.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '0.45';
      });
      card.addEventListener('dragend', () => { card.style.opacity = ''; });
    });

    const bodies = document.querySelectorAll('[data-stage-body]');
    bodies.forEach((body) => {
      body.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        body.style.outline = '2px dashed var(--brass, #B89A5C)';
        body.style.outlineOffset = '-4px';
      });
      body.addEventListener('dragleave', () => {
        body.style.outline = '';
        body.style.outlineOffset = '';
      });
      body.addEventListener('drop', (ev) => {
        ev.preventDefault();
        body.style.outline = '';
        body.style.outlineOffset = '';
        const leadId = ev.dataTransfer.getData('text/plain');
        const targetCol = body.closest('[data-stage]');
        if (!targetCol || !leadId) return;
        const newStage = targetCol.getAttribute('data-stage');
        const field    = targetCol.getAttribute('data-stage-field') || 'pipeline_stage';
        moveLeadToStage(leadId, newStage, field);
      });
    });
  }

  // ---- Composer (manual outbound via POST /api/crm/message, or notes via POST /api/crm/note) --
  function wireComposer(detailEl, lead, related) {
    const composer  = detailEl.querySelector('[data-composer]');
    if (!composer) return;
    const subjectEl = composer.querySelector('[data-composer-subject]');
    const bodyEl    = composer.querySelector('[data-composer-body]');
    const statusEl  = composer.querySelector('[data-composer-status]');
    const sendBtn   = composer.querySelector('[data-detail-action="send"]');
    const suggestBtn = composer.querySelector('[data-detail-action="suggest-reply"]');
    const tabs      = Array.from(composer.querySelectorAll('[data-composer-tab]'));

    let channel = 'email';

    // ---- "Also to" — the related contacts marked cc on this card ----------
    // Pre-ticked from include_on_comms so a couple is reached as a couple by
    // default; each chip is clickable so the one send you don't want them on is
    // one click, not a settings change. Re-evaluated per channel because being
    // reachable differs: email needs an address, SMS a number, and each side of
    // the pairing has its own opt-out.
    const ccRow = composer.querySelector('[data-composer-cc]');
    const ccCandidates = (related || []).filter((r) => r.include_on_comms !== false);
    const ccOff = new Set();                    // ids unticked for THIS message only

    function ccReachable(ch) {
      if (ch === 'sms')   return ccCandidates.filter((r) => r.phone);
      if (ch === 'email') return ccCandidates.filter((r) => r.email);
      return [];                                // notes and portal messages have no cc
    }
    function ccSelectedIds() {
      return ccReachable(channel).filter((r) => !ccOff.has(r.id)).map((r) => r.id);
    }
    function paintCc() {
      if (!ccRow) return;
      const people = ccReachable(channel);
      if (!people.length) { ccRow.style.display = 'none'; return; }
      ccRow.style.display = 'flex';
      const label = ccRow.firstElementChild;
      while (ccRow.children.length > 1) ccRow.removeChild(ccRow.lastElementChild);
      if (label) label.textContent = channel === 'sms' ? 'Also text' : 'Also to';
      people.forEach((r) => {
        const on = !ccOff.has(r.id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.setAttribute('data-cc-chip', r.id);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        chip.title = on ? 'Click to leave them off this message' : 'Click to include them';
        chip.textContent = ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.phone) + (on ? '' : '  (off)');
        chip.style.cssText = 'border:1px solid ' + (on ? '#2E5C3D' : 'var(--rule)')
          + ';background:' + (on ? 'rgba(46,92,61,.10)' : 'transparent')
          + ';color:' + (on ? '#2E5C3D' : 'var(--ink-mute)')
          + ';border-radius:13px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12.5px;';
        chip.addEventListener('click', () => {
          if (ccOff.has(r.id)) ccOff.delete(r.id); else ccOff.add(r.id);
          paintCc();
        });
        ccRow.appendChild(chip);
      });
    }

    function setChannel(next) {
      channel = next;
      tabs.forEach((t) => t.classList.toggle('on', t.getAttribute('data-composer-tab') === next));
      const isNote = next === 'note' || next === 'internal';
      const isSms  = next === 'sms';
      const isPortal = next === 'portal';
      subjectEl.style.display = (isNote || isSms || isPortal) ? 'none' : '';
      bodyEl.disabled = false;
      bodyEl.style.opacity = '';
      sendBtn.disabled = false;
      sendBtn.title = '';
      sendBtn.textContent = isNote ? 'Save note' : 'Send';
      if (suggestBtn) suggestBtn.style.display = isNote ? 'none' : '';
      if (isNote) {
        bodyEl.placeholder = `Note about ${fullName(lead)}… (start with "task:" to also create a task)`;
        statusEl.innerHTML = 'Agents only. <label style="cursor:pointer;"><input type="checkbox" data-note-internal style="vertical-align:-2px;"> Mark internal (extra-sensitive)</label>';
        statusEl.style.color = '';
      } else if (isPortal) {
        statusEl.textContent = 'Portal message · appears in the drawer on their pages within seconds';
        bodyEl.placeholder = `Message ${fullName(lead)} on their portal…`;
      } else if (isSms) {
        if (!lead.phone)            { sendBtn.disabled = true; statusEl.textContent = 'Lead has no phone'; bodyEl.placeholder = `No phone on file for ${fullName(lead)}.`; }
        else if (lead.sms_opt_out)  { sendBtn.disabled = true; statusEl.style.color = '#9B2C2C'; statusEl.textContent = `${fullName(lead)} has opted out of SMS — sending is blocked`; bodyEl.placeholder = 'Channel opted out.'; }
        else if (!lead.sms_consent) { statusEl.style.color = '#8C6B2E'; statusEl.textContent = 'No SMS consent on record — fine for replying to their texts; record consent before outreach.'; bodyEl.placeholder = `Text ${fullName(lead)} (max 320 chars)`; }
        else                        { statusEl.textContent = '';                                          bodyEl.placeholder = `Text ${fullName(lead)} (max 320 chars)`; }
      } else {
        if (!lead.email)            { sendBtn.disabled = true; statusEl.textContent = 'Lead has no email'; bodyEl.placeholder = `No email on file for ${fullName(lead)}.`; }
        else if (lead.email_opt_out){ sendBtn.disabled = true; statusEl.style.color = '#9B2C2C'; statusEl.textContent = `${fullName(lead)} has opted out of email — sending is blocked`; bodyEl.placeholder = 'Channel opted out.'; }
        else                        { statusEl.textContent = '';                                          bodyEl.placeholder = `Email ${fullName(lead)}…`; }
      }
      paintCc();
    }
    tabs.forEach((t) => t.addEventListener('click', () => setChannel(t.getAttribute('data-composer-tab'))));
    setChannel('email');

    sendBtn.addEventListener('click', async () => {
      const text    = (bodyEl.value || '').trim();
      const subject = (subjectEl.value || '').trim();
      if (!text) { statusEl.style.color = '#9B2C2C'; statusEl.textContent = 'Body is empty'; return; }
      if (channel === 'email' && !subject) { statusEl.style.color = '#9B2C2C'; statusEl.textContent = 'Subject is required for email'; return; }

      const isNote = channel === 'note' || channel === 'internal';
      sendBtn.disabled = true;
      sendBtn.textContent = isNote ? 'Saving…' : 'Sending…';
      statusEl.style.color = '';
      statusEl.textContent = isNote ? 'Saving…' : 'Sending…';

      let r;
      if (isNote) {
        const internalCb = composer.querySelector('[data-note-internal]');
        r = await window.Legacy.api('/api/crm/note', {
          body: { lead_id: lead.id, body: text, is_internal: !!(internalCb && internalCb.checked) }
        });
      } else {
        const ccIds = ccSelectedIds();
        r = await window.Legacy.api('/api/crm/message', {
          body: {
            lead_id: lead.id,
            channel,
            body:    text,
            subject: channel === 'email' ? subject : undefined,
            cc_lead_ids: ccIds.length ? ccIds : undefined
          }
        });
      }

      const success = isNote
        ? (r.ok && r.json && r.json.note)
        : (r.ok && r.json && r.json.status === 'sent');

      if (success) {
        statusEl.style.color = '#2E5C3D';
        const ccGot = (r.json && r.json.cc) || [];
        const ccNote = ccGot.length
          ? ` · also ${ccGot[0].via === 'text' ? 'texted' : 'copied'} ${ccGot.map((c) => String(c.name || '').split(/\s+/)[0]).join(' & ')}`
          : '';
        statusEl.textContent = isNote
          ? `Saved to this contact’s Notes ✓`
          : `Sent via ${(r.json.provider && r.json.provider.via) || channel}${ccNote}`;
        const savedText = (isNote && r.json.note && r.json.note.body) || text;
        bodyEl.value = '';
        if (subjectEl) subjectEl.value = '';
        sendBtn.textContent = isNote ? 'Saved' : 'Sent';
        if (isNote) {
          // The full-card reload used to scroll the agent back to the top, so a
          // saved note looked like it vanished ("I don't see where it saved").
          // Instead echo it inline, right at the composer, and leave the scroll
          // position alone. Persists until the next note or card reload.
          const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          let echo = composer.querySelector('[data-note-echo]');
          if (!echo) {
            echo = document.createElement('div');
            echo.setAttribute('data-note-echo', '1');
            echo.style.cssText = 'margin-top:10px;border-left:3px solid var(--brass,#8C6E3D);background:rgba(140,110,61,.07);padding:9px 12px;border-radius:4px;';
            composer.appendChild(echo);
          }
          echo.innerHTML = '<div style="font:600 11px/1.2 var(--sans,sans-serif);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute,#7C6A4D);margin-bottom:4px;">Saved to Notes · just now</div>'
            + '<div style="font:14px/1.55 var(--sans,sans-serif);white-space:pre-wrap;color:var(--ink,#1A1714);">' + esc(savedText.length > 500 ? savedText.slice(0, 500) + '…' : savedText) + '</div>';
          try { echo.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
          if (typeof refreshLeadListPreview === 'function') refreshLeadListPreview(lead.id);
        } else {
          setTimeout(() => { loadLead(lead.id); refreshLeadListPreview(lead.id); }, 600);
        }
        setTimeout(() => { sendBtn.textContent = isNote ? 'Save note' : 'Send'; sendBtn.disabled = false; }, 1800);
      } else {
        statusEl.style.color = '#9B2C2C';
        statusEl.textContent = (r.json && r.json.error) || (isNote ? 'Save failed.' : 'Send failed.');
        sendBtn.textContent = isNote ? 'Save note' : 'Send';
        sendBtn.disabled = false;
      }
    });

    if (suggestBtn) suggestBtn.addEventListener('click', async () => {
      const isNote = channel === 'note' || channel === 'internal';
      if (isNote) return; // guarded by hidden button too, but belt-and-suspenders
      suggestBtn.disabled = true;
      sendBtn.disabled = true;
      const prevLabel = suggestBtn.textContent;
      suggestBtn.textContent = 'Thinking…';
      statusEl.style.color = '';
      statusEl.textContent = 'Drafting a suggested reply…';

      const r = await window.Legacy.api('/api/ai/draft-reply', {
        body: { lead_id: lead.id, channel }
      });

      if (r.ok && r.json && r.json.draft) {
        statusEl.style.color = '#2E5C3D';
        statusEl.textContent = 'Draft ready above ↑';
        suggestBtn.textContent = prevLabel;
        setTimeout(() => loadLead(lead.id), 400);
      } else {
        statusEl.style.color = '#9B2C2C';
        statusEl.textContent = (r.json && r.json.error) || 'Could not draft a reply.';
        suggestBtn.disabled = false;
        sendBtn.disabled = false;
        suggestBtn.textContent = prevLabel;
      }
    });
  }

  // After a successful send, refresh just this lead's preview text in the rail.
  async function refreshLeadListPreview(leadId) {
    const r = await window.Legacy.api('/api/crm/inbox?filter=all&limit=10', { method: 'GET' });
    if (!r.ok) return;
    const msg = (r.json.messages || []).find((m) => m.lead_id === leadId);
    if (msg) state.messageByLead.set(leadId, msg);
    paintLeadList();
  }

  async function promptEnrollSequence(lead) {
    const name = prompt(`Enroll ${fullName(lead)} in which sequence?\n(Type the exact sequence name, e.g. "new_buyer_welcome", "hot_lead_nudge", "tour_followup")`);
    if (!name) return;
    const r = await window.Legacy.api('/api/sequences/enroll', {
      body: { lead_id: lead.id, sequence_name: name.trim() }
    });
    if (r.ok && r.json && r.json.enrolled) {
      alert(`Enrolled. ${r.json.sequence.total_steps} steps. First step due ${new Date(r.json.next_due_at).toLocaleString()}.`);
    } else {
      alert((r.json && r.json.error) || 'Enrollment failed.');
    }
  }

  // Side tag → short label + css class for the little Buyer/Seller/Dual chip.
  const SIDE_META = {
    buyer:  { label: 'Buyer',  cls: 'buyer'  },
    seller: { label: 'Seller', cls: 'seller' },
    both:   { label: 'Dual',   cls: 'both'   }
  };
  function sideChipHtml(side) {
    const m = SIDE_META[side];
    return m ? `<span class="kan-side ${m.cls}">${m.label}</span>` : '';
  }
  function activeSideFilter() {
    // Re-skinned pipeline uses .ds-fpill; keep .chip for any legacy markup.
    const on = document.querySelector('[data-side-filter] .ds-fpill.on, [data-side-filter] .chip.on');
    return (on && on.getAttribute('data-side')) || 'seller';
  }

  // ---- Side-aware kanban column sets -------------------------------------
  // The board mirrors the contact-editor status dropdowns. "All"/"Dual" show
  // the coarse pipeline_stage columns; "Buyers"/"Sellers" show the fine
  // side-specific stages, bucketed by buyer_stage / seller_stage.
  const KAN_COARSE = [
    { key: 'new',            name: 'New',            sub: 'Just came in' },
    { key: 'nurture',        name: 'Nurturing',      sub: 'Staying in touch' },
    { key: 'consult',        name: 'Consult',        sub: 'Buyer consult / listing appt' },
    { key: 'signed',         name: 'Signed',         sub: 'Buyer-rep / listing agreement' },
    { key: 'active',         name: 'Active',         sub: 'Touring · on-market' },
    { key: 'under_contract', name: 'Under contract', sub: 'In escrow' },
    { key: 'closed',         name: 'Closed',         sub: 'Funded & recorded' }
  ];
  const KAN_BUYER = [
    { key: 'new',            name: 'New',            sub: 'Just came in' },
    { key: 'nurture',        name: 'Nurturing',      sub: 'Staying in touch' },
    { key: 'showing_homes',  name: 'Showing homes',  sub: 'Actively touring' },
    { key: 'writing_offers', name: 'Writing offers', sub: 'Making offers' },
    { key: 'in_escrow',      name: 'In escrow',      sub: 'Under contract' },
    { key: 'closed',         name: 'Closed',         sub: 'Funded & recorded' }
  ];
  const KAN_SELLER = [
    { key: 'new',              name: 'New',               sub: 'Just came in' },
    { key: 'nurture',          name: 'Nurturing',         sub: 'Staying in touch' },
    { key: 'preparing',        name: 'Preparing to list', sub: 'Prep & pricing' },
    { key: 'on_market',        name: 'On market',         sub: 'Active listing' },
    { key: 'reviewing_offers', name: 'Reviewing offers',  sub: 'Offers in hand' },
    { key: 'in_escrow',        name: 'In escrow',         sub: 'Under contract' },
    { key: 'closed',           name: 'Closed',            sub: 'Funded & recorded' }
  ];
  // Legacy coarse-stage aliases + fallbacks so un-migrated rows (no
  // buyer_stage/seller_stage yet) still land in a sensible side column.
  const KAN_REMAP      = { touring: 'active', offer: 'under_contract', close: 'closed' };
  const PIPE_TO_BUYER  = { new: 'new', nurture: 'nurture', consult: 'nurture', signed: 'showing_homes', active: 'showing_homes', under_contract: 'in_escrow', closed: 'closed' };
  const PIPE_TO_SELLER = { new: 'new', nurture: 'nurture', consult: 'preparing', signed: 'preparing', active: 'on_market', under_contract: 'in_escrow', closed: 'closed' };

  function kanBoardFor(side) {
    if (side === 'buyer')  return { cols: KAN_BUYER,  field: 'buyer_stage',  bucket: kanBuyerKey,  keep: (l) => ['buyer', 'both'].includes(l.deal_side || '') };
    if (side === 'seller') return { cols: KAN_SELLER, field: 'seller_stage', bucket: kanSellerKey, keep: (l) => ['seller', 'both'].includes(l.deal_side || '') };
    if (side === 'both')   return { cols: KAN_COARSE, field: 'pipeline_stage', bucket: kanCoarseKey, keep: (l) => (l.deal_side || '') === 'both' };
    return                        { cols: KAN_COARSE, field: 'pipeline_stage', bucket: kanCoarseKey, keep: () => true };
  }
  function kanCoarseKey(l) { const p = l.pipeline_stage; return KAN_REMAP[p] || p; }
  function kanBuyerKey(l)  { return l.buyer_stage  || PIPE_TO_BUYER[kanCoarseKey(l)]  || null; }
  function kanSellerKey(l) { return l.seller_stage || PIPE_TO_SELLER[kanCoarseKey(l)] || null; }

  // ======================= Pipeline board (transactions) ==================
  // The board is deal-first (a card is a property/transaction), per Sara's
  // call. Six columns = the seller journey: two lead-funnel columns (New lead,
  // Nurturing, sourced from seller-side leads that aren't deals yet) + four
  // transaction columns sourced from /api/crm/deals. Closed lives in the strip.
  let lastPipelineData = null;
  let lastDealsData = null;

  const BOARD_COLS = [
    { key: 'new',       name: 'New lead',     kind: 'lead', stg: 'new' },
    { key: 'nurture',   name: 'Nurturing',    kind: 'lead', stg: 'nurture' },
    { key: 'preparing', name: 'Listing prep', kind: 'deal', stg: 'preparing',       bucket: 'preparing' },
    { key: 'active',    name: 'On market',    kind: 'deal', stg: 'on_market',        bucket: 'active' },
    { key: 'offers',    name: 'Offers',       kind: 'deal', stg: 'reviewing_offers', bucket: 'offers' },
    { key: 'pending',   name: 'In escrow',    kind: 'deal', stg: 'in_escrow',        bucket: 'pending' }
  ];

  // Commission dollars from a deal's listing_meta — structured {usd|pct} first
  // (per the 2026 deals.json format), prose as a fallback. Mirrors the
  // morning-brief parser. Only ever returns deal-backed money, never an estimate.
  function parseCommissionUsd(meta, price) {
    if (!meta) return null;
    const c = meta.commission;
    if (c == null) return null;
    if (typeof c === 'object') {
      if (Number.isFinite(+c.usd) && +c.usd > 0) return Math.round(+c.usd);
      if (Number.isFinite(+c.pct) && +c.pct > 0 && price) return Math.round(price * (+c.pct) / 100);
      return null;
    }
    const s = String(c).trim(); if (!s) return null;
    const m = s.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/); if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, '')); if (!Number.isFinite(num)) return null;
    if (/\$/.test(s) || (!/%/.test(s) && num > 100)) return Math.round(num);
    return price ? Math.round(price * num / 100) : null;
  }
  function fmtShortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function dealCardHtml(d, col) {
    const addr = String(d.address || 'Untitled listing').split(',')[0];
    const ctx  = [d.city, d.party_summary].filter(Boolean).join(' · ') || (d.mls ? `MLS ${d.mls}` : '');
    const price = d.price;
    let noteCls = 'st', note = '';
    if (col.key === 'pending' && d.coe_days != null) {
      if (d.coe_days < 0)        { noteCls = 'st bad'; note = `COE ${Math.abs(d.coe_days)}d late`; }
      else if (d.coe_days === 0) { noteCls = 'st bad'; note = 'Closes today'; }
      else if (d.coe_days <= 7)  { noteCls = 'st bad'; note = `Closes in ${d.coe_days}d`; }
      else                       { note = `COE ${fmtShortDate(d.coe_date)}`; }
    } else if (d.health && d.health.level === 'at_risk') {
      noteCls = 'st bad'; note = d.health.label;
    } else if (d.next_event && d.next_event.label) {
      note = d.next_event.label + (d.next_event.iso ? ` ${fmtShortDate(d.next_event.iso)}` : '');
    }
    const days  = d.stage_days != null ? `${d.stage_days}d in stage` : '';
    const stale = d.stage_days != null && d.stage_days > 14;
    const due   = col.key === 'pending' && d.coe_days != null && d.coe_days <= 2;
    return `
      <div class="ds-dcard${stale ? ' stale' : ''}${due ? ' due' : ''}" data-stg="${escHtml(col.stg)}" data-deal-key="${escHtml(d.source_key)}" data-bucket="${escHtml(col.key)}">
        <span class="stripe"></span>
        <div class="body">
          <span class="marks"><i></i><i></i><i></i><i></i></span>
          <div class="nm">${escHtml(addr)}</div>
          <div class="ctx">${escHtml(ctx || '—')}</div>
          <div class="val">${price ? `<span class="num">${escHtml(fmtUSD(price))}</span>` : ''}${note ? `<span class="${noteCls}">${escHtml(note)}</span>` : ''}</div>
          ${days ? `<div class="next">${escHtml(days)}</div>` : ''}
        </div>
      </div>`;
  }

  function paintKanban(pipelineData, dealsData) {
    if (pipelineData) lastPipelineData = pipelineData;
    if (dealsData) lastDealsData = dealsData;
    const kan = document.querySelector('[data-kanban]');
    if (!kan) return;

    // Lead funnel (seller-side) → New lead / Nurturing columns.
    const allLeads = (lastPipelineData && lastPipelineData.stages || []).flatMap((s) => s.leads || []);
    const sellerLeads = allLeads.filter((l) => ['seller', 'both'].includes(l.deal_side || ''));
    const leadCols = { new: [], nurture: [] };
    for (const l of sellerLeads) {
      const k = l.seller_stage || PIPE_TO_SELLER[kanCoarseKey(l)] || null;
      if (k === 'new') leadCols.new.push(l);
      else if (k === 'nurture') leadCols.nurture.push(l);
    }

    // Transactions → the four deal columns.
    const deals  = (lastDealsData && lastDealsData.deals) || [];
    const groups = (lastDealsData && lastDealsData.groups) || {};
    const byKey  = new Map(deals.map((d) => [d.source_key, d]));
    const dealCols = {};
    for (const col of BOARD_COLS) {
      if (col.kind !== 'deal') continue;
      dealCols[col.key] = (groups[col.bucket] || []).map((k) => byKey.get(k)).filter(Boolean);
    }

    // Tallies (deal-backed money only).
    let dealCount = 0, totalValue = 0, commEscrow = 0, staleN = 0;
    const stageDays = [];
    for (const col of BOARD_COLS) {
      if (col.kind !== 'deal') continue;
      for (const d of dealCols[col.key]) {
        dealCount++;
        if (d.price) totalValue += d.price;
        if (d.stage_days != null) { stageDays.push(d.stage_days); if (d.stage_days > 14) staleN++; }
        if (col.key === 'pending') { const cu = parseCommissionUsd(d.meta, d.price); if (cu) commEscrow += cu; }
      }
    }
    const nNew = leadCols.new.length;

    kan.innerHTML = BOARD_COLS.map((col) => {
      let cardsHtml, sub, count;
      if (col.kind === 'lead') {
        const items = leadCols[col.key].slice().sort((a, b) => (b.score || 0) - (a.score || 0));
        count = items.length;
        const shown = items.slice(0, 12);
        cardsHtml = shown.length ? shown.map((l) => kanCardHtml(l, col.stg)).join('') : `<div class="ds-col-empty">Nothing here.</div>`;
        if (items.length > shown.length) cardsHtml += `<div class="ds-more-count">+ ${items.length - shown.length} more</div>`;
        sub = `${count} · ${col.key === 'new' ? 'not yet worked' : 'staying in touch'}`;
      } else {
        const items = dealCols[col.key].slice().sort((a, b) => (b.price || 0) - (a.price || 0));
        count = items.length;
        const shown = items.slice(0, 12);
        cardsHtml = shown.length ? shown.map((d) => dealCardHtml(d, col)).join('') : `<div class="ds-col-empty">Nothing here.</div>`;
        if (items.length > shown.length) cardsHtml += `<div class="ds-more-count">+ ${items.length - shown.length} more</div>`;
        const val = items.reduce((s, d) => s + (d.price || 0), 0);
        sub = `${count}${val ? ` · ${fmtUSD(Math.round(val))}` : ''}`;
        if (col.key === 'pending') { const c = items.reduce((s, d) => s + (parseCommissionUsd(d.meta, d.price) || 0), 0); if (c) sub += ` · ${fmtUSD(Math.round(c))} comm`; }
        if (col.key === 'offers' && count) cardsHtml += `<div class="ds-notebox">Nothing sits here longer than a day — it goes to escrow or back on market.</div>`;
      }
      return `
        <div class="ds-col" data-stg="${escHtml(col.stg)}" data-col="${escHtml(col.key)}" data-kind="${col.kind}">
          <div class="ds-col-h">
            <div class="row"><span class="sq"></span><span class="nm">${escHtml(col.name)}</span></div>
            <div class="sub">${escHtml(sub)}</div>
          </div>
          <div class="ds-col-body" data-stage-body>${cardsHtml}</div>
        </div>`;
    }).join('');

    // Click-through: lead card → inbox detail; deal card → the deal portal.
    kan.querySelectorAll('[data-lead-id]').forEach((card) => {
      card.addEventListener('click', () => {
        if (typeof window.showView === 'function') window.showView(null, 'inbox');
        selectLeadId(card.getAttribute('data-lead-id'));
      });
    });
    kan.querySelectorAll('[data-deal-key]').forEach((card) => {
      card.addEventListener('click', () => {
        if (card.classList.contains('dragging')) return;
        if (typeof window.openDealByKey === 'function') window.openDealByKey(card.getAttribute('data-deal-key'));
      });
    });

    // Title block + stat strip.
    const setT = (sel, txt) => { const e = document.querySelector(sel); if (e) e.textContent = txt; };
    setT('[data-bind-pipe-headline]', totalValue ? `${fmtUSD(Math.round(totalValue))} moving` : 'Your pipeline');
    setT('[data-bind-pipe-kicker]', `${dealCount} deal${dealCount === 1 ? '' : 's'} · plus ${nNew} new lead${nNew === 1 ? '' : 's'} not yet worked`);
    setT('[data-bind-pipe-coe]', commEscrow ? fmtUSD(Math.round(commEscrow)) : '—');
    setT('[data-bind-pipe-inflight]', totalValue ? fmtUSD(Math.round(totalValue)) : '—');
    setT('[data-bind-pipe-new]', String(nNew));
    setT('[data-bind-pipe-avgstage]', stageDays.length ? `${Math.round(stageDays.reduce((a, b) => a + b, 0) / stageDays.length)}d` : '—');
    const alertEl = document.querySelector('[data-bind-pipe-alert]');
    if (alertEl) {
      if (staleN > 0) {
        alertEl.style.display = '';
        setT('[data-bind-pipe-alert-text]', `${staleN} deal${staleN === 1 ? ' has' : 's have'} sat in the same stage over two weeks`);
      } else { alertEl.style.display = 'none'; }
    }

    wireBoardDnd();
  }

  // Board drag-and-drop. Leads move within the funnel columns (seller_stage);
  // deals persist only the accept-offer move (Offers ⇄ In escrow) — every other
  // deal-stage transition is owned by deals.json/Cowork, so we don't fake it.
  function wireBoardDnd() {
    const kan = document.querySelector('[data-kanban]');
    if (!kan) return;
    kan.querySelectorAll('[data-lead-id],[data-deal-key]').forEach((card) => {
      card.setAttribute('draggable', 'true');
      card.style.cursor = 'grab';
      card.addEventListener('dragstart', (ev) => {
        const payload = card.getAttribute('data-lead-id')
          ? `lead:${card.getAttribute('data-lead-id')}`
          : `deal:${card.getAttribute('data-deal-key')}:${card.getAttribute('data-bucket')}`;
        ev.dataTransfer.setData('text/plain', payload);
        ev.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    kan.querySelectorAll('[data-stage-body]').forEach((body) => {
      const col = body.closest('[data-col]');
      body.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; if (col) col.classList.add('drop-target'); });
      body.addEventListener('dragleave', () => { if (col) col.classList.remove('drop-target'); });
      body.addEventListener('drop', (ev) => {
        ev.preventDefault();
        if (col) col.classList.remove('drop-target');
        const payload = ev.dataTransfer.getData('text/plain') || '';
        const targetCol = body.closest('[data-col]'); if (!targetCol) return;
        const toKey = targetCol.getAttribute('data-col');
        const toKind = targetCol.getAttribute('data-kind');
        if (payload.indexOf('lead:') === 0) {
          if (toKind !== 'lead') { flashBoardNote('Leads move between New lead and Nurturing only.'); return; }
          moveLeadToStage(payload.slice(5), toKey === 'new' ? 'new' : 'nurture', 'seller_stage');
        } else if (payload.indexOf('deal:') === 0) {
          const parts = payload.split(':');
          moveDealToStage(parts[1], parts[2], toKey);
        }
      });
    });
  }

  async function moveDealToStage(sourceKey, fromKey, toKey) {
    if (!sourceKey || fromKey === toKey) return;
    let body = null;
    if (fromKey === 'offers' && toKey === 'pending') body = { source_key: sourceKey, accepted: true };
    else if (fromKey === 'pending' && toKey === 'offers') body = { source_key: sourceKey, accepted: false };
    if (!body) { flashBoardNote('Cowork moves deals between these stages — only Offers ⇄ In escrow is a manual move.'); paintKanban(); return; }
    const r = await window.Legacy.api('/api/crm/deal-stage', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      const dr = await window.Legacy.api('/api/crm/deals', { method: 'GET' });
      if (dr.ok) paintKanban(null, dr.json);
    } else {
      flashBoardNote((r.json && r.json.error) || 'Stage move failed.');
      paintKanban();
    }
  }

  let __boardNoteEl = null;
  function flashBoardNote(msg) {
    if (!__boardNoteEl) {
      __boardNoteEl = document.createElement('div');
      __boardNoteEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1d2d3d;color:#f2f2f3;font-family:Barlow,system-ui,sans-serif;font-size:14px;padding:10px 16px;z-index:9999;border:1px solid #2c455d;max-width:90vw;';
      document.body.appendChild(__boardNoteEl);
    }
    __boardNoteEl.textContent = msg;
    __boardNoteEl.style.display = '';
    clearTimeout(__boardNoteEl.__t);
    __boardNoteEl.__t = setTimeout(() => { __boardNoteEl.style.display = 'none'; }, 3400);
  }

  // ========================= Dashboard 1A (Today) =========================
  // Re-skin of the landing screen. Reuses the board's cached pipeline/deals
  // (lastPipelineData / lastDealsData) plus a fresh morning-brief + metrics.
  const DEAL_STAGE_META = {
    preparing: { stg: 'preparing',        label: 'Listing prep' },
    listing:   { stg: 'on_market',        label: 'On market' },
    offer:     { stg: 'reviewing_offers', label: 'Offers' },
    pending:   { stg: 'in_escrow',        label: 'In escrow' },
    closed:    { stg: 'closed',           label: 'Closed' }
  };
  function dashClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function daysSince(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }
  function sellerLeadStageCounts() {
    const leads = (lastPipelineData && lastPipelineData.stages || []).flatMap((s) => s.leads || []);
    const out = { new: 0, nurture: 0 };
    for (const l of leads) {
      if (!['seller', 'both'].includes(l.deal_side || '')) continue;
      const k = l.seller_stage || PIPE_TO_SELLER[kanCoarseKey(l)] || null;
      if (k === 'new') out.new++; else if (k === 'nurture') out.nurture++;
    }
    return out;
  }

  let __dashLoading = false;
  const _lgDraftBody = {};   // message_id -> raw draft body, for the approval modal's Edit box
  async function paintDashboardDS() {
    const root = document.querySelector('.ds-dash');
    if (!root || !window.Legacy || !window.Legacy.api || __dashLoading) return;
    __dashLoading = true;
    const setT = (sel, txt) => { const e = root.querySelector(sel); if (e) e.textContent = txt; };
    const setHTML = (sel, html) => { const e = root.querySelector(sel); if (e) e.innerHTML = html; };
    try {
      const [mbRes, mRes] = await Promise.all([
        window.Legacy.api('/api/crm/morning-brief', { method: 'GET' }),
        window.Legacy.api('/api/crm/metrics', { method: 'GET' })
      ]);
      const mb  = (mbRes && mbRes.ok && mbRes.json) || {};
      const met = (mRes && mRes.ok && mRes.json) || {};
      const deals  = Array.isArray(lastDealsData && lastDealsData.deals) ? lastDealsData.deals : [];
      const groups = (lastDealsData && lastDealsData.groups && typeof lastDealsData.groups === 'object') ? lastDealsData.groups : {};
      const roster = (mb && mb.roster) || {};
      const drafts = mb.drafts || [], tours = mb.tours_today || [], quiet = mb.radio_silence || [];
      const appts = mb.appointments_today || [];
      const viewerAgent = mb.viewer_agent || 'sara';
      const APPT_LABEL = { inspection: 'Inspection', showing: 'Showing', listing_appt: 'Listing appt', walkthrough: 'Walkthrough', follow_up: 'Follow-up', appraisal: 'Appraisal', call: 'Call', meeting: 'Meeting', open: 'Open house', block: 'Block' };
      const apptLabel = (a) => a.kind === 'inspection' ? (a.sub_kind ? a.sub_kind + ' inspection' : 'Inspection') : (APPT_LABEL[a.kind] || 'Appointment');
      const apptWho = (a) => (a.agent && a.agent !== viewerAgent) ? (a.agent === 'james' ? 'James' : 'Sara') : '';
      // Resolve a group's source_keys to their deal rows (skip any that aren't in
      // the flat list — e.g. a just-added escrow that hasn't synced into deals yet).
      const dealsIn = (g) => (Array.isArray(groups[g]) ? groups[g] : []).map((k) => deals.find((d) => d && d.source_key === k)).filter(Boolean);
      const pending = dealsIn('pending');
      const boardDeals = ['preparing', 'active', 'offers', 'pending'].flatMap(dealsIn);

      // Each section paints inside its own guard, so one malformed deal or brief
      // item can only blank THAT section — never the whole board — and the exact
      // failure is logged with its section name instead of swallowed silently.
      const guard = (label, fn) => { try { fn(); } catch (e) { if (window.console && console.warn) console.warn('[dashboard] ' + label + ' failed:', e); } };

      // ---- title ----
      guard('title', () => {
        const today = new Date();
        setT('[data-bind-dash-date]', today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
        const moveCount = drafts.length + tours.length + appts.length;
        setT('[data-bind-dash-headline]', moveCount ? `${moveCount} thing${moveCount === 1 ? '' : 's'} move today` : 'You’re clear today');
        const dueSoon = pending.filter((d) => d.coe_days != null && d.coe_days <= 2).length;
        const alertEl = root.querySelector('[data-bind-dash-alert]');
        if (alertEl) {
          if (dueSoon > 0) { alertEl.style.display = ''; setT('[data-bind-dash-alert-text]', `${dueSoon} deadline${dueSoon === 1 ? '' : 's'} inside 48 hours`); }
          else alertEl.style.display = 'none';
        }
      });

      // ---- deadlines at a glance ----
      // One ranked strip of every upcoming/overdue contingency + close-of-escrow
      // across the deals in motion, so "what's due next" is answerable without
      // opening each deal. Sourced from mb.active_deals — the SAME agent-scoped
      // deal data (and the same milestones) the deal cards use, so the strip can
      // never disagree with a deal. James sees his; the broker sees all, tagged.
      guard('deadlines', () => {
        const host = root.querySelector('[data-dash-deadlines]');
        if (!host) return;
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
        const dd = (iso) => {
          if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
          const a = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
          const b = Date.UTC(+todayStr.slice(0, 4), +todayStr.slice(5, 7) - 1, +todayStr.slice(8, 10));
          return Math.round((a - b) / 86400000);
        };
        const rows = [];
        (mb.active_deals || []).forEach((d) => {
          const addr = String(d.address || d.lead_name || '').split(',')[0];
          const agent = d.agent || null;
          const cols = (d.at_a_glance && d.at_a_glance.columns) || [];
          // The synthesized "Close of escrow" row (below) already represents the
          // close date. Only when it will actually render, drop any closing
          // milestone that lands on the SAME date — otherwise the day shows twice
          // (e.g. a "Close of Escrow — 8/31" milestone + "Close of escrow"). A
          // closing milestone on a different date (e.g. "Final walk-through") is
          // kept, and if the COE row won't render the close is never dropped.
          const coeWillShow = d.coe_date && d.days_to_coe != null && d.days_to_coe >= -3;
          cols.forEach((c) => {
            if (c.key !== 'contingencies' && c.key !== 'closing') return;
            (c.items || []).forEach((it) => {
              if (!it.date || it.status === 'done') return;
              if (c.key === 'closing' && coeWillShow && it.date === d.coe_date) return;
              const n = dd(it.date);
              if (n == null || n < -3) return;           // small overdue grace
              rows.push({ date: it.date, days: n, label: it.label || (c.key === 'closing' ? 'Closing' : 'Contingency'), addr, agent, type: c.key });
            });
          });
          // COE straight off the deal (mirrors the deal card's countdown).
          if (coeWillShow) {
            rows.push({ date: d.coe_date, days: d.days_to_coe, label: 'Close of escrow', addr, agent, type: 'closing' });
          }
        });
        // Dedup exact repeats (a closing milestone that equals the COE date).
        const seen = new Set();
        const uniq = rows.filter((r) => { const k = r.addr + '|' + r.date + '|' + r.label; if (seen.has(k)) return false; seen.add(k); return true; });
        uniq.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || ((a.type === 'closing') - (b.type === 'closing')));
        const dueSoonN = uniq.filter((r) => r.days <= 2).length;
        setT('[data-bind-dash-dlsub]', uniq.length ? (dueSoonN ? `${dueSoonN} inside 48h · ${uniq.length} total` : `${uniq.length} upcoming`) : '');
        if (!uniq.length) { host.innerHTML = `<div class="ds-empty-line">No contingencies or closings coming up.</div>`; return; }
        const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const fmtD = (s) => `${MO[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}`;
        const chip = (r) => r.days < 0 ? `${Math.abs(r.days)}d late` : r.days === 0 ? 'Today' : r.days === 1 ? 'Tomorrow' : `${r.days} days`;
        const urg = (r) => r.days < 0 ? 'over' : r.days <= 2 ? 'soon' : r.days <= 7 ? 'wk' : '';
        host.innerHTML = uniq.slice(0, 10).map((r) => {
          const who = (r.agent && r.agent !== viewerAgent) ? ' · ' + (r.agent === 'james' ? 'James' : 'Sara') : '';
          return `<div class="ds-dl-row" data-stg="${r.type === 'closing' ? 'closing' : 'contingencies'}">
            <span class="ds-dl-days ${urg(r)}">${escHtml(chip(r))}</span>
            <span class="ds-dl-main"><span class="ds-dl-lab">${escHtml(r.label)}</span><span class="ds-dl-sub">${escHtml(r.addr)}${escHtml(who)}</span></span>
            <span class="ds-dl-date">${escHtml(fmtD(r.date))}</span>
          </div>`;
        }).join('');
      });

      // ---- stat strip (deal-backed money only) ----
      guard('stats', () => {
        const pipeVal = boardDeals.reduce((s, d) => s + (d.price || 0), 0);
        const comm = pending.reduce((s, d) => s + (parseCommissionUsd(d.meta, d.price) || 0), 0);
        setT('[data-bind-dash-pipeval]', pipeVal ? fmtUSD(pipeVal) : '—');
        setT('[data-bind-dash-comm]', comm ? fmtUSD(comm) : '—');
        setT('[data-bind-dash-newleads]', String((mb.new_today || []).length));
        setT('[data-bind-dash-escrow]', String(pending.length));
        setT('[data-bind-dash-clients]', String(roster.clients != null ? roster.clients : '—'));
      });

      // ---- Today list ----
      guard('today', () => {
        const items = []
          .concat(drafts.map((d) => { _lgDraftBody[d.id] = d.body || ''; return { kind: 'draft', lead_id: d.lead_id, message_id: d.id, name: fullName(d.leads || {}) || 'A lead', title: d.subject || 'Draft reply ready', ctx: `Draft ${d.channel || 'reply'} awaiting your approval`, due: 'Review', stg: 'nurture' }; }))
          .concat(tours.map((t) => ({ kind: 'tour', lead_id: (t.leads && t.leads.id) || null, name: fullName(t.leads || {}) || 'Client', title: `${t.tour_type === 'video' ? 'Video tour' : 'Showing'} · ${fullName(t.leads || {}) || 'client'}`, ctx: (t.properties && [t.properties.address, t.properties.city].filter(Boolean).join(', ')) || 'Location TBD', due: dashClock(t.scheduled_at), stg: 'on_market' })))
          .concat(appts.map((a) => { const addr = a.deals ? [a.deals.address, a.deals.city].filter(Boolean).join(', ') : ''; const lbl = apptLabel(a); const who = apptWho(a); const base = a.title ? `${lbl} · ${a.title}` : lbl; return { kind: 'appt', lead_id: null, name: a.title || lbl, title: who ? `${who} · ${base}` : base, ctx: addr || a.client_label || 'On your calendar', due: a.all_day ? 'All day' : dashClock(a.starts_at), stg: 'on_market' }; }));
        const todayHost = root.querySelector('[data-dash-today]');
        setT('[data-bind-dash-todaycount]', `${items.length} item${items.length === 1 ? '' : 's'}${drafts.length ? ` · ${drafts.length} to review` : ''}`);
        if (todayHost) {
          if (!items.length) {
            todayHost.innerHTML = `<div class="ds-empty-line">Nothing queued — you’re clear.</div>`;
          } else {
            const hero = items[0];
            const rest = items.slice(1);
            const heroHtml = `
            <div class="ds-hero">
              <div class="lab">Needs you now</div>
              <div class="tt">${escHtml(hero.title)}</div>
              <div class="cx">${escHtml(hero.ctx)}</div>
              <div class="acts">
                ${hero.kind === 'appt'
                  ? `<button class="ds-btn ds-btn--amber" data-dash-cal>Open calendar</button>`
                  : hero.kind === 'draft'
                    ? `<button class="ds-btn ds-btn--amber" data-dash-approve="${escHtml(hero.message_id || '')}">Review &amp; approve →</button><button class="ds-btn" data-dash-open="${escHtml(hero.lead_id || '')}">Open lead</button>`
                    : `<button class="ds-btn ds-btn--amber" data-dash-open="${escHtml(hero.lead_id || '')}">Open showing</button><button class="ds-btn" data-dash-cal>See calendar</button>`}
              </div>
            </div>`;
            const rowsHtml = `<div class="ds-today-list">` + rest.map((it) => `
            <div class="ds-today-row" data-stg="${escHtml(it.stg)}" ${it.kind === 'appt' ? 'data-dash-cal' : it.kind === 'draft' ? `data-dash-approve="${escHtml(it.message_id || '')}"` : `data-dash-open="${escHtml(it.lead_id || '')}"`}>
              <span class="stripe"></span>
              <div class="tr-b"><div class="tt">${escHtml(it.title)}</div><div class="cx">${escHtml(it.ctx)}</div></div>
              <span class="due">${escHtml(it.due)}</span>
            </div>`).join('') + `</div>`;
            todayHost.innerHTML = heroHtml + rowsHtml;
          }
        }
      });

      // ---- Going quiet ----
      guard('quiet', () => {
        setT('[data-bind-dash-quietcount]', quiet.length ? `${quiet.length}` : '');
        const quietHost = root.querySelector('[data-dash-quiet]');
        if (quietHost) {
          quietHost.innerHTML = quiet.length
            ? `<div class="ds-quiet-list">` + quiet.slice(0, 5).map((q) => {
                const dd = daysSince(q.last_contact_at);
                return `<div class="ds-quiet-row" data-dash-open="${escHtml(q.id || '')}"><span class="nm">${escHtml(fullName(q) || 'A lead')}</span><span class="dy">${dd != null ? dd + 'd quiet' : 'no contact yet'}</span></div>`;
              }).join('') + `</div>`
            : `<div class="ds-empty-line">Everyone’s been touched recently.</div>`;
        }
      });

      // ---- pipeline: segmented bar + labels ----
      guard('pipeline', () => {
        const sc = sellerLeadStageCounts();
        const segs = [
          { key: 'new',       name: 'New lead',     stg: 'new',              n: sc.new },
          { key: 'nurture',   name: 'Nurturing',    stg: 'nurture',          n: sc.nurture },
          { key: 'preparing', name: 'Listing prep', stg: 'preparing',        n: (groups.preparing || []).length },
          { key: 'active',    name: 'On market',    stg: 'on_market',        n: (groups.active || []).length },
          { key: 'offers',    name: 'Offers',       stg: 'reviewing_offers', n: (groups.offers || []).length },
          { key: 'pending',   name: 'In escrow',    stg: 'in_escrow',        n: (groups.pending || []).length }
        ];
        const segTotal = segs.reduce((s, x) => s + x.n, 0) || 1;
        setT('[data-bind-dash-pipesub]', `${segTotal} in motion`);
        setHTML('[data-dash-segbar]', segs.map((s) => s.n ? `<div class="ds-seg" data-stg="${s.stg}" style="flex:${s.n}" title="${escHtml(s.name)}: ${s.n}"></div>` : '').join('') || `<div class="ds-seg" data-stg="new" style="flex:1"></div>`);
        setHTML('[data-dash-seglabels]', segs.map((s) => `<div class="ds-seglabel" style="flex:${Math.max(s.n, 0.6)}" data-stg="${s.stg}"><div class="nm"><span class="dot"></span>${escHtml(s.name)}</div><div class="ct">${s.n}</div></div>`).join(''));
      });

      // ---- deal table (up to 6, most imminent first) ----
      guard('dealtable', () => {
        const tableDeals = boardDeals.slice().sort((a, b) => {
          const av = a.coe_days == null ? 1e9 : a.coe_days, bv = b.coe_days == null ? 1e9 : b.coe_days;
          return av - bv;
        }).slice(0, 6);
        const tblHost = root.querySelector('[data-dash-dealtable]');
        if (tblHost) {
          if (!tableDeals.length) {
            tblHost.innerHTML = `<div class="ds-empty-line">No active deals on the board yet.</div>`;
          } else {
            const head = `<div class="ds-dt-h"><span>Property</span><span class="who-col">Who</span><span>Stage</span><span style="text-align:right">Value</span></div>`;
            const rows = tableDeals.map((d) => {
              const meta = DEAL_STAGE_META[d.stage] || { stg: 'new', label: d.stage || '—' };
              const next = d.coe_days != null
                ? (d.coe_days < 0 ? `COE ${Math.abs(d.coe_days)}d late` : d.coe_days === 0 ? 'Closes today' : `Closes in ${d.coe_days}d`)
                : (d.next_event && d.next_event.label ? d.next_event.label : '');
              return `<div class="ds-dt-r">
              <span><span class="prop">${escHtml(String(d.address || 'Untitled').split(',')[0])}</span></span>
              <span class="who">${escHtml(d.party_summary || d.city || '')}</span>
              <span><span class="ds-stagepill" data-stg="${escHtml(meta.stg)}"><i></i>${escHtml(meta.label)}</span></span>
              <span class="val">${d.price ? escHtml(fmtUSD(d.price)) : '—'}</span>
            </div>`;
            }).join('');
            tblHost.innerHTML = `<div class="ds-dealtable">${head}${rows}</div>`;
          }
        }
      });

      // ---- funnel ----
      guard('funnel', () => {
        const f = mb.funnel || {};
        const funnelRows = [
          { label: 'New leads', stg: 'new',              v: f.new_leads || 0 },
          { label: 'Engaged',   stg: 'nurture',          v: f.engaged || 0 },
          { label: 'Touring',   stg: 'on_market',        v: f.toured || 0 },
          { label: 'Offers',    stg: 'reviewing_offers', v: f.offered || 0 },
          { label: 'Closed',    stg: 'closed',           v: f.closed || 0 }
        ];
        const fMax = Math.max(1, ...funnelRows.map((r) => r.v));
        setHTML('[data-dash-funnel]', funnelRows.map((r) => `
        <div class="ds-funnel-row" data-stg="${r.stg}">
          <span class="fl">${escHtml(r.label)}</span>
          <span class="track"><span class="fill" style="width:${Math.round((r.v / fMax) * 100)}%"></span></span>
          <span class="fv">${r.v}</span>
        </div>`).join(''));
      });

      // ---- latest activity ----
      guard('activity', () => {
        const sig = (mb.signals || []).slice(0, 5);
        setHTML('[data-dash-activity]', sig.length
          ? `<div class="ds-activity">` + sig.map((s) => `<div class="ds-activity-row" data-stg="nurture"><span class="stripe"></span><div><div class="tt">${escHtml(s.body || s.tag || 'Activity')}</div><div class="tm">${escHtml(s.time || '')}${s.tag ? ' · ' + escHtml(s.tag) : ''}</div></div></div>`).join('') + `</div>`
          : `<div class="ds-empty-line">Nothing overnight.</div>`);
      });

    } catch (e) {
      /* dashboard is best-effort — never blank the app — but surface the reason
         so a silent throw here can't hide behind an empty Today again. */
      if (window.console && console.warn) console.warn('[dashboard] paint failed:', e);
    } finally {
      __dashLoading = false;
    }
  }

  // One-click approval: a draft on the Today board opens a focused modal showing
  // the email exactly as it will send (branded), with Approve & Send / Edit /
  // Not now — so nothing has to be hunted for on the lead page. Raw draft bodies
  // are stashed by message_id in _lgDraftBody (populated in the Today guard).
  async function openApprovalModal(messageId) {
    if (!messageId) return;
    const ov = document.createElement('div');
    ov.setAttribute('data-approve-ov', '');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(26,23,20,.55);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:28px 16px;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#FAF6EC;max-width:680px;width:100%;border-radius:12px;box-shadow:0 30px 80px -20px rgba(20,18,15,.6);overflow:hidden;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #E4DAC6;">'
        + '<div style="font-family:Cormorant Garamond,Georgia,serif;font-size:22px;color:#1A1714;">Review &amp; send</div>'
        + '<button type="button" data-x style="border:none;background:#EBE2CD;color:#5b5347;font-size:20px;line-height:1;width:34px;height:34px;border-radius:8px;cursor:pointer;">×</button></div>'
      + '<div data-subj style="padding:12px 20px 0;font-size:14px;color:#1A1714;"></div>'
      + '<div data-frame-wrap style="padding:12px 20px;"><div style="color:#7C6A4D;font-size:14px;">Loading the email…</div></div>'
      + '<div data-edit style="display:none;padding:0 20px 12px;"><textarea data-edit-body rows="10" style="width:100%;font:14px/1.6 Georgia,serif;padding:10px;border:1px solid #D9CFB7;border-radius:6px;box-sizing:border-box;"></textarea>'
        + '<div style="margin-top:8px;"><button class="ds-btn" data-edit-apply type="button">Update preview</button></div></div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-items:center;padding:14px 20px;border-top:1px solid #E4DAC6;background:#F3EDDD;">'
        + '<span data-msg style="margin-right:auto;font-size:13px;min-height:16px;"></span>'
        + '<button class="ds-btn" data-edit-toggle type="button">Edit text</button>'
        + '<button class="ds-btn" data-x2 type="button">Not now</button>'
        + '<button class="ds-btn ds-btn--amber" data-approve type="button">Approve &amp; send</button></div>';
    ov.appendChild(panel);
    document.body.appendChild(ov);

    const frameWrap = panel.querySelector('[data-frame-wrap]');
    const subjEl    = panel.querySelector('[data-subj]');
    const msgEl     = panel.querySelector('[data-msg]');
    const editWrap  = panel.querySelector('[data-edit]');
    const editBody  = panel.querySelector('[data-edit-body]');
    editBody.value  = _lgDraftBody[messageId] || '';

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-x]') || e.target.closest('[data-x2]')) close(); });

    // Self-contained request helper (the shared `api()` lives in a different
    // IIFE and isn't in scope here). Never throws — always resolves so the modal
    // can't hang on "Loading…".
    async function postApprove(payload) {
      try {
        const resp = await fetch('/api/crm/approve', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        let json = null; try { json = await resp.json(); } catch (e) {}
        return { ok: resp.ok, status: resp.status, json };
      } catch (e) { return { ok: false, status: 0, json: null, err: String(e && e.message || e) }; }
    }

    async function loadPreview(bodyOverride) {
      frameWrap.innerHTML = '<div style="color:#7C6A4D;font-size:14px;">Loading the email…</div>';
      const payload = { message_id: messageId, preview: true };
      if (bodyOverride != null) payload.edited_body = bodyOverride;
      const r = await postApprove(payload);
      if (!r.ok || !r.json) {
        frameWrap.innerHTML = '<div style="color:#9B2C2C;font-size:14px;">Couldn’t load the preview'
          + (r.status ? ' (HTTP ' + r.status + ')' : '') + '. '
          + escHtml((r.json && r.json.error) || r.err || '') + '</div>';
        return;
      }
      subjEl.innerHTML = r.json.subject ? '<b>Subject:</b> ' + escHtml(r.json.subject) : '';
      const fr = document.createElement('iframe');
      fr.setAttribute('scrolling', 'no');
      fr.style.cssText = 'width:100%;border:1px solid #E4DAC6;border-radius:8px;background:#fff;min-height:320px;';
      frameWrap.innerHTML = '';
      frameWrap.appendChild(fr);
      fr.addEventListener('load', () => { try { fr.style.height = (fr.contentDocument.body.scrollHeight + 24) + 'px'; } catch (e) { fr.style.height = '640px'; } });
      fr.srcdoc = r.json.html || '';
    }
    loadPreview();

    panel.querySelector('[data-edit-toggle]').addEventListener('click', () => {
      editWrap.style.display = editWrap.style.display === 'none' ? 'block' : 'none';
    });
    panel.querySelector('[data-edit-apply]').addEventListener('click', () => loadPreview(editBody.value));

    panel.querySelector('[data-approve]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Sending…';
      const payload = { message_id: messageId };
      if (editWrap.style.display !== 'none' && editBody.value.trim()) payload.edited_body = editBody.value.trim();
      const r = await postApprove(payload);
      if (r.ok && r.json && r.json.status === 'sent') {
        msgEl.style.color = '#2E5C3D';
        msgEl.textContent = '✓ Sent. Emails 2–4 will now auto-send on schedule and stop the moment they reply.';
        panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        setTimeout(() => { close(); try { paintDashboardDS(); } catch (_) {} }, 1500);
      } else {
        btn.disabled = false; btn.textContent = 'Approve & send';
        msgEl.style.color = '#9B2C2C';
        msgEl.textContent = (r.json && r.json.error) || r.err || ('Send failed' + (r.status ? ' (HTTP ' + r.status + ')' : '') + ' — try again.');
      }
    });
  }

  // Dashboard interactions: open a lead detail from any row/button.
  document.addEventListener('click', (e) => {
    const appr = e.target.closest('[data-dash-approve]');
    if (appr) { const mid = appr.getAttribute('data-dash-approve'); if (mid) openApprovalModal(mid); return; }
    const open = e.target.closest('[data-dash-open]');
    if (open) {
      const id = open.getAttribute('data-dash-open');
      if (id) { if (typeof window.showView === 'function') window.showView(null, 'inbox'); selectLeadId(id); }
      return;
    }
    if (e.target.closest('[data-dash-cal]')) { if (typeof window.showView === 'function') window.showView(null, 'cal'); }
  });
  document.addEventListener('crm:view', (ev) => { if (ev.detail && ev.detail.name === 'today') paintDashboardDS(); });

  function midPrice(min, max) {
    if (min && max) return (min + max) / 2;
    return min || max || 0;
  }
  // Proxy for "sat in this stage too long": no per-stage history exists yet
  // (see the audit), so age of the last update stands in for staleness.
  function isStaleLead(l) {
    if (!l || !l.updated_at) return false;
    const days = (Date.now() - new Date(l.updated_at).getTime()) / 86400000;
    return days > 14;
  }
  // stg = the column key the card lives in, so its stripe colour always
  // matches its column even when a lead's side-stage fields disagree.
  function kanCardHtml(l, stg) {
    const mid   = midPrice(l.price_min, l.price_max);
    const stage = stg || l.seller_stage || l.buyer_stage || kanCoarseKey(l) || 'new';
    const ctx   = (l.areas && l.areas[0])
      || (l.journey_stage || '').replace(/_/g, ' ')
      || (l.source ? String(l.source).replace(/_/g, ' ') : '');
    const temp  = (l.temperature || '').toLowerCase();
    const note  = temp === 'hot'
      ? '<span class="st good">Hot lead</span>'
      : (temp === 'cold' ? '<span class="st">Cooling</span>' : '');
    const stale = isStaleLead(l);
    return `
      <div class="ds-dcard${stale ? ' stale' : ''}" data-stg="${escHtml(stage)}" data-lead-id="${escHtml(l.id)}">
        <span class="stripe"></span>
        <div class="body">
          <span class="marks"><i></i><i></i><i></i><i></i></span>
          <div class="nm">${escHtml(fullName(l))}</div>
          <div class="ctx">${escHtml(ctx || '—')}</div>
          <div class="val">${mid ? `<span class="num">${escHtml(fmtUSD(mid))}</span>` : ''}${note}${l.score != null ? `<span class="st">Score ${escHtml(String(l.score))}</span>` : ''}</div>
          <div class="next">Last touch ${escHtml(fmtRel(l.updated_at))}</div>
        </div>
      </div>`;
  }

  // Buyer / Seller / Dual filter above the kanban — re-paints from cache.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-side-filter] .ds-fpill, [data-side-filter] .chip');
    if (!chip) return;
    const sel = chip.classList.contains('ds-fpill') ? '[data-side-filter] .ds-fpill' : '[data-side-filter] .chip';
    document.querySelectorAll(sel).forEach((c) => c.classList.toggle('on', c === chip));
    paintKanban(null);
  });

  async function loadLead(id) {
    const detailEl = document.querySelector('[data-lead-detail]');
    if (detailEl) detailEl.innerHTML = `<div style="padding:24px;opacity:.55;font-style:italic;">Loading…</div>`;
    const r = await window.Legacy.api(`/api/crm/lead?id=${encodeURIComponent(id)}`, { method: 'GET' });
    if (r.ok) paintLeadDetail(r.json);
    else if (detailEl) detailEl.innerHTML = `<div style="padding:24px;color:#9B2C2C;">${escHtml((r.json && r.json.error) || 'Could not load lead.')}</div>`;
  }

  function selectLeadId(id, force) {
    // `force` re-loads even if this lead is already selected — needed after an
    // in-place edit (save prefs) and when switching subsets that land back on
    // the same lead, so the detail pane + its per-paint tab handlers rebuild
    // instead of leaving a stale pane that only works after you tick away.
    if (!force && state.selectedLeadId === id) return;
    state.selectedLeadId = id;
    document.querySelectorAll('[data-lead-list] [data-lead-id]').forEach((r) => {
      r.classList.toggle('on', r.getAttribute('data-lead-id') === id);
    });
    loadLead(id);
  }

  // Re-bind window.Legacy.openLead HERE, where selectLeadId is actually in
  // scope. The stub defined in the earlier IIFE (see the openLead comment there)
  // could not see selectLeadId — different closure — so `typeof selectLeadId`
  // was 'undefined' and openLead only switched to the inbox, leaving whichever
  // lead boot had auto-selected (the most-recent one) on screen. That made every
  // People-roster / Messages click open the same wrong person. loadLead fetches
  // the contact by id, so this works for anyone, incl. archived/closed clients.
  if (window.Legacy) {
    window.Legacy.openLead = function (id) {
      if (!id) return;
      if (typeof window.showView === 'function') window.showView(null, 'inbox');
      selectLeadId(id, true);
      // Focused mode: hide the leads list so the contact + interaction data
      // fill the screen. showView() cleared it on the switch above; re-add it
      // here so opening a contact by id lands in focus. Browsing the inbox via
      // the nav (which just calls showView) stays in the normal 3-column view.
      const shell = document.querySelector('.inbox-shell');
      if (shell) shell.classList.add('contact-focus');
    };
  }

  // Leave focused mode: the in-detail "‹ All leads" button restores the list.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-focus-back]')) {
      const shell = document.querySelector('.inbox-shell');
      if (shell) shell.classList.remove('contact-focus');
    }
  });

  // Permanently delete a contact (the "Trash" option / card delete icon).
  // Returns true if the delete was started (confirmed), false if cancelled.
  function deleteLeadFlow(id, name) {
    if (!id) return false;
    if (!window.confirm(`Permanently delete ${name || 'this contact'}? This cannot be undone.`)) return false;
    window.Legacy.api('/api/crm/lead?id=' + encodeURIComponent(id), { method: 'DELETE', body: { id } }).then((r) => {
      if (r && r.ok) {
        // Drop from the in-memory roster + DOM, and clear the detail if it was open.
        if (Array.isArray(state.leads)) state.leads = state.leads.filter((l) => l.id !== id);
        if (state._leadView) state._leadView = state._leadView.filter((l) => l.id !== id);
        const row = document.querySelector(`[data-lead-list] [data-lead-id="${id}"]`);
        if (row) row.remove();
        if (state.selectedLeadId === id) {
          state.selectedLeadId = null;
          const det = document.querySelector('[data-lead-detail]');
          if (det) det.innerHTML = '<div class="ld-empty" style="padding:40px;color:var(--ink-mute);">Contact deleted.</div>';
        }
        if (window.Legacy.toast) window.Legacy.toast('Contact deleted.');
      } else {
        window.alert((r && r.json && r.json.error) || 'Could not delete the contact.');
      }
    });
    return true;
  }

  async function bootCrmInbox() {
    if (!window.Legacy || !window.Legacy.api) { setTimeout(bootCrmInbox, 50); return; }
    paintFilters();

    const [pipelineRes, inboxRes, dealsRes] = await Promise.all([
      window.Legacy.api('/api/crm/pipeline', { method: 'GET' }),
      window.Legacy.api('/api/crm/inbox?filter=all&limit=100', { method: 'GET' }),
      window.Legacy.api('/api/crm/deals', { method: 'GET' })
    ]);
    if (!pipelineRes.ok) {
      // Don't fail silently — show why, so a blank CRM is never a mystery.
      const listEl = document.querySelector('[data-lead-list]');
      const msg = (pipelineRes.json && pipelineRes.json.error) || `Pipeline failed to load (${pipelineRes.status || '?'})`;
      if (listEl) listEl.innerHTML = `<div class="lead-row" style="opacity:.7;padding:16px;"><div class="lead-content"><span class="lead-name" style="color:#9B2C2C;">Couldn't load leads</span><p class="lead-preview">${escHtml(msg)}</p></div></div>`;
      return;
    }

    const allLeads = [];
    (pipelineRes.json.stages || []).forEach((s) => s.leads.forEach((l) => allLeads.push(l)));
    allLeads.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    state.leads = allLeads;
    state.leadsById = new Map(allLeads.map((l) => [l.id, l]));

    if (inboxRes.ok) {
      const seen = new Set();
      (inboxRes.json.messages || []).forEach((m) => {
        if (!m.leads || seen.has(m.lead_id)) return;
        seen.add(m.lead_id);
        state.messageByLead.set(m.lead_id, m);
      });
    }

    paintLeadCounts();
    paintLeadList();
    paintKanban(pipelineRes.json, (dealsRes && dealsRes.ok) ? dealsRes.json : null);
    // Default landing is Today — paint the 2026 dashboard now (crm:view won't
    // fire for the already-"on" today view at boot). Uses the caches just set.
    try { paintDashboardDS(); } catch (_) {}

    // Deep-link: an alert SMS/email links to /crm.html?lead=<id>. Open that
    // exact contact (openLead fetches by id, so it works even if the lead isn't
    // in the initial roster) instead of auto-selecting the most-recent one.
    const wantLead = new URLSearchParams(location.search).get('lead');
    if (wantLead && window.Legacy && typeof window.Legacy.openLead === 'function') {
      window.Legacy.openLead(wantLead);
    } else if (allLeads.length) selectLeadId(allLeads[0].id);
    else {
      const detailEl = document.querySelector('[data-lead-detail]');
      if (detailEl) detailEl.innerHTML = `<div style="padding:32px;opacity:.55;font-style:italic;">No active leads yet. Submit a lead via the homepage to populate the CRM.</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', bootCrmInbox);

  // ---------- Import Leads modal ------------------------------------------
  const LEGACY_LEADS_URL   = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/fvyf3ftm_legacy_leads_import.csv';
  const LEGACY_CONSENT_URL = 'https://customer-assets.emergentagent.com/job_crm-wire-live/artifacts/ugrzaqww_lead_consent_flags.csv';

  function openImporter() {
    let m = document.getElementById('leg-import-modal');
    if (m) { m.style.display = 'flex'; return; }
    m = document.createElement('div');
    m.id = 'leg-import-modal';
    m.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(20,18,15,0.6);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Manrope,system-ui,sans-serif;';
    m.innerHTML = `
      <div style="background:#FAF6EC;max-width:640px;width:100%;padding:28px 32px;color:#1A1714;max-height:88vh;overflow:auto;">
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:8px;">Import</div>
        <h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:28px;margin:0 0 14px;">Import leads from CSV.</h2>
        <p style="font-size:14px;line-height:1.55;color:#3A332B;margin:0 0 18px;">Dedupes by <code>fub_id</code>, falls back to <code>email</code>. Existing rows are never touched. Preview before commit.</p>

        <details style="margin-bottom:18px;border:1px solid #D9CFB7;padding:10px 14px;background:#fff;">
          <summary style="cursor:pointer;font-weight:600;font-size:14px;">One-time legacy import (2,016 leads + 694 consent records)</summary>
          <p style="font-size:13px;color:#3A332B;margin:10px 0;">Runs the full historical import in 3 steps: delete the 2 test rows, import every lead by <code>fub_id</code>, then apply every consent flag.</p>
          <button id="leg-run-legacy" style="background:#1A1714;color:#FAF6EC;border:none;padding:10px 18px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;">Run legacy import</button>
        </details>

        <div style="font-weight:600;font-size:13px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.14em;color:#7C6A4D;">Upload your own</div>
        <input type="file" id="leg-csv-file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="margin-bottom:10px;font-size:13px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;font-size:13px;">
          <label><input type="radio" name="leg-kind" value="leads" checked> Leads</label>
          <label><input type="radio" name="leg-kind" value="consent"> Consent flags</label>
        </div>
        <div style="display:flex;gap:10px;">
          <button id="leg-preview" style="background:#fff;color:#1A1714;border:1px solid #1A1714;padding:10px 18px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;">Preview</button>
          <button id="leg-commit" style="background:#1A1714;color:#FAF6EC;border:none;padding:10px 18px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;" disabled>Commit</button>
          <button id="leg-import-close" style="margin-left:auto;background:transparent;border:none;color:#7C6A4D;cursor:pointer;font-size:13px;">Close</button>
        </div>
        <pre id="leg-import-log" style="margin-top:14px;background:#1A1714;color:#FAF6EC;padding:14px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.5;max-height:280px;overflow:auto;white-space:pre-wrap;">Awaiting action…</pre>
      </div>`;
    document.body.appendChild(m);

    const log = (msg) => { const el = m.querySelector('#leg-import-log'); el.textContent = (typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)); el.scrollTop = el.scrollHeight; };
    let stagedCsv = null;

    // Lazy-load SheetJS only if/when a non-CSV file gets uploaded.
    function loadSheetJs() {
      if (window.XLSX) return Promise.resolve(window.XLSX);
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload = () => resolve(window.XLSX);
        s.onerror = () => reject(new Error('Could not load xlsx parser. Use File → Save As → CSV in Excel and try again.'));
        document.head.appendChild(s);
      });
    }

    async function fileToCsv(file) {
      const name = (file.name || '').toLowerCase();
      const buf  = await file.arrayBuffer();
      const u8   = new Uint8Array(buf);

      // Sniff first bytes — real .xlsx is a ZIP starting with 'PK' (0x50 0x4B).
      // If it doesn't look like a ZIP, treat the file as plain text regardless
      // of its extension (handles CSVs accidentally saved with .xlsx).
      const looksLikeXlsx = u8[0] === 0x50 && u8[1] === 0x4B && (name.endsWith('.xlsx') || name.endsWith('.xls'));

      if (looksLikeXlsx) {
        log('Converting Excel → CSV in the browser…');
        const XLSX = await loadSheetJs();
        const wb   = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_csv(sheet);
      }

      // Plain CSV (or CSV mislabeled .xlsx) — decode as UTF-8.
      return new TextDecoder('utf-8').decode(u8);
    }

    m.querySelector('#leg-import-close').onclick = () => { m.style.display = 'none'; };
    m.querySelector('#leg-csv-file').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try {
        stagedCsv = await fileToCsv(f);
        const head = stagedCsv.split('\n').slice(0, 3).join('\n');
        log(`Loaded ${f.name} (${stagedCsv.length.toLocaleString()} chars).\n\nFirst rows:\n${head}\n\n← Click Preview to dry-run, then Commit to import.`);
        m.querySelector('#leg-commit').disabled = false;
      } catch (e) {
        log(`Could not read file: ${e.message}`);
      }
    };
    m.querySelector('#leg-preview').onclick = async () => {
      if (!stagedCsv) return log('Choose a file first.');
      const kind = m.querySelector('input[name="leg-kind"]:checked').value;
      log('Previewing…');
      const r = await window.Legacy.api('/api/crm/import-leads', { body: { kind, csv: stagedCsv, dry_run: true } });
      log(r.json);
    };
    m.querySelector('#leg-commit').onclick = async () => {
      if (!stagedCsv) return;
      const kind = m.querySelector('input[name="leg-kind"]:checked').value;
      log('Committing…');
      const r = await window.Legacy.api('/api/crm/import-leads', { body: { kind, csv: stagedCsv, dry_run: false } });
      log(r.json);
    };
    m.querySelector('#leg-run-legacy').onclick = async () => {
      log('Step 1/3 · Deleting test rows…');
      const r1 = await window.Legacy.api('/api/crm/import-leads', { body: { kind: 'delete_test' } });
      log({ step: '1/3 delete_test', ...r1.json });
      await new Promise((res) => setTimeout(res, 400));
      log('Step 2/3 · Importing 2,016 legacy leads from artifact URL…');
      const r2 = await window.Legacy.api('/api/crm/import-leads', { body: { kind: 'leads', csv_url: LEGACY_LEADS_URL } });
      log({ step: '2/3 import_leads', ...r2.json });
      await new Promise((res) => setTimeout(res, 400));
      log('Step 3/3 · Applying 694 consent flags…');
      const r3 = await window.Legacy.api('/api/crm/import-leads', { body: { kind: 'consent', csv_url: LEGACY_CONSENT_URL } });
      log({ step: '3/3 apply_consent', ...r3.json });
      log({ done: true, summary: { delete_test: r1.json, import_leads: r2.json, apply_consent: r3.json } });
    };
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-open-importer]');
    if (trigger) { e.preventDefault(); openImporter(); }
    const signOut = e.target.closest('[data-sign-out]');
    if (signOut) {
      e.preventDefault();
      fetch('/api/auth/session', { method: 'DELETE', credentials: 'include' })
        .finally(() => { window.location.href = '/crm.html'; });
    }
    const testEmail = e.target.closest('[data-send-test-email]');
    if (testEmail) {
      e.preventDefault();
      const to = prompt('Send a Resend test email to which address?');
      if (!to) return;
      window.Legacy.api('/api/crm/test-email', { body: { to } }).then((r) => {
        if (r.ok) alert(`✓ Sent.\n\nFrom: ${r.json.from_name} <${r.json.from_email}>\nReply-to: ${r.json.reply_to}\nResend id: ${r.json.resend?.id || '(skipped — RESEND_API_KEY missing)'}\n\nCheck the inbox of ${to}.`);
        else      alert(`✗ Failed: ${r.json?.error || r.status}`);
      });
    }
  });
})();

/* ===========================================================================
 * CRM Sequences + Calendar tabs (APPEND-ONLY)
 * ---------------------------------------------------------------------------
 * Scoped to crm.html. Paints the two previously-static tabs from live data:
 *   GET /api/crm/sequences  -> .seq-list-card [data-seq-list] + .seq-editor-card
 *   GET /api/crm/calendar   -> the .cal-grid week board + week nav
 * Self-contained; leaves the static mock in place if a fetch fails (e.g. the
 * auth gate is showing a sign-in card).
 * ======================================================================== */
(function () {
  'use strict';
  if (!/\/crm\.html$/.test(location.pathname)) return;

  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const getJSON = async (url) => {
    let res;
    try { res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' }); }
    catch (_) { return null; }
    if (!res.ok) return null;
    try { return await res.json(); } catch (_) { return null; }
  };
  const sendJSON = async (url, method, bodyObj) => {
    let res;
    try {
      res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(bodyObj) });
    } catch (e) { return { ok: false, status: 0, json: { error: e.message || 'Network error' } }; }
    let json = null; try { json = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, json };
  };

  const seqState = { list: [], selectedId: null };

  // Inline modal styling (matches the importer / link-deal modals).
  const M_INPUT = 'font:inherit;font-size:14px;color:#1A1714;background:#fff;border:1px solid #D9CFB7;padding:8px 10px;width:100%;box-sizing:border-box;';
  const M_LAB   = 'font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#7C6A4D;display:block;margin-bottom:4px;';
  const M_INK   = 'background:#1A1714;color:#FAF6EC;border:none;padding:11px 20px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;';
  const M_GHOST = 'background:transparent;border:none;color:#7C6A4D;cursor:pointer;font-size:13px;';
  const M_MINI  = 'background:#F3EEDF;border:1px solid #D9CFB7;color:#3A332B;padding:7px 14px;font-size:12.5px;cursor:pointer;';

  function modalShell(title, intro) {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-crm-modal', '');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(20,18,15,0.6);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Manrope,system-ui,sans-serif;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#FAF6EC;max-width:600px;width:100%;padding:26px 30px;color:#1A1714;max-height:92vh;overflow:auto;';
    box.innerHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:8px;">Legacy CRM</div>
      <h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:26px;margin:0 0 6px;">${esc(title)}</h2>
      ${intro ? `<p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0 0 16px;">${esc(intro)}</p>` : ''}
      <div data-modal-body></div>
      <div data-modal-error style="color:#9B2C2C;font-size:13px;margin-top:10px;min-height:18px;"></div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return { overlay, body: box.querySelector('[data-modal-body]'), err: box.querySelector('[data-modal-error]'), close: () => overlay.remove() };
  }

  // ---- Sequences ---------------------------------------------------------
  function seqMeta(s) {
    const bits = [`${s.step_count} step${s.step_count === 1 ? '' : 's'}`,
                  `${s.duration_days} day${s.duration_days === 1 ? '' : 's'}`, s.channels];
    if (s.enrolled) bits.push(`${s.enrolled} enrolled`);
    return bits.join(' · ');
  }
  function paintSeqEditor(editor, s) {
    if (!s) { editor.innerHTML = '<span class="eyebrow">Editing</span><p class="sub" style="margin-top:8px;">Select a sequence.</p>'; return; }
    const steps = (s.steps || []).map((st) => {
      const snip = st.subject ? `“${esc(st.subject)}” · ${esc(st.body)}` : esc(st.body);
      return `<div class="seq-step">
          <div class="seq-step-num">${esc(st.step_number)}</div>
          <div class="seq-step-body">
            <div class="seq-step-when">${esc(st.when)}</div>
            <p class="seq-step-snip">${snip}</p>
          </div>
          <span class="seq-step-ch">${esc(st.channel === 'SMS' ? 'SMS' : 'Email')}</span>
        </div>`;
    }).join('');
    const sub = s.description || `${s.step_count} messages over ${s.duration_days} days. Queued as drafts for your approval.`;
    editor.innerHTML = `
      <span class="eyebrow">Editing</span>
      <h3 style="margin-top: 6px;">${esc(s.name)}</h3>
      <p class="sub">${esc(sub)}</p>
      ${steps || '<p class="sub" style="opacity:.6;">No steps defined.</p>'}
      <div style="display: flex; gap: 8px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--rule);">
        <button class="btn btn-ghost btn-sm">${esc(s.step_count)} step${s.step_count === 1 ? '' : 's'}${s.trigger_type ? ' · ' + esc(s.trigger_type.replace(/_/g, ' ')) : ''}</button>
        <button class="btn btn-ink btn-sm" style="flex: 1;" data-seq-edit>Edit sequence →</button>
      </div>`;
  }
  async function loadSequences() {
    const list = document.querySelector('[data-seq-list]');
    const editor = document.querySelector('[data-seq-editor]');
    if (!list) return;
    const data = await getJSON('/api/crm/sequences');
    if (!data || !Array.isArray(data.sequences)) return; // keep static mock
    const seqs = data.sequences;
    seqState.list = seqs;
    if (!seqs.length) {
      seqState.selectedId = null;
      list.innerHTML = '<div class="seq-row" style="opacity:.6;"><div><div class="name">No sequences yet</div><div class="meta">Click “+ New sequence” to create your first drip.</div></div></div>';
      if (editor) paintSeqEditor(editor, null);
      return;
    }
    seqState.selectedId = String(seqs[0].id);
    list.innerHTML = seqs.map((s, i) => `
      <div class="seq-row${i === 0 ? ' on' : ''}" data-seq-id="${esc(s.id)}">
        <div>
          <div class="name">${esc(s.name)}</div>
          <div class="meta">${esc(seqMeta(s))}</div>
        </div>
        <div class="stat"><strong>${s.reply_rate == null ? '—' : s.reply_rate + '%'}</strong>Reply rate</div>
        <div class="toggle${s.active ? ' on' : ''}" title="${s.active ? 'Active' : 'Paused'}"></div>
      </div>`).join('');
    if (editor) paintSeqEditor(editor, seqs[0]);
    list.querySelectorAll('[data-seq-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.toggle')) return; // visual toggle only (no write endpoint)
        list.querySelectorAll('.seq-row').forEach((r) => r.classList.remove('on'));
        row.classList.add('on');
        seqState.selectedId = row.getAttribute('data-seq-id');
        const s = seqs.find((x) => String(x.id) === seqState.selectedId);
        if (editor) paintSeqEditor(editor, s);
      });
    });
  }

  // ---- Calendar (agenda + full-day scrollable week) ----------------------
  const CAL_ROW_H = 48; // px per hour — must match .calw-hour / .calw-line in crm.css
  // Per-deal colour fallback — MUST mirror LGC_DEAL_PALETTE (the source of truth).
  // Bold, distinct hues per the "every deal its own bold colour" rule above.
  const DEAL_PALETTE = [
    { border: '#D32F2F', bg: '#FADEDE' }, { border: '#EF6C00', bg: '#FCE7D6' },
    { border: '#F9A825', bg: '#FDF1D3' }, { border: '#2E7D32', bg: '#DFEFE1' },
    { border: '#00838F', bg: '#D5ECEE' }, { border: '#1565C0', bg: '#DBE8F6' },
    { border: '#4527A0', bg: '#E4DFF2' }, { border: '#8E24AA', bg: '#F1DFF5' },
    { border: '#C2185B', bg: '#F9DBE8' }, { border: '#5D4037', bg: '#E8DED9' }
  ];
  function dealColorFor(key) { return (key && cal.dealColor[key]) || null; }
  const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cal = { week: 0, view: 'week', days: [], events: [], label: '', deals: [], dealFilter: '', dealColor: {} };
  const evByKey = (key) => cal.events.find((e) => `${e.source}:${e.id}` === key);
  const monthName = (d) => { const m = /^\d{4}-(\d{2})-\d{2}$/.exec(d || ''); return m ? CAL_MONTHS[+m[1] - 1] : ''; };

  async function loadCalendar(offset) {
    if (offset != null) cal.week = offset;
    const agendaEl = document.querySelector('[data-cal-agenda]');
    if (!agendaEl) return;
    const data = await getJSON(`/api/crm/calendar?week=${cal.week}&span=${cal.view === 'month' ? 5 : 1}`);
    if (!data || !Array.isArray(data.days)) return;
    cal.days = data.days; cal.events = data.events || []; cal.label = data.week_label || '';
    cal.deals = data.deals || [];
    cal.dealColor = {};
    await window.LegacyDealColors.ready();
    cal.deals.forEach((d) => { cal.dealColor[d.key] = window.LegacyDealColors.get(d.key) || DEAL_PALETTE[0]; });
    populateDealFilter();
    const title = document.querySelector('[data-cal-title]');
    if (title) title.textContent = cal.label;
    fillCalStrip();
    // Keep the nav/tab "this week" badge accurate. It's otherwise set from a
    // separate counts call that can read 0 while the week actually has events;
    // the calendar itself is the source of truth for the current week.
    if (cal.week === 0) {
      document.querySelectorAll('[data-roster-calendar],[data-roster-calendar-week]')
        .forEach((el) => { el.textContent = String(cal.events.length); });
    }
    renderCalendar();
  }
  function stageShort(s) { return s === 'pending' ? 'in escrow' : s === 'offer' ? 'offer' : s === 'listing' ? 'on market' : s === 'preparing' ? 'preparing' : (s || ''); }
  // Events shown under the current "view by deal" filter.
  function visibleEvents() { return cal.dealFilter ? cal.events.filter((e) => e.deal_key === cal.dealFilter) : cal.events; }

  // (Re)build the by-deal dropdown from the loaded deals, preserving selection.
  function populateDealFilter() {
    const sel = document.querySelector('[data-cal-deal]');
    if (!sel) return;
    if (cal.dealFilter && !cal.deals.some((d) => d.key === cal.dealFilter)) cal.dealFilter = '';
    let html = '<option value="">All deals</option>';
    cal.deals.forEach((d) => {
      const label = (d.address || d.key) + (d.stage ? ' · ' + stageShort(d.stage) : '');
      html += `<option value="${esc(d.key)}"${d.key === cal.dealFilter ? ' selected' : ''}>${esc(label)}</option>`;
    });
    sel.innerHTML = html;
  }

  // Colour legend — one swatch per deal that has events in the current view.
  function renderLegend() {
    const el = document.querySelector('[data-cal-legend]');
    if (!el) return;
    const order = [], seen = {};
    visibleEvents().forEach((e) => { if (e.deal_key && !seen[e.deal_key]) { seen[e.deal_key] = 1; order.push(e.deal_key); } });
    const swatches = order.map((k) => {
      const c = cal.dealColor[k]; const d = cal.deals.find((x) => x.key === k);
      const label = (d && d.address) || k;
      return `<span class="lg${cal.dealFilter === k ? ' on' : ''}" data-legend-deal="${esc(k)}"><span class="sw" style="background:${c ? c.border : '#8a8f95'}"></span>${esc(label)}</span>`;
    }).join('');
    el.innerHTML = `<span style="font-weight:600;color:var(--ink)">Colour = the deal it belongs to</span>${swatches}<span class="amber-note"><i></i>Amber block = a deadline</span>`;
  }

  // Week-view stat strip + deadline alert (5A). Computed from the loaded week.
  function fillCalStrip() {
    const evs = cal.events || [];
    const showings = evs.filter((e) => /show|tour/i.test((e.kind_label || '') + ' ' + (e.cls || ''))).length;
    const deadlines = evs.filter((e) => e.cls === 'coe' || e.cls === 'deadline').length;
    const busy = {}; evs.forEach((e) => { busy[e.day] = (busy[e.day] || 0) + 1; });
    let freeDay = '';
    (cal.days || []).forEach((d, i) => { if (!busy[i] && !freeDay) freeDay = d.dow; });
    const setT = (sel, v) => { const el = document.querySelector(sel); if (el) el.textContent = v; };
    setT('[data-cal-booked]', String(evs.length));
    setT('[data-cal-booked-sub]', `${evs.length} thing${evs.length === 1 ? '' : 's'} booked`);
    setT('[data-cal-showings]', String(showings));
    setT('[data-cal-deadlines]', String(deadlines));
    setT('[data-cal-free]', freeDay || 'None');
    const al = document.querySelector('[data-cal-alert]');
    if (al) {
      if (deadlines > 0) { al.style.display = ''; setT('[data-cal-alert-text]', `${deadlines} dated deadline${deadlines === 1 ? '' : 's'} this week`); }
      else al.style.display = 'none';
    }
  }

  function renderMonth() {
    const el = document.querySelector('[data-cal-month]');
    if (!el) return;
    const byDate = {};
    visibleEvents().forEach((ev) => { (byDate[ev.date] = byDate[ev.date] || []).push(ev); });
    const cells = cal.days.map((d) => {
      const evs = byDate[d.date] || [];
      const shown = evs.slice(0, 3).map((ev) => {
        const c = dealColorFor(ev.deal_key);
        return `<span class="calm-ev" data-ev-key="${esc(ev.source + ':' + ev.id)}" style="${c ? `border-left-color:${c.border};background:${c.bg};` : ''}" title="${esc(ev.title || '')}">${esc((ev.time_label ? ev.time_label + ' ' : '') + (ev.title || ''))}</span>`;
      }).join('');
      const more = evs.length > 3 ? `<span class="calm-more">+${evs.length - 3} more</span>` : '';
      const thisMonth = cal.days[7] ? d.month === cal.days[7].month : true;
      return `<div class="calm-cell${d.is_today ? ' today' : ''}${thisMonth ? '' : ' other'}"><span class="calm-num">${d.num}</span>${shown}${more}</div>`;
    }).join('');
    el.innerHTML = `<div class="calm-head">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => `<span>${d}</span>`).join('')}</div><div class="calm-grid">${cells}</div>`;
  }

  function renderCalendar() {
    const agendaEl = document.querySelector('[data-cal-agenda]');
    const weekEl = document.querySelector('[data-cal-week]');
    const monthEl = document.querySelector('[data-cal-month]');
    if (!agendaEl || !weekEl) return;
    if (monthEl) monthEl.style.display = cal.view === 'month' ? '' : 'none';
    if (cal.view === 'month') { agendaEl.style.display = 'none'; weekEl.style.display = 'none'; renderLegend(); renderMonth(); return; }
    agendaEl.style.display = ''; weekEl.style.display = '';
    renderLegend();
    document.querySelectorAll('[data-cal-view]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-cal-view') === cal.view));
    if (cal.view === 'week') { agendaEl.style.display = 'none'; weekEl.style.display = ''; renderWeek(weekEl); }
    else { weekEl.style.display = 'none'; agendaEl.style.display = ''; renderAgenda(agendaEl); }
  }
  function renderAgenda(root) {
    const evList = visibleEvents();
    if (!evList.length) {
      const none = cal.dealFilter ? 'No events for this deal this week.' : 'Nothing scheduled this week.';
      root.innerHTML = `<div class="cal-ag-empty">${none}<br><span style="font-size:12px;">Use “+ New event” to add a tour, listing appt, showing, inspection, or block.</span></div>`;
      return;
    }
    const byDay = {};
    evList.forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
    let html = '';
    cal.days.forEach((d, i) => {
      const evs = byDay[i] || [];
      // Keep TODAY in the list even when it's empty, so "Today" always lands
      // somewhere; other empty days are still skipped.
      if (!evs.length && !d.is_today) return;
      html += `<div class="cal-ag-day${d.is_today ? ' is-today' : ''}"><div class="cal-ag-dayhead${d.is_today ? ' today' : ''}">${d.is_today ? '<span class="cal-ag-todaypill">Today</span>' : ''}<span class="cal-ag-dow">${esc(d.dow)}</span><span class="cal-ag-date">${esc(monthName(d.date))} ${esc(d.num)}</span>${evs.length ? `<span class="cal-ag-count">${evs.length}</span>` : ''}</div><div class="cal-ag-cards">`;
      if (!evs.length) { html += '<div class="cal-ag-none">Nothing scheduled today.</div></div></div>'; return; }
      evs.forEach((e) => {
        const c = dealColorFor(e.deal_key);
        // Events tied to a client (or shared to a deal) get a visibility toggle:
        // flip it on to add the event to what that client / both parties see.
        const toggle = (e.lead_id || e.deal_id) ? `<label class="lp-toggle cal-ag-toggle" title="${e.shared ? 'Shown in the client’s portal' : 'Add this to what the client sees'}" onclick="event.stopPropagation()">
            <input type="checkbox" data-cal-share data-kind="${esc(e.source)}" data-id="${esc(e.id)}" ${e.shared ? 'checked' : ''}>
            <span class="lp-toggle-track"></span>
            <span class="lp-toggle-cap">${e.shared ? 'Visible' : 'Private'}</span>
          </label>` : '';
        const subBits = [];
        if (e.sub && e.sub !== e.title) subBits.push(esc(e.sub));
        if (e.deal_address && (!e.sub || String(e.sub).indexOf(e.deal_address) < 0)) subBits.push(esc(e.deal_address));
        const subHtml = subBits.length ? `<div class="cal-ag-c-sub">${subBits.join(' · ')}</div>` : '';
        const timeText = e.all_day ? 'All day' : `${esc(e.time_label)}–${esc(e.end_label)}`;
        const isDeadline = e.cls === 'coe' || e.cls === 'deadline';
        html += `<div class="cal-ag-card${isDeadline ? ' cal-ag-card--deadline' : ''}" data-ev-key="${esc(e.source)}:${esc(e.id)}"${c ? ` style="border-top-color:${c.border}"` : ''}>
          <div class="cal-ag-c-top"><span class="cal-ag-c-time">${timeText}</span><span class="cal-ag-c-kind">${esc(e.kind_label || '')}</span></div>
          <div class="cal-ag-c-title">${esc(e.title)}</div>
          ${subHtml}
          ${toggle}
        </div>`;
      });
      html += '</div></div>';
    });
    root.innerHTML = html;
    // On the current week, bring today into view so "Today" always lands on it.
    if (cal.week === 0) { const t = root.querySelector('.cal-ag-day.is-today'); if (t) t.scrollIntoView({ block: 'nearest' }); }

    // Delegated visibility toggle (wired once) — flips a calendar event between
    // internal and client-visible via the shared wire-guarded endpoint.
    if (!root._shareWired) {
      root._shareWired = true;
      root.addEventListener('change', async (ev) => {
        const cb = ev.target.closest('[data-cal-share]'); if (!cb) return;
        const kind = cb.getAttribute('data-kind'), id = cb.getAttribute('data-id');
        const now = cb.checked;
        const cap = cb.parentElement.querySelector('.lp-toggle-cap');
        cb.disabled = true;
        const r = await window.Legacy.api('/api/crm/visibility', { method: 'POST', body: { kind, id, visibility: now ? 'client' : 'internal' } });
        cb.disabled = false;
        const say = (m, ok) => { if (window.Legacy && window.Legacy.toast) window.Legacy.toast(m, ok); };
        if (r.ok) { if (cap) cap.textContent = now ? 'Visible' : 'Private'; say(now ? 'Added to the client’s portal.' : 'Hidden from the client.'); }
        else { cb.checked = !now; if (cap) cap.textContent = cb.checked ? 'Visible' : 'Private'; say((r.json && r.json.error) || 'Could not change visibility.', false); }
      });
    }
  }
  // 5A week: an agenda per day across 7 columns (not time-positioned). A deal's
  // colour rides the left stripe; a dated deadline gets the amber fill.
  function renderWeek(root) {
    const days = cal.days || [];
    const byDay = {};
    visibleEvents().forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
    const isWeekend = (dow) => /^(sat|sun)/i.test(dow || '');
    let cols = '';
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const evs = (byDay[i] || []).slice().sort((a, b) =>
        (a.all_day ? 0 : 1) - (b.all_day ? 0 : 1) ||
        ((a.hour || 0) * 60 + (a.minute || 0)) - ((b.hour || 0) * 60 + (b.minute || 0)));
      const body = evs.length ? evs.map((e) => {
        const c = dealColorFor(e.deal_key);
        const stripe = c ? c.border : '#8a8f95';
        const isDl = e.cls === 'coe' || e.cls === 'deadline';
        const bits = [];
        if (e.sub) bits.push(e.sub);
        if (e.deal_address && bits.indexOf(e.deal_address) < 0) bits.push(e.deal_address);
        const ctx = bits.join(' · ');
        const key = `${esc(e.source)}:${esc(e.id)}`;
        if (isDl) {
          return `<div class="ds-caldl" data-ev-key="${key}"><div class="tm">${e.all_day ? 'Due end of day' : 'Due ' + esc(e.time_label)}</div><div class="ti">${esc(e.title)}</div>${ctx ? `<div class="tm" style="font-weight:400;">${esc(ctx)}</div>` : ''}</div>`;
        }
        return `<div class="ds-calev" data-ev-key="${key}" style="--_c:${stripe}"><span class="tm">${e.all_day ? 'All day' : esc(e.time_label)}</span><span class="ti">${esc(e.title)}</span>${ctx ? `<span class="cx">${esc(ctx)}</span>` : ''}</div>`;
      }).join('') : '<div class="ds-calempty">Nothing booked.</div>';
      cols += `<div class="ds-calday${d.is_today ? ' today' : ''}${isWeekend(d.dow) ? ' weekend' : ''}">
        <div class="ds-calday-h"><span class="dow">${esc(d.dow)}</span><span class="num">${esc(d.num)}</span></div>
        <div class="ds-calday-body">${body}</div>
      </div>`;
    }
    root.innerHTML = `<div class="ds-calweek-wrap"><div class="ds-calweek">${cols}</div></div>`;
    // The week grid scrolls horizontally on narrow screens — pull today's column
    // into view so "Today" actually shows today instead of leaving it off-screen.
    if (cal.week === 0) {
      const wrap = root.querySelector('.ds-calweek-wrap'), t = root.querySelector('.ds-calday.today');
      if (wrap && t) wrap.scrollLeft = Math.max(0, t.offsetLeft - wrap.clientLeft - (wrap.clientWidth - t.offsetWidth) / 2);
    }
  }
  function wireCalendarChrome() {
    const prev = document.querySelector('[data-cal-prev]');
    const next = document.querySelector('[data-cal-next]');
    const today = document.querySelector('[data-cal-today]');
    const step = () => (cal.view === 'month' ? 5 : 1);
    if (prev)  prev.addEventListener('click', () => loadCalendar(cal.week - step()));
    if (next)  next.addEventListener('click', () => loadCalendar(cal.week + step()));
    if (today) today.addEventListener('click', () => loadCalendar(0));
    document.querySelectorAll('[data-cal-view]').forEach((b) => {
      b.addEventListener('click', () => {
        const wasMonth = cal.view === 'month';
        cal.view = b.getAttribute('data-cal-view');
        document.querySelectorAll('[data-cal-view]').forEach((x) => x.classList.toggle('on', x === b));
        const isMonth = cal.view === 'month';
        if (isMonth !== wasMonth) { loadCalendar(cal.week); return; }   // span changes → refetch
        const a = document.querySelector('[data-cal-agenda]'), w = document.querySelector('[data-cal-week]');
        if (a) a.style.display = ''; if (w) w.style.display = '';
        renderCalendar();
      });
    });
    // View-by-deal dropdown → filter the calendar to one deal.
    const dealSel = document.querySelector('[data-cal-deal]');
    if (dealSel) dealSel.addEventListener('change', () => { cal.dealFilter = dealSel.value || ''; renderCalendar(); });
    // Clicking a legend swatch toggles that deal as the filter.
    const legend = document.querySelector('[data-cal-legend]');
    if (legend) legend.addEventListener('click', (e) => {
      const it = e.target.closest('[data-legend-deal]'); if (!it) return;
      const k = it.getAttribute('data-legend-deal');
      cal.dealFilter = (cal.dealFilter === k) ? '' : k;
      const sel = document.querySelector('[data-cal-deal]'); if (sel) sel.value = cal.dealFilter;
      renderCalendar();
    });
  }

  // ---- Sequence authoring modal (create / edit) --------------------------
  function stepRowHtml(step) {
    const dh = step ? (Number(step.delay_hours) || 0) : 0;
    const useDays = dh > 0 && dh % 24 === 0;
    const dval = useDays ? dh / 24 : dh;
    const unit = useDays ? 'days' : 'hours';
    const ch = step ? String(step.channel || 'email').toLowerCase() : 'email';
    const subj = step ? (step.subject || '') : '';
    const body = step ? (step.body || '') : '';
    return `<div data-step-row style="border:1px solid #E4DAC4;padding:10px;margin-bottom:8px;background:#fff;">
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:end;flex-wrap:wrap;">
        <div style="flex:0 0 64px;"><label style="${M_LAB}">Delay</label><input data-s-delay type="number" min="0" value="${esc(dval)}" style="${M_INPUT}"></div>
        <div style="flex:0 0 84px;"><label style="${M_LAB}">Unit</label><select data-s-unit style="${M_INPUT}"><option value="hours"${unit === 'hours' ? ' selected' : ''}>hours</option><option value="days"${unit === 'days' ? ' selected' : ''}>days</option></select></div>
        <div style="flex:0 0 84px;"><label style="${M_LAB}">Channel</label><select data-s-ch style="${M_INPUT}"><option value="email"${ch === 'email' ? ' selected' : ''}>Email</option><option value="sms"${ch === 'sms' ? ' selected' : ''}>SMS</option></select></div>
        <div style="flex:1;min-width:120px;"><label style="${M_LAB}">Subject <span style="text-transform:none;letter-spacing:0;">(email)</span></label><input data-s-subj value="${esc(subj)}" style="${M_INPUT}"></div>
        <button type="button" data-s-remove title="Remove step" style="background:none;border:none;color:#9B2C2C;font-size:20px;cursor:pointer;line-height:1;padding:0 2px;">×</button>
      </div>
      <textarea data-s-body rows="2" placeholder="What this message should say…" style="${M_INPUT}">${esc(body)}</textarea>
    </div>`;
  }
  function openSeqModal(seq) {
    const isEdit = !!seq;
    const m = modalShell(isEdit ? 'Edit sequence' : 'New sequence',
      'Each step is queued as a draft for your approval — never auto-sent.');
    const triggers = [['new_lead', 'New lead'], ['open_house', 'Open house'], ['price_drop', 'Price drop'], ['radio_silence', 'Radio silence'], ['manual', 'Manual']];
    m.body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div><label style="${M_LAB}">Name</label><input data-f-name value="${esc(seq ? seq.name : '')}" style="${M_INPUT}"></div>
        <div><label style="${M_LAB}">Description</label><input data-f-desc value="${esc(seq ? seq.description : '')}" style="${M_INPUT}"></div>
        <div style="display:flex;gap:10px;align-items:end;">
          <div style="flex:1;"><label style="${M_LAB}">Trigger</label><select data-f-trigger style="${M_INPUT}">${triggers.map(([v, l]) => `<option value="${v}"${seq && seq.trigger_type === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#3A332B;padding-bottom:9px;"><input data-f-active type="checkbox"${!seq || seq.active ? ' checked' : ''}> Active</label>
        </div>
        <div style="margin-top:4px;"><label style="${M_LAB}">Steps</label><div data-steps></div>
          <button type="button" data-add-step style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#1A1714;background:transparent;border:1px dashed #B89A5C;padding:9px;width:100%;cursor:pointer;">+ Add step</button>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
          <button type="button" data-save style="${M_INK}">${isEdit ? 'Save changes' : 'Create sequence'}</button>
          <button type="button" data-cancel style="${M_GHOST};margin-left:auto;">Cancel</button>
        </div>
      </div>`;
    const stepsBox = m.body.querySelector('[data-steps]');
    const addStep = (s) => stepsBox.insertAdjacentHTML('beforeend', stepRowHtml(s));
    (seq && seq.steps && seq.steps.length ? seq.steps : [null]).forEach(addStep);
    m.body.querySelector('[data-add-step]').addEventListener('click', () => addStep(null));
    stepsBox.addEventListener('click', (e) => {
      if (!e.target.closest('[data-s-remove]')) return;
      if (stepsBox.querySelectorAll('[data-step-row]').length > 1) e.target.closest('[data-step-row]').remove();
    });
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    const saveBtn = m.body.querySelector('[data-save]');
    saveBtn.addEventListener('click', async () => {
      const name = m.body.querySelector('[data-f-name]').value.trim();
      if (!name) { m.err.textContent = 'Name is required.'; return; }
      const steps = [...stepsBox.querySelectorAll('[data-step-row]')].map((row) => {
        const delay = parseFloat(row.querySelector('[data-s-delay]').value) || 0;
        const unit = row.querySelector('[data-s-unit]').value;
        const ch = row.querySelector('[data-s-ch]').value;
        const subj = row.querySelector('[data-s-subj]').value.trim();
        return { delay_hours: Math.round(delay * (unit === 'days' ? 24 : 1)), channel: ch,
          subject_template: ch === 'sms' ? null : (subj || null), body_template: row.querySelector('[data-s-body]').value.trim() };
      });
      if (steps.some((s) => !s.body_template)) { m.err.textContent = 'Every step needs a message body.'; return; }
      const payload = { name, description: m.body.querySelector('[data-f-desc]').value.trim(),
        trigger_type: m.body.querySelector('[data-f-trigger]').value, active: m.body.querySelector('[data-f-active]').checked, steps };
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; m.err.textContent = '';
      const r = isEdit ? await sendJSON('/api/crm/sequences', 'PATCH', { id: seq.id, ...payload })
                       : await sendJSON('/api/crm/sequences', 'POST', payload);
      if (r.ok && r.json && r.json.sequence) { m.close(); loadSequences(); }
      else { m.err.textContent = (r.json && r.json.error) || 'Save failed.'; saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save changes' : 'Create sequence'; }
    });
  }

  // ---- Calendar create / edit / detail modals ---------------------------
  function mondayOf(dt) { const x = new Date(dt); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }

  // A reliable time picker: a <select> of 15-minute slots. The native
  // <input type=time> was unusable on the phone (only Cancel/Clear showed, no
  // way to set a time), so appointments couldn't be saved. Values are "HH:MM"
  // (24h) to match the API; labels are friendly 12-hour.
  function timeOptionsHtml(selected) {
    let out = '', sel = selected || '';
    for (let h = 0; h < 24; h++) {
      for (let mm = 0; mm < 60; mm += 15) {
        const v = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        const h12 = (h % 12) || 12, ap = h < 12 ? 'AM' : 'PM';
        out += `<option value="${v}"${v === sel ? ' selected' : ''}>${h12}:${String(mm).padStart(2, '0')} ${ap}</option>`;
      }
    }
    return out;
  }
  // Sensible default (next quarter hour, min 8:00 AM) so a new event opens ready.
  function defaultTimeSlot() {
    const n = new Date(); let h = n.getHours(), mm = Math.ceil(n.getMinutes() / 15) * 15;
    if (mm === 60) { mm = 0; h += 1; }
    if (h < 8) { h = 8; mm = 0; }
    if (h > 20) { h = 9; mm = 0; }
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function openEventCreate(prefill) {
    prefill = prefill || {};
    const m = modalShell('Add to calendar', 'A tour is tied to a client; a listing appt, showing, follow-up, inspection, call, or block is a general event (add a client email to share it to their portal).');
    m.body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div><label style="${M_LAB}">Event type</label><select data-f-kind style="${M_INPUT}">
          <option value="tour">Client tour</option>
          <option value="listing_appt">Listing appt</option>
          <option value="showing">Showing</option>
          <option value="walkthrough">Walkthrough</option>
          <option value="follow_up">Follow-up</option>
          <option value="inspection">Inspection</option>
          <option value="appraisal">Appraisal</option>
          <option value="call">Call</option>
          <option value="block">Block / personal</option>
          <option value="open">Open house</option>
          <option value="meeting">Meeting</option></select></div>
        <div><label style="${M_LAB}">Client</label>
          <input data-f-clientsearch placeholder="Search your contacts by name, email, phone…" style="${M_INPUT}" autocomplete="off">
          <div data-f-clientresults style="position:relative;"></div>
        </div>
        <div data-tour-fields style="display:flex;flex-direction:column;gap:10px;">
          <div><label style="${M_LAB}">Client email</label><input data-f-email type="email" placeholder="client@example.com" style="${M_INPUT}"></div>
          <div style="display:flex;gap:10px;">
            <div style="flex:1;"><label style="${M_LAB}">First name</label><input data-f-first style="${M_INPUT}"></div>
            <div style="flex:1;"><label style="${M_LAB}">Last name</label><input data-f-last style="${M_INPUT}"></div>
          </div>
          <div><label style="${M_LAB}">Tour type</label><select data-f-type style="${M_INPUT}"><option value="in_person">In person</option><option value="video">Video</option></select></div>
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#3A332B;line-height:1.4;"><input data-f-invite type="checkbox" style="margin-top:3px;"> Email the client a calendar invite now</label>
        </div>
        <div data-appt-fields style="display:none;flex-direction:column;gap:10px;">
          <div data-insp-wrap style="display:none;flex-direction:column;gap:8px;">
            <label style="${M_LAB}">Inspections <span style="text-transform:none;letter-spacing:0;">(add as many as you like — each with its own time; they all use the date below)</span></label>
            <div data-insp-list style="display:flex;flex-direction:column;gap:8px;"></div>
            <button type="button" data-insp-add style="align-self:flex-start;background:transparent;border:1px dashed #B9A98A;color:#6A5A3C;padding:7px 12px;font-size:12.5px;cursor:pointer;">+ Add another inspection</button>
          </div>
          <div><label style="${M_LAB}">Title <span style="text-transform:none;letter-spacing:0;">(optional)</span></label><input data-f-title placeholder="Auto-named from the type if left blank" style="${M_INPUT}"></div>
          <div data-showing-fields style="display:none;flex-direction:column;gap:10px;">
            <div style="font-size:12px;color:#6A5A3C;background:#F3EEDF;border:1px solid #E4DAC1;padding:8px 10px;">Link the listing under <b>Link to deal</b> below so this showing appears on your seller's portal.</div>
            <div><label style="${M_LAB}">Who showed it?</label><select data-f-showingwho style="${M_INPUT}">
              <option value="self">Me or James (our team)</option>
              <option value="outside">Another agent (buyer's agent)</option></select></div>
            <div data-showing-agent-wrap style="display:none;"><label style="${M_LAB}">Showing agent — name &amp; brokerage</label>
              <input data-f-showingagent placeholder="e.g. Jane Doe, Coldwell Banker" maxlength="160" style="${M_INPUT}">
              <div style="font-size:12px;color:#6A5A3C;margin-top:4px;">Your seller sees this agent and an automatic count of how many times they've shown.</div></div>
          </div>
          <div><label style="${M_LAB}">Client email <span style="text-transform:none;letter-spacing:0;">(optional · lets you share to their portal)</span></label><input data-f-apptemail type="email" placeholder="client@example.com" style="${M_INPUT}"></div>
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#3A332B;line-height:1.4;"><input data-f-apptinvite type="checkbox" style="margin-top:3px;"> Email a calendar invite (to the client + any CC below)</label>
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#3A332B;line-height:1.4;"><input data-f-apptsms type="checkbox" style="margin-top:3px;"> Text the client(s) a reminder now</label>
        </div>
        <div style="display:flex;gap:10px;">
          <div style="flex:1;"><label style="${M_LAB}">Date</label><input data-f-date type="date" style="${M_INPUT}"></div>
          <div data-time-cell style="flex:0 0 130px;"><label style="${M_LAB}">Time</label><select data-f-time style="${M_INPUT}">${timeOptionsHtml(defaultTimeSlot())}</select></div>
          <div data-dur-cell style="flex:0 0 110px;"><label style="${M_LAB}">Minutes</label><input data-f-dur type="number" min="15" step="15" value="30" style="${M_INPUT}"></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#3A332B;"><input data-f-multiday type="checkbox"> Spans multiple days (e.g. a holiday)</label>
        <div data-enddate-cell style="display:none;"><label style="${M_LAB}">End date</label><input data-f-enddate type="date" style="${M_INPUT}"></div>
        <div><label style="${M_LAB}">Link to deal <span style="text-transform:none;letter-spacing:0;">(optional)</span></label><select data-f-deal style="${M_INPUT}"><option value="">No deal</option></select></div>
        <div data-share-wrap style="display:none;background:#F3EEDF;border:1px solid #E4DAC1;padding:10px 12px;">
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#3A332B;line-height:1.4;cursor:pointer;"><input data-f-sharedeal type="checkbox" checked style="margin-top:3px;"> <span>Show on the client portal for <b data-share-parties>everyone on this deal</b></span></label>
        </div>
        <div><label style="${M_LAB}">CC — also send the invite to <span style="text-transform:none;letter-spacing:0;">(search a contact to add, or type emails — a spouse, co-op agent, TC, lender; both agents are included automatically)</span></label>
          <input data-f-ccsearch placeholder="Search your contacts by name, email, phone…" style="${M_INPUT}" autocomplete="off">
          <div data-f-ccresults style="position:relative;"></div>
          <input data-f-invitees placeholder="spouse@example.com, tc@title.com" style="${M_INPUT};margin-top:8px;"></div>
        <div><label style="${M_LAB}">Notes</label><textarea data-f-notes rows="2" style="${M_INPUT}"></textarea></div>
        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
          <button type="button" data-save style="${M_INK}">Add event</button>
          <button type="button" data-cancel style="${M_GHOST};margin-left:auto;">Cancel</button>
        </div>
      </div>`;
    const kindSel = m.body.querySelector('[data-f-kind]');
    const tourFields = m.body.querySelector('[data-tour-fields]');
    const apptFields = m.body.querySelector('[data-appt-fields]');
    const inspWrap = m.body.querySelector('[data-insp-wrap]');
    const inspList = m.body.querySelector('[data-insp-list]');
    const inspAdd  = m.body.querySelector('[data-insp-add]');
    const saveBtn = m.body.querySelector('[data-save]');

    // One inspection row: type + its own time + remove. Several can be booked in
    // one save — they share the date below but each keeps its own time.
    const INSP_TYPES = ['Home', 'Pest', 'Roof', 'Well & Septic', 'Sewer / Septic', 'Chimney', 'Pool', 'Foundation'];
    function addInspRow(preset) {
      preset = preset || {};
      const row = document.createElement('div');
      row.setAttribute('data-insp-item', '');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;';
      row.innerHTML =
        '<select data-r-kind style="' + M_INPUT + ';flex:1;">' +
          INSP_TYPES.map(function (t) { return '<option value="' + esc(t) + '"' + (preset.sub_kind === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') +
          '<option value="__other">Other…</option></select>' +
        '<input data-r-other placeholder="Type" style="' + M_INPUT + ';flex:1;display:none;">' +
        '<select data-r-time style="' + M_INPUT + ';flex:0 0 116px;">' + timeOptionsHtml(preset.time || defaultTimeSlot()) + '</select>' +
        '<button type="button" data-r-del title="Remove" style="flex:none;background:transparent;border:none;color:#9B7A4A;font-size:20px;cursor:pointer;line-height:1;">&times;</button>';
      const rk = row.querySelector('[data-r-kind]'), ro = row.querySelector('[data-r-other]');
      rk.addEventListener('change', function () { ro.style.display = rk.value === '__other' ? 'block' : 'none'; });
      row.querySelector('[data-r-del]').addEventListener('click', function () {
        if (inspList.querySelectorAll('[data-insp-item]').length > 1) row.remove();
      });
      inspList.appendChild(row);
    }
    if (inspAdd) inspAdd.addEventListener('click', function () { addInspRow(); });

    // Assigned once the share row is set up (below); syncKind calls it to re-run
    // the share row when the event type changes. Declared here so the early
    // syncKind() call can safely `typeof`-check it before it exists.
    var refreshShare = null;

    // The top-level Time is for a single event; inspections carry per-row times,
    // and an all-day span has none — hide the top Time in both cases.
    function updateTimeCell() {
      const cell = m.body.querySelector('[data-time-cell]');
      if (!cell) return;
      const multi = m.body.querySelector('[data-f-multiday]');
      const hide = kindSel.value === 'inspection' || (multi && multi.checked);
      cell.style.display = hide ? 'none' : 'block';
    }
    const syncKind = () => {
      const isTour = kindSel.value === 'tour';
      const isInsp = kindSel.value === 'inspection';
      const isShowing = kindSel.value === 'showing';
      tourFields.style.display = isTour ? 'flex' : 'none';
      apptFields.style.display = isTour ? 'none' : 'flex';
      if (inspWrap) inspWrap.style.display = isInsp ? 'flex' : 'none';
      if (isInsp && inspList && !inspList.querySelector('[data-insp-item]')) addInspRow();
      // Showing-only fields (who showed it + outside agent name).
      const shf = m.body.querySelector('[data-showing-fields]'); if (shf) shf.style.display = isShowing ? 'flex' : 'none';
      saveBtn.textContent = isTour ? 'Schedule tour' : (isInsp ? 'Add inspections' : 'Add event');
      // Default the deal-share toggle ON for inspections (share with both sides)
      // and for showings (a showing exists to tell the SELLER their home was
      // toured — portal_items scopes it to the seller only). OFF for other kinds
      // so an internal event linked to a deal isn't shared by accident. Flippable.
      const sc = m.body.querySelector('[data-f-sharedeal]'); if (sc) sc.checked = isInsp || isShowing;
      updateTimeCell();
      if (typeof refreshShare === 'function') refreshShare();
    };
    kindSel.addEventListener('change', syncKind);

    // Multi-day toggle — reveal the end date, hide time/minutes (an all-day span
    // like a holiday has no clock time).
    const multiCb   = m.body.querySelector('[data-f-multiday]');
    const endCell   = m.body.querySelector('[data-enddate-cell]');
    const durCell   = m.body.querySelector('[data-dur-cell]');
    const syncMulti = () => {
      const on = multiCb.checked;
      endCell.style.display = on ? 'block' : 'none';
      durCell.style.display = on ? 'none' : 'block';
      updateTimeCell();
    };
    multiCb.addEventListener('change', syncMulti);
    syncKind(); syncMulti();

    // Client search → fills the email/name fields (tour AND general events).
    const csIn = m.body.querySelector('[data-f-clientsearch]');
    const csRes = m.body.querySelector('[data-f-clientresults]');
    const applyClient = (name, email) => {
      csIn.value = name + (email ? ` <${email}>` : '');
      const parts = name.split(/\s+/);
      m.body.querySelector('[data-f-email]').value = email || '';
      m.body.querySelector('[data-f-first]').value = parts[0] || '';
      m.body.querySelector('[data-f-last]').value = parts.slice(1).join(' ') || '';
      const ae = m.body.querySelector('[data-f-apptemail]'); if (ae) ae.value = email || '';
      csRes.innerHTML = '';
    };
    let csT;
    csIn.addEventListener('input', () => {
      clearTimeout(csT);
      const q = csIn.value.trim();
      if (q.length < 2) { csRes.innerHTML = ''; return; }
      csT = setTimeout(async () => {
        const r = await window.Legacy.api('/api/crm/roster?bucket=all&q=' + encodeURIComponent(q) + '&limit=8', { method: 'GET' });
        const people = (r.ok && r.json && r.json.people) || [];
        csRes.innerHTML = people.length ? `<div style="position:absolute;z-index:50;left:0;right:0;background:#fff;border:1px solid #D9CFB7;max-height:200px;overflow:auto;">${people.map((pp) => `<div data-cs-pick data-cs-name="${esc(pp.name)}" data-cs-email="${esc(pp.email || '')}" style="padding:8px 12px;cursor:pointer;font-size:13.5px;border-bottom:1px solid #EFE7D6;">${esc(pp.name)} <span style="color:#7A6F60;font-size:12px;">${esc(pp.email || pp.phone || '')}</span></div>`).join('')}</div>` : '';
      }, 300);
    });
    csRes.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-cs-pick]');
      if (pick) applyClient(pick.getAttribute('data-cs-name'), pick.getAttribute('data-cs-email'));
    });

    // CC field — merge emails in without duplicating, and never re-add whoever
    // is already the client. Used by the CC contact search and deal auto-attach.
    const inviteesEl = m.body.querySelector('[data-f-invitees]');
    const addInvitees = (emails) => {
      if (!inviteesEl || !emails || !emails.length) return;
      const clientEmail = ((m.body.querySelector('[data-f-apptemail]') || {}).value
        || (m.body.querySelector('[data-f-email]') || {}).value || '').trim().toLowerCase();
      const cur = inviteesEl.value.split(',').map((x) => x.trim()).filter(Boolean);
      const seen = new Set(cur.map((e) => e.toLowerCase()));
      if (clientEmail) seen.add(clientEmail);
      emails.forEach((e) => { const k = String(e || '').trim().toLowerCase(); if (k && !seen.has(k)) { cur.push(String(e).trim()); seen.add(k); } });
      inviteesEl.value = cur.join(', ');
    };
    // CC contact search — same autocomplete as the Client field; clicking a
    // result appends that contact's email to the CC list.
    const ccIn = m.body.querySelector('[data-f-ccsearch]');
    const ccRes = m.body.querySelector('[data-f-ccresults]');
    let ccT;
    if (ccIn) ccIn.addEventListener('input', () => {
      clearTimeout(ccT);
      const q = ccIn.value.trim();
      if (q.length < 2) { ccRes.innerHTML = ''; return; }
      ccT = setTimeout(async () => {
        const r = await window.Legacy.api('/api/crm/roster?bucket=all&q=' + encodeURIComponent(q) + '&limit=8', { method: 'GET' });
        const people = (r.ok && r.json && r.json.people) || [];
        ccRes.innerHTML = people.length ? `<div style="position:absolute;z-index:50;left:0;right:0;background:#fff;border:1px solid #D9CFB7;max-height:200px;overflow:auto;">${people.map((pp) => `<div data-cc-pick data-cc-email="${esc(pp.email || '')}" style="padding:8px 12px;cursor:${pp.email ? 'pointer' : 'default'};font-size:13.5px;border-bottom:1px solid #EFE7D6;${pp.email ? '' : 'opacity:.5;'}">${esc(pp.name)} <span style="color:#7A6F60;font-size:12px;">${esc(pp.email || (pp.phone ? pp.phone + ' · no email' : 'no email'))}</span></div>`).join('')}</div>` : '';
      }, 300);
    });
    if (ccRes) ccRes.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-cc-pick]');
      if (!pick) return;
      const email = pick.getAttribute('data-cc-email');
      if (email) { addInvitees([email]); ccIn.value = ''; ccRes.innerHTML = ''; }
    });

    // Deal linking → stamps the notes so the command center picks it up.
    const dealSel = m.body.querySelector('[data-f-deal]');
    // Picking a deal auto-fills the client from that deal's primary linked party,
    // so you don't have to search the contact separately. (Answers "will link to
    // deal populate the client?" — yes, as long as the deal has a linked client.)
    // Reveal the "share to the deal's portals" toggle and name the parties who
    // will see it (so it's clear an inspection reaches both seller AND buyer).
    const shareWrap = m.body.querySelector('[data-share-wrap]');
    const sharePartiesEl = m.body.querySelector('[data-share-parties]');
    let lastParties = [];
    const syncShare = (parties) => {
      if (parties) lastParties = parties;
      if (!shareWrap) return;
      // A "Client tour" is buyer-side and its create path CANNOT deal-share, so
      // showing this toggle there was a trap (ticking it did nothing). Hide it
      // for tours — a showing is the way to put an event on the seller's portal.
      const isTour = kindSel.value === 'tour';
      const has = dealSel && dealSel.value && !isTour;
      shareWrap.style.display = has ? 'block' : 'none';
      if (has && sharePartiesEl) {
        if (kindSel.value === 'showing') {
          // A showing is scoped to the SELLER only (portal_items gates buyers out).
          sharePartiesEl.textContent = 'your seller';
        } else {
          const names = (lastParties || []).map((p) => {
            const nm = (p.name || p.email || '').split(/\s+/)[0] || (p.email || '');
            const role = /buyer/i.test(p.role || '') ? 'buyer' : /seller/i.test(p.role || '') ? 'seller' : '';
            return nm ? nm + (role ? ' (' + role + ')' : '') : '';
          }).filter(Boolean);
          sharePartiesEl.textContent = names.length ? names.join(' · ') : 'everyone on this deal';
        }
      }
    };
    refreshShare = () => syncShare(lastParties);

    // Reveal the outside-agent name field only when "Another agent" is picked.
    const showingWhoSel = m.body.querySelector('[data-f-showingwho]');
    const showingAgentWrap = m.body.querySelector('[data-showing-agent-wrap]');
    if (showingWhoSel && showingAgentWrap) {
      showingWhoSel.addEventListener('change', () => {
        showingAgentWrap.style.display = showingWhoSel.value === 'outside' ? 'block' : 'none';
      });
    }
    const fillFromDeal = async (sourceKey) => {
      if (!sourceKey) { syncShare([]); return; }
      try {
        const r = await window.Legacy.api('/api/crm/deal-client?deal=' + encodeURIComponent(sourceKey), { method: 'GET' });
        const j = r && r.ok && r.json;
        const c = j && j.client;
        if (c && (c.email || c.name)) applyClient(c.name || '', c.email || '');
        // More than one client on the deal (couple / co-buyers)? Attach the rest
        // automatically by CC'ing their emails — no need to add them by hand.
        const extras = ((j && j.parties) || []).slice(1).map((p) => p.email).filter(Boolean);
        if (extras.length) addInvitees(extras);
        syncShare((j && j.parties) || (c ? [c] : []));
      } catch (_) { syncShare([]); }
    };
    if (dealSel) dealSel.addEventListener('change', () => { syncShare([]); fillFromDeal(dealSel.value); });
    fetch('/api/crm/listings', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).then((j) => {
      if (!j || !dealSel) return;
      const all = [].concat(j.pending || [], j.offers || [], j.active || [], j.preparing || []);
      dealSel.innerHTML = '<option value="">No deal</option>' + all.map((d) =>
        `<option value="${esc(d.source_key || '')}" data-addr="${esc(d.address || '')}">${esc(d.address || d.source_key)}${d.stage ? ' · ' + esc(d.stage) : ''}</option>`).join('');
      if (prefill.deal) { dealSel.value = prefill.deal; if (!prefill.email) fillFromDeal(prefill.deal); }
    }).catch(() => {});

    // Prefill from a client page ("Schedule" on a lead) or a deal.
    if (prefill.name || prefill.email) applyClient(prefill.name || prefill.email, prefill.email || '');
    if (prefill.kind) { kindSel.value = prefill.kind; syncKind(); }
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    saveBtn.addEventListener('click', async () => {
      const kind = kindSel.value;
      const date = m.body.querySelector('[data-f-date]').value;
      const multiDay = multiCb.checked;
      const endDate = m.body.querySelector('[data-f-enddate]').value;
      const isInsp = kind === 'inspection';
      // Multi-day (all-day) events run at noon so timezone never rolls the date.
      const time = multiDay ? '12:00' : (isInsp ? null : m.body.querySelector('[data-f-time]').value);
      if (!date) { m.err.textContent = 'Pick a date.'; return; }
      if (!multiDay && !isInsp && !time) { m.err.textContent = 'Pick a time.'; return; }
      if (multiDay && (!endDate || endDate < date)) { m.err.textContent = 'Pick an end date on or after the start date.'; return; }

      // Inspection rows → one {sub_kind, time} each. All share the date + duration.
      let inspItems = [];
      if (isInsp) {
        inspItems = Array.prototype.map.call(m.body.querySelectorAll('[data-insp-item]'), function (row) {
          const rk = row.querySelector('[data-r-kind]');
          const sub = rk.value === '__other' ? (row.querySelector('[data-r-other]').value.trim() || null) : rk.value;
          return { sub_kind: sub, time: row.querySelector('[data-r-time]').value };
        }).filter(function (it) { return it.time; });
        if (!inspItems.length) { m.err.textContent = 'Add at least one inspection with a time.'; return; }
      }

      let notesVal = m.body.querySelector('[data-f-notes]').value.trim();
      const dealSelEl = m.body.querySelector('[data-f-deal]');
      const dealKey = dealSelEl ? dealSelEl.value : '';
      if (dealKey) {
        const opt = dealSelEl.options[dealSelEl.selectedIndex];
        notesVal = (notesVal ? notesVal + '\n' : '') + `[deal:${dealKey} · ${opt ? opt.getAttribute('data-addr') || '' : ''}]`;
      }
      // Share to every party on the linked deal (seller + buyer) in one go.
      const shareDeal = !!(dealKey && m.body.querySelector('[data-f-sharedeal]') && m.body.querySelector('[data-f-sharedeal]').checked);
      const inviteesRaw = (m.body.querySelector('[data-f-invitees]').value || '').split(',').map((x) => x.trim()).filter(Boolean);
      const durVal = parseInt(m.body.querySelector('[data-f-dur]').value, 10) || 30;
      const common = { duration_minutes: durVal, notes: notesVal, invitees: inviteesRaw };
      if (dealKey) common.deal_key = dealKey;
      if (multiDay) { common.all_day = true; common.end_date = endDate; }

      // Build the list of POSTs (usually one; several for multiple inspections).
      const posts = [];
      if (kind === 'tour') {
        const email = m.body.querySelector('[data-f-email]').value.trim();
        if (!email) { m.err.textContent = 'Client email is required for a tour.'; return; }
        posts.push({ kind: 'tour', email, first_name: m.body.querySelector('[data-f-first]').value.trim(),
          last_name: m.body.querySelector('[data-f-last]').value.trim(), tour_type: m.body.querySelector('[data-f-type]').value,
          send_invite: m.body.querySelector('[data-f-invite]').checked, date, time, ...common });
      } else {
        const title = m.body.querySelector('[data-f-title]').value.trim();
        const email = m.body.querySelector('[data-f-apptemail]').value.trim();
        const invite = email && m.body.querySelector('[data-f-apptinvite]').checked;
        const base = { kind, date, ...common };
        if (email) base.email = email;
        if (invite) base.send_invite = true;
        if (isInsp) {
          inspItems.forEach(function (it) {
            const label = (it.sub_kind ? it.sub_kind + ' ' : '') + 'inspection';
            const p = { ...base, time: it.time, sub_kind: it.sub_kind };
            if (shareDeal) { p.share = 'deal'; p.client_label = label.charAt(0).toUpperCase() + label.slice(1); }
            posts.push(p);
          });
        } else {
          const p = { ...base, time: multiDay ? '12:00' : time };
          if (title) p.title = title;
          // Showing by an outside agent → record their name (seller sees it + a count).
          if (kind === 'showing') {
            const who = m.body.querySelector('[data-f-showingwho]');
            const nm = m.body.querySelector('[data-f-showingagent]');
            if (who && who.value === 'outside' && nm && nm.value.trim()) p.showing_agent = nm.value.trim();
          }
          if (shareDeal) {
            p.share = 'deal';
            p.client_label = title || (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' '));
          }
          posts.push(p);
        }
      }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; m.err.textContent = '';
      const textReminder = kind !== 'tour' && m.body.querySelector('[data-f-apptsms]') && m.body.querySelector('[data-f-apptsms]').checked;
      let okCount = 0, failMsg = '';
      for (const p of posts) {
        const r = await sendJSON('/api/crm/calendar', 'POST', p);
        if (r.ok && r.json && (r.json.tour || r.json.appointment)) {
          okCount++;
          // Optional: text the client(s) a reminder for the event we just made.
          if (textReminder && r.json.appointment && r.json.appointment.id) {
            sendJSON('/api/crm/calendar', 'POST', { action: 'remind', id: r.json.appointment.id, source: 'appointment', channels: ['sms'] }).catch(function () {});
          }
        } else if (!failMsg) failMsg = (r.json && r.json.error) || 'Could not save.';
      }
      if (okCount) {
        m.close();
        cal.week = Math.round((mondayOf(date + 'T12:00') - mondayOf(new Date())) / (7 * 86400000));
        loadCalendar(cal.week);
        if (failMsg) console.warn('[calendar] ' + okCount + ' saved, ' + (posts.length - okCount) + ' failed: ' + failMsg);
      } else { m.err.textContent = failMsg || 'Could not save.'; saveBtn.disabled = false; syncKind(); }
    });
  }

  function openEventEdit(e) {
    const ed = e.edit || {};
    const isTour = e.source === 'tour';
    const m = modalShell('Edit event', isTour ? 'Reschedule or update this tour.' : 'Update this event.');
    const apptKinds = [['listing_appt', 'Listing appt'], ['showing', 'Showing'], ['walkthrough', 'Walkthrough'], ['follow_up', 'Follow-up'], ['inspection', 'Inspection'], ['appraisal', 'Appraisal'], ['call', 'Call'], ['block', 'Block / personal'], ['open', 'Open house'], ['meeting', 'Meeting']];
    m.body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${isTour ? `
          <div><label style="${M_LAB}">Client</label><input value="${esc((e.client_name || 'Client') + (e.client_email ? ' · ' + e.client_email : ''))}" disabled style="${M_INPUT};opacity:.7;"></div>
          <div><label style="${M_LAB}">Tour type</label><select data-f-type style="${M_INPUT}"><option value="in_person"${ed.tour_type !== 'video' ? ' selected' : ''}>In person</option><option value="video"${ed.tour_type === 'video' ? ' selected' : ''}>Video</option></select></div>
        ` : `
          <div><label style="${M_LAB}">Type</label><select data-f-kind style="${M_INPUT}">${apptKinds.map(([v, l]) => `<option value="${v}"${ed.kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
          <div data-e-insp style="display:${ed.kind === 'inspection' ? 'block' : 'none'};"><label style="${M_LAB}">Inspection type</label><input data-f-subkind value="${esc(ed.sub_kind || '')}" placeholder="Home / Pest / Roof / Well &amp; Septic / other" style="${M_INPUT}"></div>
          <div><label style="${M_LAB}">Title</label><input data-f-title value="${esc(ed.title || '')}" style="${M_INPUT}"></div>
        `}
        <div style="display:flex;gap:10px;">
          <div style="flex:1;"><label style="${M_LAB}">${isTour ? 'Date' : 'Start date'}</label><input data-f-date type="date" value="${esc(ed.date || '')}" style="${M_INPUT}"></div>
          <div data-time-cell style="flex:0 0 130px;"><label style="${M_LAB}">Time</label><select data-f-time style="${M_INPUT}">${timeOptionsHtml(ed.time || '')}</select></div>
          <div data-dur-cell style="flex:0 0 110px;"><label style="${M_LAB}">Minutes</label><input data-f-dur type="number" min="15" step="15" value="${esc(ed.duration_minutes || 30)}" style="${M_INPUT}"></div>
        </div>
        ${!isTour ? `
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#3A332B;"><input data-f-multiday type="checkbox" ${ed.all_day ? 'checked' : ''}> Spans multiple days (e.g. a holiday)</label>
        <div data-enddate-cell style="display:${ed.all_day ? 'block' : 'none'};"><label style="${M_LAB}">End date</label><input data-f-enddate type="date" value="${esc(ed.end_date || '')}" style="${M_INPUT}"></div>` : ''}
        <div><label style="${M_LAB}">Notes</label><textarea data-f-notes rows="2" style="${M_INPUT}">${esc(ed.notes || '')}</textarea></div>
        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
          <button type="button" data-save style="${M_INK}">Save changes</button>
          <button type="button" data-cancel style="${M_GHOST};margin-left:auto;">Cancel</button>
        </div>
      </div>`;
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    const kindSelE = m.body.querySelector('[data-f-kind]');
    if (kindSelE) kindSelE.addEventListener('change', () => { const ins = m.body.querySelector('[data-e-insp]'); if (ins) ins.style.display = kindSelE.value === 'inspection' ? 'block' : 'none'; });
    // Multi-day toggle (appointments only) — mirror the create form.
    const multiCbE  = m.body.querySelector('[data-f-multiday]');
    const endCellE  = m.body.querySelector('[data-enddate-cell]');
    const timeCellE = m.body.querySelector('[data-time-cell]');
    const durCellE  = m.body.querySelector('[data-dur-cell]');
    const syncMultiE = () => {
      const on = multiCbE && multiCbE.checked;
      if (endCellE)  endCellE.style.display  = on ? 'block' : 'none';
      if (timeCellE) timeCellE.style.display = on ? 'none' : 'block';
      if (durCellE)  durCellE.style.display  = on ? 'none' : 'block';
    };
    if (multiCbE) { multiCbE.addEventListener('change', syncMultiE); syncMultiE(); }
    const saveBtn = m.body.querySelector('[data-save]');
    saveBtn.addEventListener('click', async () => {
      const date = m.body.querySelector('[data-f-date]').value;
      const multiDay = !!(multiCbE && multiCbE.checked);
      const endDate = m.body.querySelector('[data-f-enddate]') ? m.body.querySelector('[data-f-enddate]').value : '';
      const time = multiDay ? '12:00' : m.body.querySelector('[data-f-time]').value;
      if (!date || !time) { m.err.textContent = multiDay ? 'Pick a start date.' : 'Pick a date and time.'; return; }
      if (multiDay && (!endDate || endDate < date)) { m.err.textContent = 'Pick an end date on or after the start date.'; return; }
      const payload = { id: e.id, source: e.source, date, time, duration_minutes: parseInt(m.body.querySelector('[data-f-dur]').value, 10) || 30, notes: m.body.querySelector('[data-f-notes]').value.trim() };
      if (isTour) payload.tour_type = m.body.querySelector('[data-f-type]').value;
      else {
        payload.kind = m.body.querySelector('[data-f-kind]').value;
        const t = m.body.querySelector('[data-f-title]').value.trim();
        if (!t) { m.err.textContent = 'A title is required.'; return; }
        payload.title = t;
        const sk = m.body.querySelector('[data-f-subkind]');
        if (sk) payload.sub_kind = sk.value.trim() || null;
        payload.all_day = multiDay;                     // always send so turning it OFF works
        if (multiDay) payload.end_date = endDate;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; m.err.textContent = '';
      const r = await sendJSON('/api/crm/calendar', 'PATCH', payload);
      if (r.ok && r.json && r.json.updated) { m.close(); loadCalendar(cal.week); }
      else { m.err.textContent = (r.json && r.json.error) || 'Update failed.'; saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; }
    });
  }

  function dayLabel(e) { const d = cal.days[e.day]; return d ? `${d.dow}, ${monthName(d.date)} ${d.num}` : (e.date || ''); }

  function openEventDetail(e) {
    if (!e) return;
    // Deadlines/COE are derived from the deal's dates — read-only, no edit/cancel.
    if (e.source === 'deadline' || e.readonly) {
      const m = modalShell(e.title, e.kind_label || 'Deadline');
      const rows = [
        ['When', `${esc(dayLabel(e))}${e.weekend ? ' · falls on a weekend/holiday — act by the prior business day' : ''}`],
        e.deal_address ? ['Deal', esc(e.deal_address)] : null,
        e.client_name ? ['Client', esc(e.client_name)] : null,
        e.notes ? ['Detail', esc(e.notes)] : null
      ].filter(Boolean);
      m.body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;color:#1A1714;">
          ${rows.map(([k, v]) => `<div><span style="${M_LAB}">${k}</span><div style="margin-top:2px;">${v}</div></div>`).join('')}
          <div style="font-size:12px;color:#7A6F60;border-top:1px solid #E4DAC4;padding-top:9px;line-height:1.5;">Calculated from the deal’s dates — it moves automatically if the contract dates change, so there’s nothing to edit here.</div>
          <div style="display:flex;gap:10px;margin-top:4px;"><button type="button" data-act="close" style="${M_INK};margin-left:auto;">Close</button></div>
        </div>`;
      m.body.querySelector('[data-act="close"]').addEventListener('click', m.close);
      return;
    }
    const m = modalShell(e.title, e.kind_label || '');
    const rows = [
      ['When', `${esc(dayLabel(e))} · ${esc(e.time_label)}–${esc(e.end_label)}`],
      e.client_name ? ['Client', esc(e.client_name) + (e.client_email ? ` · ${esc(e.client_email)}` : '')] : null,
      e.location ? ['Where', esc(e.location)] : null,
      (e.status && e.status !== 'confirmed') ? ['Status', esc(e.status)] : null,
      (e.sub && e.sub !== e.title && e.sub !== e.location) ? ['Details', esc(e.sub)] : null
    ].filter(Boolean);
    m.body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;color:#1A1714;">
        ${rows.map(([k, v]) => `<div><span style="${M_LAB}">${k}</span><div style="margin-top:2px;">${v}</div></div>`).join('')}
        ${(e.lead_id || e.deal_id) ? `<label style="display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid #E4DAC4;font-size:13px;color:#1A1714;cursor:pointer;"><input type="checkbox" data-detail-share ${e.shared ? 'checked' : ''}> Show in the client portal${e.deal_key ? ' <span style="color:#7A6F60;">(everyone on this deal)</span>' : (e.client_name ? ' · ' + esc(e.client_name) : '')}</label>` : ''}
        ${(e.lead_id || e.deal_id) ? `<div style="border-top:1px solid #E4DAC4;padding-top:10px;">
          <div style="${M_LAB};margin-bottom:6px;">Send a reminder</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" data-remind="email" style="${M_MINI}">Email</button>
            <button type="button" data-remind="sms" style="${M_MINI}">Text</button>
            <button type="button" data-remind="email,sms" style="${M_MINI}">Both</button>
          </div>
        </div>` : ''}
        <div data-detail-result style="font-size:13px;min-height:18px;"></div>
        <div style="display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;align-items:center;">
          <button type="button" data-act="edit" style="${M_INK}">Edit</button>
          ${e.client_email ? `<button type="button" data-act="invite" style="background:#7C6A4D;color:#FAF6EC;border:none;padding:11px 18px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;">Send invite</button>` : ''}
          <button type="button" data-act="cancel" style="background:none;border:1px solid #E8B0AA;color:#9B2C2C;padding:10px 16px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;">Cancel event</button>
          <button type="button" data-act="close" style="${M_GHOST};margin-left:auto;">Close</button>
        </div>
      </div>`;
    const result = m.body.querySelector('[data-detail-result]');
    const shareCb = m.body.querySelector('[data-detail-share]');
    if (shareCb) shareCb.addEventListener('change', async () => {
      const now = shareCb.checked; shareCb.disabled = true;
      const r = await sendJSON('/api/crm/visibility', 'POST', { kind: e.source, id: e.id, visibility: now ? 'client' : 'internal' });
      shareCb.disabled = false;
      if (r.ok) { e.shared = now; result.style.color = '#2E5C3D'; result.textContent = now ? '✓ Shared to their portal.' : 'Hidden from their portal.'; }
      else { shareCb.checked = !now; result.style.color = '#9B2C2C'; result.textContent = (r.json && r.json.error) || 'Could not change visibility.'; }
    });
    // Reminder buttons — email, text, or both — to the event's client(s).
    m.body.querySelectorAll('[data-remind]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const channels = btn.getAttribute('data-remind').split(',');
        const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…'; result.textContent = '';
        const r = await sendJSON('/api/crm/calendar', 'POST', { action: 'remind', id: e.id, source: e.source, channels });
        btn.disabled = false; btn.textContent = orig;
        if (r.ok && r.json && r.json.reminded) {
          const bits = [];
          if (r.json.emailed) bits.push(r.json.emailed + ' email' + (r.json.emailed > 1 ? 's' : ''));
          if (r.json.texted)  bits.push(r.json.texted + ' text' + (r.json.texted > 1 ? 's' : ''));
          result.style.color = '#2E5C3D';
          result.textContent = bits.length ? ('✓ Reminder sent · ' + bits.join(' + ') + '.') : '✓ Reminder sent.';
        } else { result.style.color = '#9B2C2C'; result.textContent = (r.json && r.json.error) || 'Could not send reminder.'; }
      });
    });
    m.body.querySelector('[data-act="close"]').addEventListener('click', m.close);
    m.body.querySelector('[data-act="edit"]').addEventListener('click', () => { m.close(); openEventEdit(e); });
    const inviteBtn = m.body.querySelector('[data-act="invite"]');
    if (inviteBtn) inviteBtn.addEventListener('click', async () => {
      inviteBtn.disabled = true; inviteBtn.textContent = 'Sending…'; result.textContent = '';
      const r = await sendJSON('/api/crm/calendar', 'POST', { action: 'invite', id: e.id, source: e.source });
      if (r.ok && r.json && r.json.invited) { result.style.color = '#2E5C3D'; result.textContent = `✓ Invite emailed to ${esc(r.json.to || 'the client')}.`; inviteBtn.textContent = 'Sent'; }
      else if (r.ok && r.json && r.json.skipped) { result.style.color = '#9B2C2C'; result.textContent = 'Email is not set up yet (needs RESEND_API_KEY).'; inviteBtn.disabled = false; inviteBtn.textContent = 'Send invite'; }
      else { result.style.color = '#9B2C2C'; result.textContent = (r.json && r.json.error) || 'Could not send invite.'; inviteBtn.disabled = false; inviteBtn.textContent = 'Send invite'; }
    });
    m.body.querySelector('[data-act="cancel"]').addEventListener('click', async () => {
      if (!window.confirm(`Cancel "${e.title}"? ${e.source === 'tour' ? 'The tour will be marked cancelled.' : 'This event will be removed.'}`)) return;
      const r = await sendJSON('/api/crm/calendar', 'DELETE', { id: e.id, source: e.source });
      if (r.ok && r.json && r.json.deleted) { m.close(); loadCalendar(cal.week); }
      else { result.style.color = '#9B2C2C'; result.textContent = (r.json && r.json.error) || 'Could not cancel.'; }
    });
  }

  // Delegated triggers (buttons are static in crm.html or painted).
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-seq-new]'))  { e.preventDefault(); openSeqModal(null); return; }
    if (e.target.closest('[data-seq-edit]')) { e.preventDefault(); openSeqModal(seqState.list.find((x) => String(x.id) === seqState.selectedId) || null); return; }
    if (e.target.closest('[data-cal-new]'))  { e.preventDefault(); openEventCreate(); return; }
    /* exposed for client-page prefill */
    const row = e.target.closest('[data-ev-key]');
    if (row) { e.preventDefault(); openEventDetail(evByKey(row.getAttribute('data-ev-key'))); }
  });

  window.__openEventCreate = openEventCreate;
  document.addEventListener('DOMContentLoaded', () => {
    loadSequences();
    wireCalendarChrome();
    loadCalendar(0);
  });
})();

