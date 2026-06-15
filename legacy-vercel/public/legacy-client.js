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
      overlay.setAttribute('data-legacy-modal', '');
      Object.assign(overlay.style, {
        position: 'fixed', inset: 0, background: 'rgba(20,18,15,0.72)',
        zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px', fontFamily: 'inherit'
      });

      const box = document.createElement('div');
      Object.assign(box.style, {
        background: '#FAF6EC', color: '#1A1714', maxWidth: '460px', width: '100%',
        padding: '32px 32px 28px', boxShadow: '0 30px 80px rgba(0,0,0,0.35)',
        borderRadius: '2px', position: 'relative',
        fontFamily: 'Manrope, system-ui, sans-serif'
      });

      box.innerHTML = `
        <button data-close style="position:absolute;top:14px;right:18px;background:none;border:none;font-size:22px;cursor:pointer;color:#1A1714;">×</button>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:10px;">Legacy Properties</div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:30px;line-height:1.1;margin:0 0 12px;">${title}</h3>
        ${intro ? `<p style="font-size:14px;line-height:1.6;color:#3A332B;margin:0 0 18px;">${intro}</p>` : ''}
        <form data-form style="display:flex;flex-direction:column;gap:10px;"></form>
        <div data-error style="color:#9B2C2C;font-size:13px;margin-top:10px;min-height:18px;"></div>
      `;

      const form = $('[data-form]', box);
      for (const f of fields) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;flex-direction:column;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#7C6A4D;gap:4px;';
        wrap.innerHTML = `<span>${f.label}</span>`;
        const el = f.type === 'textarea'
          ? document.createElement('textarea')
          : document.createElement('input');
        if (f.type !== 'textarea') el.type = f.type || 'text';
        if (f.placeholder) el.placeholder = f.placeholder;
        if (f.required)    el.required    = true;
        if (f.value)       el.value       = f.value;
        el.name = f.name;
        el.style.cssText = 'font:inherit;font-size:15px;text-transform:none;letter-spacing:normal;color:#1A1714;background:#fff;border:1px solid #D9CFB7;padding:10px 12px;border-radius:0;outline:none;';
        if (f.type === 'textarea') el.rows = 3;
        wrap.appendChild(el);
        form.appendChild(wrap);
      }

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = submitLabel;
      submit.style.cssText = 'margin-top:8px;background:#1A1714;color:#FAF6EC;border:none;padding:14px 22px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;';
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
          submit.style.background = '#7C6A4D';
          setTimeout(() => close(result), 1200);
        } catch (err) {
          $('[data-error]', box).textContent = err.message || 'Something went wrong.';
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      });
    });
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
      const active = $('.journey-step.active');
      const stageLabel = (active?.textContent || 'Discovering').trim().toLowerCase();
      const stageMap = {
        'discovering':     'discovering',
        'narrowing':       'narrowing',
        'touring':         'touring',
        'ready to offer':  'ready_to_offer'
      };
      const journey_stage = stageMap[stageLabel] || 'discovering';

      const result = await openModal({
        title:  'Save your place.',
        intro:  'We will reach out within the day. No autoresponders.',
        fields: [
          { name: 'first_name', label: 'First name', required: true },
          { name: 'last_name',  label: 'Last name' },
          { name: 'email',      label: 'Email',     type: 'email', required: true },
          { name: 'phone',      label: 'Mobile (optional)' }
        ],
        submitLabel: 'Save my place',
        onSubmit: (data) => submitLead({ ...data, journey_stage, lead_type: 'buyer' })
      });
      if (result) location.href = 'dashboard.html';
    });
  }

  function wireFindMyMatch() {
    // Every page has one or more "Find My Match" links → platform.html.
    // We intercept them and open a modal in place; the link still works as fallback.
    $$('a').forEach(a => {
      if ((a.textContent || '').trim().toLowerCase() === 'find my match') {
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
      }
    });
  }

  function wireListingsPage() {
    if (!/\/listings\.html$/.test(location.pathname)) return;
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
              { name: 'phone',      label: 'Mobile',    required: true }
            ],
            submitLabel: 'Request a tour',
            onSubmit: (data) => submitLead({ ...data, lead_type: 'buyer', journey_stage: 'touring' })
          });
        });
      }
    });
  }

  function wireListingDetailPage() {
    if (!/\/listing\.html$/.test(location.pathname)) return;

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
      if (!dayEl || !slotEl) { alert('Pick a day and time.'); return; }

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
          { name: 'phone',      label: 'Mobile', required: true }
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
        if (!email?.value || !ta?.value) { alert('Add your email and a quick note.'); return; }
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
          alert(err.message);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Auth gating for /crm.html, /dashboard.html, /seller.html
  // ---------------------------------------------------------------------------
  async function ensureSession(requiredRoles) {
    const { ok, json } = await api('/api/auth/session', { method: 'GET' });
    if (!ok) return null;
    const role = json?.profile?.role;
    if (requiredRoles && !requiredRoles.includes(role)) return null;
    return json;
  }

  async function gate(requiredRoles) {
    const session = await ensureSession(requiredRoles);
    if (session) return session;

    // Replace the page with an inline sign-in card (no HTML edits needed).
    document.body.innerHTML = '';
    document.body.style.cssText = 'background:#1A1714;color:#FAF6EC;font-family:Manrope,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:420px;width:100%;background:#FAF6EC;color:#1A1714;padding:36px 32px;';
    const isAgent = requiredRoles && requiredRoles.some(r => r.startsWith('agent_'));
    card.innerHTML = `
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:10px;">Legacy Properties</div>
      <h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:30px;margin:0 0 18px;">${isAgent ? 'Open the desk.' : 'Sign in.'}</h2>
      <form id="leg-auth" style="display:flex;flex-direction:column;gap:10px;">
        <input name="email"    type="email"    placeholder="Email"    required style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">
        ${isAgent ? '<input name="password" type="password" placeholder="Password" required style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">' : ''}
        <button type="submit" style="background:#1A1714;color:#FAF6EC;border:none;padding:14px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;">${isAgent ? 'Sign in' : 'Send magic link'}</button>
        <div id="leg-auth-msg" style="font-size:13px;min-height:18px;color:#7C6A4D;"></div>
      </form>`;
    document.body.appendChild(card);

    const form = card.querySelector('#leg-auth');
    const msg  = card.querySelector('#leg-auth-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      msg.textContent = 'Working…';
      if (isAgent) {
        const r = await api('/api/auth/login', { body: data });
        if (!r.ok) { msg.textContent = r.json?.error || 'Sign-in failed.'; return; }
        // Persist session via cookies for subsequent requests
        await api('/api/auth/session', {
          body: { access_token: r.json.session.access_token, refresh_token: r.json.session.refresh_token }
        });
        location.reload();
      } else {
        const r = await api('/api/auth/magic-link', { body: { email: data.email } });
        msg.textContent = r.ok ? 'Check your email for the link.' : (r.json?.error || 'Could not send link.');
      }
    });
    return null;
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

    if (/\/crm\.html$/.test(path))       await gate(['agent_sara','agent_james','admin']);
    if (/\/dashboard\.html$/.test(path)) await gate(['buyer','agent_sara','agent_james','admin']);
    if (/\/seller\.html$/.test(path))    await gate(['seller','agent_sara','agent_james','admin']);
  });

  // expose for debugging
  window.Legacy = { api, openModal, submitLead };
})();
