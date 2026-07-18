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
        if (f.type === 'checkbox') {
          // Consent-style checkbox: small-print label, never pre-checked.
          wrap.style.cssText = 'display:flex;gap:9px;align-items:flex-start;font-size:12px;letter-spacing:0;text-transform:none;color:#3A332B;line-height:1.5;cursor:pointer;';
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.name = f.name; cb.style.cssText = 'margin-top:3px;flex:none;';
          wrap.innerHTML = '';
          wrap.appendChild(cb);
          const span = document.createElement('span');
          span.innerHTML = f.label;
          wrap.appendChild(span);
          form.appendChild(wrap);
          continue;
        }
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
          { name: 'phone',      label: 'Mobile (optional)' },
              SMS_CONSENT_FIELD
        ],
        submitLabel: 'Save my place',
        onSubmit: async (data) => {
          const r = await submitLead({ ...data, journey_stage, lead_type: 'buyer' });
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
    // Inject an immediate full-screen dimmer so the prototype mock can never
    // flash before we know who the visitor is. The overlay is created
    // synchronously on the documentElement so it shows even before <body>
    // has finished parsing.
    let overlay = document.getElementById('leg-auth-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'leg-auth-overlay';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99998',
        'background:rgba(20,18,15,0.94)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:24px',
        'font-family:Manrope,system-ui,sans-serif',
        'color:#FAF6EC'
      ].join(';');
      overlay.innerHTML = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;opacity:.7;">Checking session…</div>';
      (document.body || document.documentElement).appendChild(overlay);
    }

    const session = await ensureSession(requiredRoles);
    if (session) {
      overlay.remove();
      return session;
    }

    // Not signed in (or wrong role) — turn the overlay into a sign-in card.
    // CRM uses password; buyer/seller dashboards use magic link.
    const primaryRole = (requiredRoles || [])[0] || '';
    const isAgent = primaryRole.startsWith('agent_') || primaryRole === 'admin';
    const prefillEmail = new URLSearchParams(location.search).get('email') || '';

    overlay.innerHTML = '';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:460px;width:100%;background:#FAF6EC;color:#1A1714;padding:36px 32px;box-shadow:0 30px 80px rgba(0,0,0,0.5);';
    card.innerHTML = `
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:10px;">Legacy Properties</div>
      <h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:30px;margin:0 0 14px;line-height:1.1;">${isAgent ? 'Open the desk.' : 'See your dashboard.'}</h2>
      ${isAgent ? '' : '<p style="font-size:14px;line-height:1.55;color:#3A332B;margin:0 0 18px;">Enter your email and we will send you a one-click link. No password to remember.</p>'}
      <form id="leg-auth" style="display:flex;flex-direction:column;gap:10px;">
        <input name="email" type="email" placeholder="Email" required value="${prefillEmail.replace(/"/g,'')}" style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">
        ${isAgent ? '<input name="password" type="password" placeholder="Password" required style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">' : ''}
        <button type="submit" style="background:#1A1714;color:#FAF6EC;border:none;padding:14px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;">${isAgent ? 'Sign in' : 'Email me the link'}</button>
        <div id="leg-auth-msg" style="font-size:13px;min-height:18px;color:#7C6A4D;"></div>
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
            <div style="font-family:'Cormorant Garamond',serif;font-style:italic;font-size:22px;line-height:1.3;color:#1A1714;margin-bottom:10px;">Check your email.</div>
            <p style="font-size:14px;line-height:1.55;color:#3A332B;margin:0 0 8px;">We just sent a one-click sign-in link to <strong>${data.email.replace(/</g,'')}</strong>.</p>
            <p style="font-size:13px;line-height:1.5;color:#7C6A4D;margin:0;">It can take up to a minute. Look in spam if you do not see it.</p>`;
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

  // ---- The decision queue: everything that needs Sara, one ranked list ----
  // Timeline approvals (maroon), collection nudges (green), then AI drafts.
  function paintNeedsQueue(brief, drafts) {
    const needs = $('.needs');
    if (!needs) return;
    needs.querySelectorAll('.need-card').forEach(el => el.remove());
    const approvals = brief.timeline_approvals || [];
    const nudges = brief.collection_nudges || [];
    const total = approvals.length + nudges.length + drafts.length;

    const eyebrow = needs.querySelector('.eyebrow');
    if (eyebrow) eyebrow.textContent = total
      ? ['Needs you', approvals.length ? `${approvals.length} approval${approvals.length === 1 ? '' : 's'}` : '',
         drafts.length ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : '',
         nudges.length ? `${nudges.length} follow-up${nudges.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
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
          <div class="nc-meta"><span class="nc-tag" style="color:#5A0E24;">Timeline · ${escapeHtml(pr.address || 'deal')}</span></div>
          <h3>${escapeHtml((pr.item_key || '').replace(/^custom:/, '').replace(/_/g, ' '))} — ${escapeHtml(changeLabel(pr.change))}</h3>
          <p>${escapeHtml(pr.reason || '')}</p>
          <div class="nc-foot"><div class="nc-foot-l"><span>Applies to the seller's page the moment you approve</span></div>
            <div class="nc-foot-r">
              <button class="btn btn-ghost btn-sm" data-tl-reject="${escapeHtml(pr.id)}">Dismiss</button>
              <button class="btn btn-ink btn-sm" data-tl-approve="${escapeHtml(pr.id)}">Approve</button>
            </div></div>
          <div data-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
        </div>`;
      needs.appendChild(card);
      card.querySelectorAll('[data-tl-approve],[data-tl-reject]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const approve = btn.hasAttribute('data-tl-approve');
          btn.disabled = true; btn.textContent = approve ? 'Applying…' : 'Dismissing…';
          const r = await api('/api/crm/timeline', { body: { op: approve ? 'approve' : 'reject', proposal_id: pr.id } });
          const resEl = card.querySelector('[data-result]');
          if (r.ok) {
            card.style.opacity = '.5';
            card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            resEl.style.color = '#2E5C3D';
            resEl.textContent = approve ? '✓ Applied — the seller page is updated.' : 'Dismissed.';
          } else { btn.disabled = false; btn.textContent = approve ? 'Approve' : 'Dismiss'; resEl.style.color = '#9B2C2C'; resEl.textContent = r.json?.error || 'Failed — try again.'; }
        });
      });
    });

    nudges.forEach((n) => {
      const card = document.createElement('article');
      card.className = 'need-card q-cli';
      card.innerHTML = `
        <div class="nc-rank">…</div>
        <div class="nc-body">
          <div class="nc-meta"><span class="nc-tag" style="color:#2E5C3D;">Client · curated collection</span></div>
          <h3>${escapeHtml(n.client_name || 'Your client')} hasn't reacted to “${escapeHtml(n.title)}”</h3>
          <p>Pushed ${n.days_since_push} days ago${n.opens_since_push ? ` · opened ${n.opens_since_push}× since` : ' · not opened yet'}. Worth a nudge.</p>
          <div class="nc-foot"><div class="nc-foot-l"></div><div class="nc-foot-r">
            <button class="btn btn-ghost btn-sm" data-open-curate>Open collection →</button>
          </div></div>
        </div>`;
      needs.appendChild(card);
      card.querySelector('[data-open-curate]').addEventListener('click', () => {
        if (typeof window.showView === 'function') window.showView(null, 'curate');
      });
    });

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
    const items = feedItems.filter((i) => feedFilter === 'all' || i.kind === feedFilter).slice(0, 9);
    if (!items.length) { grid.innerHTML = emptyPanel('Quiet right now. Signals, texts, and portal activity land here as they happen.'); return; }
    grid.innerHTML = items.map((i) => `
      <article class="signal">
        <span class="sig-time">${escapeHtml(i.time || '')}</span>
        <p>${escapeHtml(i.body)}</p>
        <span class="sig-tag">${escapeHtml(i.tag || 'Signal')}</span>
      </article>`).join('');
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

  // ---- Stable per-deal colors (dark pastels) -------------------------------
  // One deal = one color, everywhere, forever: slot = hash(source_key), with
  // deterministic probing so ACTIVE deals (escrow/offer) never share a color.
  // Exposed as window.LegacyDealColors for every module + page.
  const LGC_DEAL_PALETTE = [
    { name: 'wine',     border: '#7A2F3E', bg: '#F2E2E6' },
    { name: 'pine',     border: '#2E5C3D', bg: '#E2EEE6' },
    { name: 'indigo',   border: '#4A3B7C', bg: '#E8E4F2' },
    { name: 'ochre',    border: '#8C6B2E', bg: '#F2EAD6' },
    { name: 'teal',     border: '#2B6B6B', bg: '#DCEDED' },
    { name: 'clay',     border: '#8A4A2B', bg: '#F4E6DD' },
    { name: 'slate',    border: '#3A5A8C', bg: '#E0E8F4' },
    { name: 'mulberry', border: '#7C2E5A', bg: '#F2DFEA' },
    { name: 'olive',    border: '#5C6B2E', bg: '#ECF0DC' },
    { name: 'umber',    border: '#6B4A2B', bg: '#EFE6DA' },
    { name: 'storm',    border: '#44546B', bg: '#E3E8EF' },
    { name: 'moss',     border: '#3D6B4F', bg: '#E0EEE6' }
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
  // awaiting approval, dark leads, today's tours, new leads) — there's no
  // stable per-item id to persist a "done" state against server-side. So
  // checking one off just crosses it out for the current page session: a
  // quick "I see this, ignore it for now" rather than a saved task. If the
  // underlying signal is still true next time the page loads, it'll show up
  // again — that's intentional, it mirrors reality.
  function paintDayList(items, totalMin) {
    const ul = document.querySelector('[data-day-list]');
    if (!ul) return;
    if (!items.length) {
      ul.innerHTML = `<li style="opacity:.55;font-style:italic;padding:14px 0;">Quiet day list. No drafts, no radio silence, no new leads in the last 24 hours.</li>`;
    } else {
      ul.innerHTML = items.map((t) => `
        <li data-tk-min="${parseInt(t.time) || 0}"><input type="checkbox" class="tk-box" data-tk-check title="Cross off for today"><span class="tk-body"><strong>${escapeHtml(t.title)}</strong>${t.sub ? ' · ' + escapeHtml(t.sub) : ''}</span><span class="tk-time">${escapeHtml(t.time || '')}</span></li>`).join('');
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
    if (li) { li.classList.toggle('done', box.checked); renderDayTotal(); }
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
      // "Closing soon" — the money panel: every escrow deal with its color,
      // COE date, days-to-close, and the commission it pays (internal), plus
      // expected totals. Replaces the static at-a-glance counts.
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
      const rows = escrow.map((d) => {
        const c = window.LegacyDealColors ? window.LegacyDealColors.get(d.lead_id) : null;
        const late = d.days_to_coe != null && d.days_to_coe < 0;
        const chip = d.days_to_coe == null ? '' : `<em class="chg ${late ? 'dn' : ''}" style="margin-left:6px;">${late ? Math.abs(d.days_to_coe) + 'd late' : d.days_to_coe + 'd'}</em>`;
        return `<div class="tb-pulse-row" data-open-deal="${escapeHtml(d.lead_id || '')}" style="cursor:pointer;" title="Open this deal">
          <span style="display:flex;align-items:center;gap:7px;min-width:0;"><span style="width:9px;height:9px;border-radius:50%;flex:none;background:${c ? c.border : 'var(--brass)'};"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml((d.address || d.lead_id || '').split(',')[0])}</span></span>
          <span class="v">${escapeHtml(fmtCoe(d.coe_date))}${chip}<span style="display:block;font-size:11px;color:var(--ink-mute);font-weight:400;">${d.commission_usd != null ? money(d.commission_usd) + (d.agent ? ' · ' + (d.agent === 'james' ? 'James' : 'Sara') : '') : 'commission n/a'}</span></span>
        </div>`;
      }).join('');
      assessEl.innerHTML = `
        <div class="tb-pulse">
          <span class="label-cap">Closing soon · ${escrow.length} in escrow</span>
          ${rows || '<div class="tb-pulse-row"><span>Nothing in escrow right now.</span><span class="v"></span></div>'}
          <div class="tb-pulse-row" style="border-top:1px solid var(--rule);margin-top:8px;padding-top:8px;font-weight:600;"><span>Expected this month</span><span class="v">${money(totalMonth)}</span></div>
          <div class="tb-pulse-row" style="font-weight:600;"><span>Next 60 days</span><span class="v">${money(total60)}</span></div>
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
      setAll('[data-roster-leads]',        r.leads_total);
      setAll('[data-roster-clients]',      r.clients);
      setAll('[data-roster-past]',         r.past_clients);
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
      card.className = idx === 0 && lead.temperature === 'hot' ? 'need-card need-card-hot' : 'need-card';
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
    if (/\/seller\.html$/.test(path)) {
      // Private-link access (?t=<portal_token>) needs no login — the token is
      // the credential. Only gate when there's no token.
      const hasToken = new URLSearchParams(location.search).get('t');
      if (!hasToken) await gate(['seller','agent_sara','agent_james','admin']);
    }
  });

  // expose for debugging
  window.Legacy = { api, openModal, submitLead };
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
  if (!/\/seller\.html$/.test(location.pathname)) return;

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
      paintList(c, arr);
    });
  }

  async function loadSeller() {
    let res;
    const params = new URLSearchParams(location.search);
    const token = params.get('t');
    const deal  = params.get('deal');   // agent preview of a specific deal
    let url = '/api/seller/portal';
    if (token)     url += '?t=' + encodeURIComponent(token);
    else if (deal) url += '?deal=' + encodeURIComponent(deal);
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
    } catch (_) { return; }
    if (!res.ok) return;            // 401 → gate handles sign-in
    let json = null;
    try { json = await res.json(); } catch (_) { return; }
    const portal = json && json.portal ? json.portal : json;
    window.__legacySellerPortal = portal;
    paintPortal(portal);
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
    const counts = { all: state.leads.length, hot: 0, warm: 0, new: 0, cold: 0 };
    const seg = { clients: 0, past: 0, sphere: 0 };
    state.leads.forEach((l) => {
      if (counts[l.temperature] != null) counts[l.temperature]++;
      const s = STAGE_NORM[l.pipeline_stage] || l.pipeline_stage;
      if (SEGMENTS.clients(s)) seg.clients++;
      else if (s === 'closed') seg.past++;
      else if (s === 'sphere') seg.sphere++;
    });
    document.querySelectorAll('[data-count]').forEach((el) => {
      const k = el.getAttribute('data-count');
      if (counts[k] != null) el.textContent = String(counts[k]);
    });
    // Roster sidebar pills — segment-accurate.
    const setPill = (sel, n) => document.querySelectorAll(sel).forEach((el) => { el.textContent = String(n); });
    setPill('[data-roster-leads]', state.leads.length);
    setPill('[data-roster-clients]', seg.clients);
    setPill('[data-roster-past]', seg.past);
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
    const contactEditorHtml = `
      <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink-soft);">
        ${lead.phone ? `<span>📞 ${escHtml(lead.phone)}</span>` : ''}
        ${lead.email ? `<span>✉ ${escHtml(lead.email)}</span>` : ''}
        <button class="btn-link lp-editlink" data-detail-action="edit-consent" style="font-size:12px;background:none;border:none;cursor:pointer;padding:0;color:var(--brass);">Update contact</button>
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
        <div data-assign-deal-row style="display:${(lead.buyer_stage === 'in_escrow' || lead.seller_stage === 'in_escrow') ? 'flex' : 'none'};align-items:center;gap:8px;margin:6px 0;">
          <span style="${cap}">Deal</span>
          <select data-assign-deal style="${fld}"><option value="">— loading deals… —</option></select>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px;">
          <button class="btn btn-ink btn-sm" data-detail-action="save-consent">Save contact</button>
          <span data-consent-status-msg style="font-size:12px;"></span>
        </div>
      </div>`;

    const pendingDraft = messages.find((m) => m.status === 'pending_approval' && m.ai_generated);
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
            <button class="btn btn-brass btn-sm" data-detail-action="approve">Send as ${escHtml(leadAgent.first)} →</button>
          </div>
        </div>
        <div data-detail-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
      </div>` : '';

    const threadHtml = otherMessages.length === 0
      ? `<div style="padding:16px;opacity:.55;font-style:italic;">No conversation yet.</div>`
      : otherMessages.map((m) => {
          const them = m.direction === 'inbound';
          const who  = them ? fullName(lead) : leadAgent.full;
          const init = them ? initials : leadAgent.initials;
          return `
            <div class="msg-bubble ${them ? 'them' : 'us'}">
              <div class="avatar avatar-sm">${escHtml(init)}</div>
              <div>
                <div class="mb-head">
                  <span class="mb-name">${escHtml(who)}</span>
                  <span class="mb-when">${escHtml(fmtRel(m.created_at))}</span>
                  <span class="mb-ch">${m.channel === 'sms' ? 'SMS' : 'Email'}</span>
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
      const portalOk = lead.portal_token && !isBuyer;
      const previewTitle = isBuyer
        ? 'Your Search'
        : `Your Sale — ${(lead.areas && lead.areas[0]) || 'Your listing'}`;
      return `
        <div class="lp-preview">
          ${portalOk ? `<div class="lp-urlchip"><span class="dot"></span>${escHtml(location.host)}/seller.html?t=${escHtml(mask(lead.portal_token))}</div>` : ''}
          <div class="lp-preview-head">
            <div>
              <div class="lp-preview-title">${escHtml(previewTitle)}</div>
              <div class="lp-preview-sub">What ${escHtml(clientFirst)} sees, live</div>
            </div>
            <div class="lp-preview-avatar">${escHtml(initials)}</div>
          </div>
          ${wire}
          <div class="lp-eyebrow" style="margin-top:18px;margin-bottom:10px;">Upcoming</div>
          ${cards}
        </div>`;
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
          ${lead.portal_token && lead.deal_side !== 'buyer'
            ? `<span class="lp-hpill live" title="This client has a live private portal link"><span class="dot"></span>Portal live · token active</span>`
            : ''}
          ${lead.phone
            ? `<a class="btn btn-ghost btn-sm" href="tel:${escHtml(lead.phone)}" title="Call ${escHtml(lead.phone)}">Call</a>`
            : `<button class="btn btn-ghost btn-sm" disabled title="No phone number on file">Call</button>`}
          <button class="btn btn-ghost btn-sm" data-detail-action="schedule" title="Open the calendar to book a tour">Schedule</button>
          ${lead.portal_token && lead.deal_side !== 'buyer'
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

    // Copy the client's private, no-login portal link.
    const portalBtn = detailEl.querySelector('[data-detail-action="portal-link"]');
    if (portalBtn) portalBtn.addEventListener('click', () => {
      const link = `${location.origin}/seller.html?t=${encodeURIComponent(lead.portal_token)}`;
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
        const who = lead.first_name || 'the client';
        // Every registry action lands INTERNAL first — the agent edits the
        // wording, then toggles it on to share. Nothing auto-reaches the portal.
        if (group === 'schedule') {
          // Scheduling actions open the calendar to create the real event.
          toast(`"${label}" logged. Opening the calendar to schedule it.`);
          if (typeof window.showView === 'function') window.showView(null, 'cal');
        } else {
          toast(`"${label}" added to ${who}'s workspace — internal for now. Toggle it on when you're ready to share.`);
          selectLeadId(lead.id);   // refresh so the new item appears in the Deal Workspace
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
      const dealRow  = consentPanel.querySelector('[data-assign-deal-row]');
      const dealSel  = consentPanel.querySelector('[data-assign-deal]');
      let dealsLoaded = false;
      // When either side reaches "In escrow", offer a deal to link the contact
      // to (their portal). Populate the dropdown lazily from /api/crm/listings.
      async function loadDealOptions() {
        if (dealsLoaded || !dealSel) return;
        dealsLoaded = true;
        const r = await window.Legacy.api('/api/crm/listings', { method: 'GET' });
        const j = r.ok ? r.json : {};
        const all = [...(j.active || []), ...(j.pending || []), ...(j.preparing || []), ...(j.closed || [])];
        const cur = lead.deal_source_key || (lead.deal && lead.deal.source_key) || '';
        dealSel.innerHTML = '<option value="">— pick a deal —</option>' + all.map((d) => {
          const label = [d.address, d.city].filter(Boolean).join(', ') || d.source_key;
          return `<option value="${escHtml(d.source_key)}"${cur === d.source_key ? ' selected' : ''}>${escHtml(label)}</option>`;
        }).join('');
        if (!all.length) dealSel.innerHTML = '<option value="">No deals found</option>';
      }
      const syncRows = () => {
        const v = sideSel ? sideSel.value : '';
        if (buyRow)  buyRow.style.display  = (v === 'buyer'  || v === 'both') ? 'flex' : 'none';
        if (sellRow) sellRow.style.display = (v === 'seller' || v === 'both') ? 'flex' : 'none';
        const buyEsc  = buyStageSel  && (v === 'buyer'  || v === 'both') && buyStageSel.value  === 'in_escrow';
        const sellEsc = sellStageSel && (v === 'seller' || v === 'both') && sellStageSel.value === 'in_escrow';
        if (dealRow) dealRow.style.display = (buyEsc || sellEsc) ? 'flex' : 'none';
        if (buyEsc || sellEsc) loadDealOptions();
      };
      if (sideSel)      sideSel.addEventListener('change', syncRows);
      if (buyStageSel)  buyStageSel.addEventListener('change', syncRows);
      if (sellStageSel) sellStageSel.addEventListener('change', syncRows);
      // If the contact is already in escrow, load the deal list on open.
      if (dealRow && dealRow.style.display !== 'none') loadDealOptions();
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
        // In escrow + a deal picked → link the contact to their deal (portal).
        const dealKey = (dealRow && dealRow.style.display !== 'none' && dealSel) ? dealSel.value : '';
        let linkMsg = '';
        if (dealKey) {
          const email = (patch.email || lead.email || '').trim();
          if (!email) {
            linkMsg = ' — add an email to link the deal.';
          } else {
            const role = (patch.buyer_stage === 'in_escrow') ? 'buyer' : 'seller';
            const lr = await window.Legacy.api('/api/crm/link-deal-party', {
              method: 'POST',
              body: { deal: dealKey, email, first_name: patch.first_name || undefined, last_name: patch.last_name || undefined, phone: patch.phone || undefined, role, provision: false }
            });
            linkMsg = (lr.ok && lr.json && lr.json.linked) ? ' Linked to deal.' : ' — deal link failed.';
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

    // Wire the composer (channel toggle, Note/Internal placeholders, Send).
    wireComposer(detailEl, lead);

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
        ${notesPanelHtml}
        ${activityHtml}
      </div>
      <div class="lp-section">
        <h3>Saved · ${saved.length} propert${saved.length === 1 ? 'y' : 'ies'}</h3>
        ${savedHtml}
      </div>
      ${tours.length ? `<div class="lp-section"><h3>Tours · ${tours.length}</h3>${tours.slice(0,3).map((t) => `<div class="tl-item"><div class="tl-dot"></div><div><div class="tl-text"><strong>${escHtml(t.properties && t.properties.address || 'Tour')}</strong></div><div class="tl-when">${escHtml(fmtRel(t.scheduled_at))} · ${escHtml(t.status || '')}</div></div></div>`).join('')}</div>` : ''}
      ${offers.length ? `<div class="lp-section"><h3>Offers · ${offers.length}</h3>${offers.slice(0,3).map((o) => `<div class="tl-item"><div class="tl-dot ink"></div><div><div class="tl-text"><strong>${escHtml(fmtUSD(o.amount))}</strong> · ${escHtml(o.status || '')}</div><div class="tl-when">${escHtml(o.properties && o.properties.address || '')}</div></div></div>`).join('')}</div>` : ''}
    `;
    detailEl.insertAdjacentHTML('beforeend', `<details class="lp-agent-details"><summary>Agent details · internal</summary><div class="lp-agent-details-body">${railHtml}</div></details>`);

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
  function wireComposer(detailEl, lead) {
    const composer  = detailEl.querySelector('[data-composer]');
    if (!composer) return;
    const subjectEl = composer.querySelector('[data-composer-subject]');
    const bodyEl    = composer.querySelector('[data-composer-body]');
    const statusEl  = composer.querySelector('[data-composer-status]');
    const sendBtn   = composer.querySelector('[data-detail-action="send"]');
    const suggestBtn = composer.querySelector('[data-detail-action="suggest-reply"]');
    const tabs      = Array.from(composer.querySelectorAll('[data-composer-tab]'));

    let channel = 'email';

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
        r = await window.Legacy.api('/api/crm/message', {
          body: {
            lead_id: lead.id,
            channel,
            body:    text,
            subject: channel === 'email' ? subject : undefined
          }
        });
      }

      const success = isNote
        ? (r.ok && r.json && r.json.note)
        : (r.ok && r.json && r.json.status === 'sent');

      if (success) {
        statusEl.style.color = '#2E5C3D';
        statusEl.textContent = isNote
          ? `Note saved · ${channel === 'internal' ? 'internal' : 'private to agents'}`
          : `Sent via ${(r.json.provider && r.json.provider.via) || channel}`;
        bodyEl.value = '';
        if (subjectEl) subjectEl.value = '';
        sendBtn.textContent = isNote ? 'Saved' : 'Sent';
        setTimeout(() => { loadLead(lead.id); if (!isNote) refreshLeadListPreview(lead.id); }, 600);
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
    const on = document.querySelector('[data-side-filter] .chip.on');
    return (on && on.getAttribute('data-side')) || 'all';
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

  let lastPipelineData = null;
  function paintKanban(pipelineData) {
    if (pipelineData) lastPipelineData = pipelineData;
    const data = pipelineData || lastPipelineData;
    if (!data) return;
    const kan = document.querySelector('[data-kanban]');
    if (!kan) return;

    // Flatten every active lead the pipeline API returned (all groups incl.
    // sphere), then re-bucket by the active board's axis.
    const allLeads = (data.stages || []).flatMap((s) => s.leads || []);
    const side  = activeSideFilter();
    const board = kanBoardFor(side);
    const leads = allLeads.filter(board.keep);

    // Bucket + tally per column.
    const byCol = {};
    board.cols.forEach((c) => { byCol[c.key] = { leads: [], value: 0 }; });
    let totalValue = 0;
    for (const l of leads) {
      const k = board.bucket(l);
      const slot = byCol[k];
      if (!slot) continue;               // no matching column → drop (e.g. sphere)
      slot.leads.push(l);
      const mid = midPrice(l.price_min, l.price_max);
      if (mid) { slot.value += mid * 0.025; totalValue += mid * 0.025; }
    }

    kan.innerHTML = board.cols.map((c) => {
      const slot = byCol[c.key];
      slot.leads.sort((a, b) => (b.score || 0) - (a.score || 0));
      const cards = slot.leads.length
        ? slot.leads.slice(0, 12).map(kanCardHtml).join('')
        : `<div style="opacity:.4;font-style:italic;font-size:12px;padding:8px 4px;">Empty.</div>`;
      return `
        <div class="kan-col" data-stage="${escHtml(c.key)}" data-stage-field="${board.field}">
          <div class="kan-col-h"><span class="name">${escHtml(c.name)}</span><span class="count" data-stage-count>${slot.leads.length} · <span class="sum">${escHtml(fmtUSD(Math.round(slot.value)))}</span></span></div>
          <div class="kan-sub">${escHtml(c.sub)}</div>
          <div class="kan-body" data-stage-body>${cards}</div>
        </div>`;
    }).join('');

    kan.querySelectorAll('[data-lead-id]').forEach((card) => {
      card.addEventListener('click', () => {
        // Switch to the Inbox view (where the detail panel lives) so the
        // lead actually appears. The global is showView, defined in crm.html.
        if (typeof window.showView === 'function') window.showView(null, 'inbox');
        selectLeadId(card.getAttribute('data-lead-id'));
      });
    });

    const eyebrow = document.querySelector('[data-bind-pipe-eyebrow]');
    if (eyebrow) eyebrow.textContent = `Active pipeline · ${leads.length} lead${leads.length === 1 ? '' : 's'}`;
    const inflight = document.querySelector('[data-bind-pipe-inflight]');
    if (inflight) inflight.textContent = fmtUSD(Math.round(totalValue));

    // Wire HTML5 drag-and-drop so cards can be moved across stage columns.
    wireKanbanDnd();
  }

  function midPrice(min, max) {
    if (min && max) return (min + max) / 2;
    return min || max || 0;
  }
  function kanCardHtml(l) {
    const pill = tempPill(l.temperature);
    const mid  = midPrice(l.price_min, l.price_max);
    const home = (l.areas && l.areas[0]) || (l.journey_stage || '').replace(/_/g, ' ');
    return `
      <div class="kan-card" data-lead-id="${escHtml(l.id)}">
        <div class="name">${escHtml(fullName(l))} ${sideChipHtml(l.deal_side)}</div>
        <div class="home">${mid ? `<span class="price">${escHtml(fmtUSD(mid))}</span> · ` : ''}${escHtml(home || '—')}</div>
        <div class="kan-card-foot">
          <span class="pill-status ${pill}">${escHtml((l.temperature || 'new').replace(/^./, (c) => c.toUpperCase()))} · ${l.score == null ? '—' : l.score}</span>
          <span>· ${escHtml(fmtRel(l.updated_at))}</span>
        </div>
      </div>`;
  }

  // Buyer / Seller / Dual filter above the kanban — re-paints from cache.
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-side-filter] .chip');
    if (!chip) return;
    document.querySelectorAll('[data-side-filter] .chip').forEach((c) => c.classList.toggle('on', c === chip));
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

    const [pipelineRes, inboxRes] = await Promise.all([
      window.Legacy.api('/api/crm/pipeline', { method: 'GET' }),
      window.Legacy.api('/api/crm/inbox?filter=all&limit=100', { method: 'GET' })
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
    paintKanban(pipelineRes.json);

    if (allLeads.length) selectLeadId(allLeads[0].id);
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
  // Per-deal colour palette (muted, matches the site). Assigned by deal order so
  // each deal — in-escrow ones first — gets its own distinct colour.
  const DEAL_PALETTE = [
    { border: '#8C6E3D', bg: '#F3EAD6' }, { border: '#2E5C3D', bg: '#E4EFE7' },
    { border: '#7C5A16', bg: '#F3E7CE' }, { border: '#4A3B7C', bg: '#EAE6F3' },
    { border: '#8A3B2B', bg: '#F6E6E1' }, { border: '#2B6B6B', bg: '#DEEEEE' },
    { border: '#6B4A2B', bg: '#EFE3D6' }, { border: '#5C6B2E', bg: '#EDF0DE' },
    { border: '#7C2E5A', bg: '#F3DEEC' }, { border: '#3A5A8C', bg: '#DEE7F3' }
  ];
  function dealColorFor(key) { return (key && cal.dealColor[key]) || null; }
  const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cal = { week: 0, view: 'agenda', days: [], events: [], label: '', deals: [], dealFilter: '', dealColor: {} };
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
    el.innerHTML = order.map((k) => {
      const c = cal.dealColor[k]; const d = cal.deals.find((x) => x.key === k);
      const label = (d && d.address) || k;
      return `<span class="lg${cal.dealFilter === k ? ' on' : ''}" data-legend-deal="${esc(k)}"><span class="sw" style="background:${c ? c.border : '#8C6E3D'}"></span>${esc(label)}</span>`;
    }).join('');
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
      const evs = byDay[i];
      if (!evs || !evs.length) return;
      html += `<div class="cal-ag-day"><div class="cal-ag-dayhead${d.is_today ? ' today' : ''}"><span class="cal-ag-dow">${esc(d.dow)}</span><span class="cal-ag-date">${esc(monthName(d.date))} ${esc(d.num)}</span></div>`;
      evs.forEach((e) => {
        const c = dealColorFor(e.deal_key);
        // Events tied to a client get a visibility toggle: flip it on to add
        // the event to what that client sees in their portal.
        const toggle = e.lead_id ? `<label class="lp-toggle cal-ag-toggle" title="${e.shared ? 'Shown in the client’s portal' : 'Add this to what the client sees'}" onclick="event.stopPropagation()">
            <input type="checkbox" data-cal-share data-kind="${esc(e.source)}" data-id="${esc(e.id)}" ${e.shared ? 'checked' : ''}>
            <span class="lp-toggle-track"></span>
            <span class="lp-toggle-cap">${e.shared ? 'Visible' : 'Private'}</span>
          </label>` : '';
        const subBits = [];
        if (e.sub) subBits.push(esc(e.sub));
        if (e.deal_address && (!e.sub || String(e.sub).indexOf(e.deal_address) < 0)) subBits.push(esc(e.deal_address));
        const subHtml = subBits.length ? `<span class="cal-ag-sub">${subBits.join(' · ')}</span>` : '';
        html += `<div class="cal-ag-row" data-ev-key="${esc(e.source)}:${esc(e.id)}"${c ? ` style="border-left:3px solid ${c.border};padding-left:11px;"` : ''}>
          <span class="cal-ag-time">${esc(e.time_label)}–${esc(e.end_label)}</span>
          <span class="cal-ag-dot ${esc(e.cls)}"${c ? ` style="background:${c.border}"` : ''}></span>
          <span class="cal-ag-title">${esc(e.title)}${subHtml}</span>
          <span class="cal-ag-kind">${esc(e.kind_label || '')}</span>
          ${toggle}
        </div>`;
      });
      html += '</div>';
    });
    root.innerHTML = html;

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
  function renderWeek(root) {
    const heads = cal.days.map((d) => `<div class="calw-dayhead${d.is_today ? ' today' : ''}">${esc(d.dow)}<span class="num">${esc(d.num)}</span></div>`).join('');
    let times = '';
    for (let h = 0; h < 24; h++) times += `<div class="calw-hour">${h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM'}</div>`;
    let cols = '';
    for (let i = 0; i < 7; i++) {
      let lines = ''; for (let h = 0; h < 24; h++) lines += '<div class="calw-line"></div>';
      cols += `<div class="calw-col" data-cal-col="${i}">${lines}</div>`;
    }
    root.innerHTML = `<div class="calw-head"><div class="corner"></div>${heads}</div>
      <div class="calw-body"><div class="calw-grid"><div class="calw-times">${times}</div>${cols}</div></div>`;
    visibleEvents().forEach((e) => {
      const col = root.querySelector(`[data-cal-col="${e.day}"]`);
      if (!col) return;
      const c = dealColorFor(e.deal_key);
      const el = document.createElement('div');
      el.className = `calw-ev ${c ? 'deal' : (['tour', 'call', 'block', 'open'].includes(e.cls) ? e.cls : 'tour')}`;
      el.style.top = `${Math.round((e.hour * 60 + e.minute) * (CAL_ROW_H / 60))}px`;
      // Floor the height so a short (e.g. 30-min) event still fits its time +
      // title instead of clipping them; longer events grow with their duration.
      el.style.height = `${Math.max(42, Math.round(e.duration_minutes * (CAL_ROW_H / 60)))}px`;
      if (c) { el.style.background = c.bg; el.style.borderLeftColor = c.border; }
      el.setAttribute('data-ev-key', `${e.source}:${e.id}`);
      el.title = `${e.time_label} · ${e.title}${e.deal_address ? ' · ' + e.deal_address : ''}`;
      el.innerHTML = `<span class="t">${esc(e.time_label)}</span><span class="ti">${esc(e.title)}</span>`;
      col.appendChild(el);
    });
    const body = root.querySelector('.calw-body');
    if (body) body.scrollTop = 7 * CAL_ROW_H; // open near 7 AM
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

  function openEventCreate(prefill) {
    prefill = prefill || {};
    const m = modalShell('Add to calendar', 'A tour is tied to a client; a listing appt, showing, follow-up, inspection, call, or block is a general event (add a client email to share it to their portal).');
    m.body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div><label style="${M_LAB}">Event type</label><select data-f-kind style="${M_INPUT}">
          <option value="tour">Client tour</option>
          <option value="listing_appt">Listing appt</option>
          <option value="showing">Showing</option>
          <option value="follow_up">Follow-up</option>
          <option value="inspection">Inspection</option>
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
          <div data-insp-row style="display:none;">
            <label style="${M_LAB}">Inspection type</label>
            <select data-f-subkind style="${M_INPUT}">
              <option value="Home">Home</option>
              <option value="Pest">Pest</option>
              <option value="Roof">Roof</option>
              <option value="Well &amp; Septic">Well &amp; Septic</option>
              <option value="__other">Other…</option></select>
            <input data-f-subother placeholder="What kind of inspection?" style="${M_INPUT};display:none;margin-top:8px;">
          </div>
          <div><label style="${M_LAB}">Title <span style="text-transform:none;letter-spacing:0;">(optional)</span></label><input data-f-title placeholder="Auto-named from the type if left blank" style="${M_INPUT}"></div>
          <div><label style="${M_LAB}">Client email <span style="text-transform:none;letter-spacing:0;">(optional · lets you share to their portal)</span></label><input data-f-apptemail type="email" placeholder="client@example.com" style="${M_INPUT}"></div>
        </div>
        <div style="display:flex;gap:10px;">
          <div style="flex:1;"><label style="${M_LAB}">Date</label><input data-f-date type="date" style="${M_INPUT}"></div>
          <div style="flex:0 0 120px;"><label style="${M_LAB}">Time</label><input data-f-time type="time" style="${M_INPUT}"></div>
          <div style="flex:0 0 110px;"><label style="${M_LAB}">Minutes</label><input data-f-dur type="number" min="15" step="15" value="30" style="${M_INPUT}"></div>
        </div>
        <div><label style="${M_LAB}">Link to deal <span style="text-transform:none;letter-spacing:0;">(optional)</span></label><select data-f-deal style="${M_INPUT}"><option value="">No deal</option></select></div>
        <div><label style="${M_LAB}">Additional invitees <span style="text-transform:none;letter-spacing:0;">(comma-separated emails — TC, lender, co-op agent; both agents are included automatically)</span></label><input data-f-invitees placeholder="tc@title.com, lender@bank.com" style="${M_INPUT}"></div>
        <div><label style="${M_LAB}">Notes</label><textarea data-f-notes rows="2" style="${M_INPUT}"></textarea></div>
        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
          <button type="button" data-save style="${M_INK}">Add event</button>
          <button type="button" data-cancel style="${M_GHOST};margin-left:auto;">Cancel</button>
        </div>
      </div>`;
    const kindSel = m.body.querySelector('[data-f-kind]');
    const tourFields = m.body.querySelector('[data-tour-fields]');
    const apptFields = m.body.querySelector('[data-appt-fields]');
    const inspRow = m.body.querySelector('[data-insp-row]');
    const subSel = m.body.querySelector('[data-f-subkind]');
    const subOther = m.body.querySelector('[data-f-subother]');
    const saveBtn = m.body.querySelector('[data-save]');
    const syncKind = () => {
      const isTour = kindSel.value === 'tour';
      tourFields.style.display = isTour ? 'flex' : 'none';
      apptFields.style.display = isTour ? 'none' : 'flex';
      inspRow.style.display = kindSel.value === 'inspection' ? 'block' : 'none';
      saveBtn.textContent = isTour ? 'Schedule tour' : 'Add event';
    };
    kindSel.addEventListener('change', syncKind); syncKind();

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
        const r = await window.Legacy.api('/api/crm/roster?bucket=leads&q=' + encodeURIComponent(q) + '&limit=8', { method: 'GET' });
        const people = (r.ok && r.json && r.json.people) || [];
        csRes.innerHTML = people.length ? `<div style="position:absolute;z-index:50;left:0;right:0;background:#fff;border:1px solid #D9CFB7;max-height:200px;overflow:auto;">${people.map((pp) => `<div data-cs-pick data-cs-name="${esc(pp.name)}" data-cs-email="${esc(pp.email || '')}" style="padding:8px 12px;cursor:pointer;font-size:13.5px;border-bottom:1px solid #EFE7D6;">${esc(pp.name)} <span style="color:#7A6F60;font-size:12px;">${esc(pp.email || pp.phone || '')}</span></div>`).join('')}</div>` : '';
      }, 300);
    });
    csRes.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-cs-pick]');
      if (pick) applyClient(pick.getAttribute('data-cs-name'), pick.getAttribute('data-cs-email'));
    });

    // Deal linking → stamps the notes so the command center picks it up.
    const dealSel = m.body.querySelector('[data-f-deal]');
    fetch('/api/crm/listings', { credentials: 'include' }).then((r) => r.ok ? r.json() : null).then((j) => {
      if (!j || !dealSel) return;
      const all = [].concat(j.pending || [], j.offers || [], j.active || [], j.preparing || []);
      dealSel.innerHTML = '<option value="">No deal</option>' + all.map((d) =>
        `<option value="${esc(d.source_key || '')}" data-addr="${esc(d.address || '')}">${esc(d.address || d.source_key)}${d.stage ? ' · ' + esc(d.stage) : ''}</option>`).join('');
      if (prefill.deal) dealSel.value = prefill.deal;
    }).catch(() => {});

    // Prefill from a client page ("Schedule" on a lead) or a deal.
    if (prefill.name || prefill.email) applyClient(prefill.name || prefill.email, prefill.email || '');
    if (prefill.kind) { kindSel.value = prefill.kind; syncKind(); }
    subSel.addEventListener('change', () => { subOther.style.display = subSel.value === '__other' ? 'block' : 'none'; });
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    saveBtn.addEventListener('click', async () => {
      const kind = kindSel.value;
      const date = m.body.querySelector('[data-f-date]').value;
      const time = m.body.querySelector('[data-f-time]').value;
      if (!date || !time) { m.err.textContent = 'Pick a date and time.'; return; }
      let notesVal = m.body.querySelector('[data-f-notes]').value.trim();
      const dealSelEl = m.body.querySelector('[data-f-deal]');
      if (dealSelEl && dealSelEl.value) {
        const opt = dealSelEl.options[dealSelEl.selectedIndex];
        notesVal = (notesVal ? notesVal + '\n' : '') + `[deal:${dealSelEl.value} · ${opt ? opt.getAttribute('data-addr') || '' : ''}]`;
      }
      const inviteesRaw = (m.body.querySelector('[data-f-invitees]').value || '').split(',').map((x) => x.trim()).filter(Boolean);
      const common = { date, time, duration_minutes: parseInt(m.body.querySelector('[data-f-dur]').value, 10) || 30, notes: notesVal, invitees: inviteesRaw };
      let payload;
      if (kind === 'tour') {
        const email = m.body.querySelector('[data-f-email]').value.trim();
        if (!email) { m.err.textContent = 'Client email is required for a tour.'; return; }
        payload = { kind: 'tour', email, first_name: m.body.querySelector('[data-f-first]').value.trim(),
          last_name: m.body.querySelector('[data-f-last]').value.trim(), tour_type: m.body.querySelector('[data-f-type]').value,
          send_invite: m.body.querySelector('[data-f-invite]').checked, ...common };
      } else {
        payload = { kind, ...common };
        const title = m.body.querySelector('[data-f-title]').value.trim();
        if (title) payload.title = title;   // optional — the server auto-names structured types
        const email = m.body.querySelector('[data-f-apptemail]').value.trim();
        if (email) payload.email = email;    // optional — links the lead so it can be shared
        if (kind === 'inspection') {
          payload.sub_kind = subSel.value === '__other' ? (subOther.value.trim() || null) : subSel.value;
        }
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; m.err.textContent = '';
      const r = await sendJSON('/api/crm/calendar', 'POST', payload);
      if (r.ok && r.json && (r.json.tour || r.json.appointment)) {
        m.close();
        cal.week = Math.round((mondayOf(date + 'T12:00') - mondayOf(new Date())) / (7 * 86400000));
        loadCalendar(cal.week);
      } else { m.err.textContent = (r.json && r.json.error) || 'Could not save.'; saveBtn.disabled = false; syncKind(); }
    });
  }

  function openEventEdit(e) {
    const ed = e.edit || {};
    const isTour = e.source === 'tour';
    const m = modalShell('Edit event', isTour ? 'Reschedule or update this tour.' : 'Update this event.');
    const apptKinds = [['listing_appt', 'Listing appt'], ['showing', 'Showing'], ['follow_up', 'Follow-up'], ['inspection', 'Inspection'], ['call', 'Call'], ['block', 'Block / personal'], ['open', 'Open house'], ['meeting', 'Meeting']];
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
          <div style="flex:1;"><label style="${M_LAB}">Date</label><input data-f-date type="date" value="${esc(ed.date || '')}" style="${M_INPUT}"></div>
          <div style="flex:0 0 120px;"><label style="${M_LAB}">Time</label><input data-f-time type="time" value="${esc(ed.time || '')}" style="${M_INPUT}"></div>
          <div style="flex:0 0 110px;"><label style="${M_LAB}">Minutes</label><input data-f-dur type="number" min="15" step="15" value="${esc(ed.duration_minutes || 30)}" style="${M_INPUT}"></div>
        </div>
        <div><label style="${M_LAB}">Notes</label><textarea data-f-notes rows="2" style="${M_INPUT}">${esc(ed.notes || '')}</textarea></div>
        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
          <button type="button" data-save style="${M_INK}">Save changes</button>
          <button type="button" data-cancel style="${M_GHOST};margin-left:auto;">Cancel</button>
        </div>
      </div>`;
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    const kindSelE = m.body.querySelector('[data-f-kind]');
    if (kindSelE) kindSelE.addEventListener('change', () => { const ins = m.body.querySelector('[data-e-insp]'); if (ins) ins.style.display = kindSelE.value === 'inspection' ? 'block' : 'none'; });
    const saveBtn = m.body.querySelector('[data-save]');
    saveBtn.addEventListener('click', async () => {
      const date = m.body.querySelector('[data-f-date]').value;
      const time = m.body.querySelector('[data-f-time]').value;
      if (!date || !time) { m.err.textContent = 'Pick a date and time.'; return; }
      const payload = { id: e.id, source: e.source, date, time, duration_minutes: parseInt(m.body.querySelector('[data-f-dur]').value, 10) || 30, notes: m.body.querySelector('[data-f-notes]').value.trim() };
      if (isTour) payload.tour_type = m.body.querySelector('[data-f-type]').value;
      else {
        payload.kind = m.body.querySelector('[data-f-kind]').value;
        const t = m.body.querySelector('[data-f-title]').value.trim();
        if (!t) { m.err.textContent = 'A title is required.'; return; }
        payload.title = t;
        const sk = m.body.querySelector('[data-f-subkind]');
        if (sk) payload.sub_kind = sk.value.trim() || null;
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
        ${e.lead_id ? `<label style="display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid #E4DAC4;font-size:13px;color:#1A1714;cursor:pointer;"><input type="checkbox" data-detail-share ${e.shared ? 'checked' : ''}> Show in ${esc(e.client_name || 'the client')}’s portal</label>` : ''}
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

