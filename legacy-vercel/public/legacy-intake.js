/* ==========================================================================
   LEGACY INTAKE — consumer lead-capture runtime
   Legacy Properties · legacycalifornia.com

   WHAT THIS IS
   ---------------------------------------------------------------------------
   The marketing pages load the motion runtime (legacy-ui.js) but NOT the big
   app bundle (legacy-client.js) — loading that would fire the CRM's
   authenticated fetches on every public page. So the intake modals
   ("Save my place", "Message Sara", "Book a tour") had no code to run.

   This file is the small, self-contained consumer slice: the modal builder,
   toast, the lead-intake POST, and the page wiring — nothing CRM. Add it to
   any public page that has an intake CTA.

   AESTHETIC LIVES IN CSS, NOT HERE
   ---------------------------------------------------------------------------
   The dark "ink sheet" look is defined by the .lg-ov / .lg-sheet / .lg-toast
   classes in legacy-ui.css. This file only emits those classes, so the visual
   system can't drift even though openModal()/toast() are also defined (for the
   portal pages) inside legacy-client.js. If you change the modal MARKUP
   (class names / field structure), mirror it in legacy-client.js too.
   ========================================================================== */
(function () {
  'use strict';

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

  // Dark ink-sheet modal. Emits the shared .lg-* classes (see legacy-ui.css).
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

  // On-brand toast — replaces native alert() on the consumer pages.
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

  async function submitLead(extra) {
    const payload = { source: 'website_form', ...extra };
    const { ok, json } = await api('/api/leads/intake', { body: payload });
    if (!ok || !json?.success) throw new Error(json?.error || 'Network error');
    return json;
  }

  // A2P express consent — unchecked by default, added to every form that
  // collects a phone number. Full program terms live at /sms-terms.html.
  const SMS_CONSENT_FIELD = {
    name: 'sms_consent', type: 'checkbox',
    label: 'Text me about my inquiry — appointment reminders and listing updates from Legacy Properties. Frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. <a href="/sms-terms.html" target="_blank" rel="noopener">Terms</a> &amp; <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>. Not required.'
  };

  function wireHomepage() {
    const stepsWrap = $('[data-journey-steps]');
    const saveLink  = $('.journey-link');
    if (!stepsWrap && !saveLink) return;

    // Buyer stages map to the intake's allowed journey values; seller stages
    // don't (the CRM tracks those separately), so for sellers we carry the
    // chosen stage in the message and leave journey_stage null.
    const stageMap = {
      'Discovering':    'discovering',
      'Narrowing':      'narrowing',
      'Touring':        'touring',
      'Ready to offer': 'ready_to_offer'
    };
    const currentSide = () =>
      ($('.journey-side.is-on')?.getAttribute('data-side') === 'seller') ? 'seller' : 'buyer';

    // Open the intake modal prefilled with the chosen side + stage, then send it
    // to /api/leads/intake and route the new lead to their dashboard.
    async function openJourneyIntake(lead_type, stageLabel) {
      const journey_stage = lead_type === 'buyer' ? (stageMap[stageLabel] || 'discovering') : null;
      const message = `Homepage: ${lead_type === 'seller' ? 'Selling' : 'Buying'}${stageLabel ? ' — ' + stageLabel : ''}`;
      const result = await openModal({
        title:  'Save your place.',
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
    }

    // Picking a stage opens the wizard immediately. The inline setJourney(this)
    // has already moved the .is-on highlight by the time this fires.
    $$('.journey-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        openJourneyIntake(currentSide(), (btn.textContent || '').trim());
      });
    });

    // The secondary "Save my place" link keeps working — it reads whichever
    // stage is currently highlighted.
    if (saveLink) saveLink.addEventListener('click', (e) => {
      e.preventDefault();
      openJourneyIntake(currentSide(), ($('.journey-step.is-on')?.textContent || '').trim());
    });
  }

  function wireFindMyMatch() {
    // "Find My Match" links point at the dedicated find-my-match.html wizard —
    // let those navigate normally. Only orphaned/legacy links get an in-place
    // modal fallback.
    $$('a').forEach(a => {
      if ((a.textContent || '').trim().toLowerCase() !== 'find my match') return;
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
            price_max: data.price_max ? Number(data.price_max.toString().replace(/[^\d]/g, '')) : null,
            lead_type: 'buyer',
            journey_stage: 'narrowing'
          })
        });
      });
    });
  }

  function wireListingsPage() {
    if (!/\/(listings|property-search)\.html$/.test(location.pathname)) return;
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

      const now = new Date();
      const dom = parseInt(dayEl.querySelector('.num')?.textContent || '0', 10);
      const [time, ampm] = (slotEl.textContent || '').trim().split(' ');
      const [hh, mm]     = time.split(':').map(Number);
      let hour = hh % 12; if (/pm/i.test(ampm)) hour += 12;
      const when = new Date(now.getFullYear(), now.getMonth(), dom, hour, mm || 0);
      if (when < now) when.setMonth(when.getMonth() + 1);

      await openModal({
        title:  'Confirm your tour.',
        intro:  `${tourType === 'video' ? 'Video tour' : 'In-person'} · ${when.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
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

  // Expose the same helpers legacy-client.js does, but MERGE so we never clobber
  // a richer window.Legacy if both scripts ever load on one page.
  window.Legacy = Object.assign(window.Legacy || {}, { api, openModal, submitLead, toast });

  document.addEventListener('DOMContentLoaded', () => {
    wireHomepage();
    wireFindMyMatch();
    wireListingsPage();
    wireListingDetailPage();
  });
})();
