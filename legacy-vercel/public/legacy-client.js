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

  async function wireCrmPage(session) {
    // Run all three loaders in parallel
    const [briefRes, inboxRes, pipelineRes] = await Promise.all([
      api('/api/crm/morning-brief', { method: 'GET' }),
      api('/api/crm/inbox?filter=awaiting_reply&limit=20', { method: 'GET' }),
      api('/api/crm/pipeline', { method: 'GET' })
    ]);

    if (briefRes.ok)    paintMorningBrief(briefRes.json, session);
    if (inboxRes.ok)    paintQuietAsks(inboxRes.json.messages || []);
    if (pipelineRes.ok) paintPipelineStats(pipelineRes.json);
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
  }

  function paintQuietAsks(drafts) {
    const needs = $('.needs');
    if (!needs) return;

    // Update section header label + heading
    const eyebrow = needs.querySelector('.eyebrow');
    if (eyebrow) eyebrow.textContent = drafts.length
      ? `Needs you · ${drafts.length} draft${drafts.length === 1 ? '' : 's'} awaiting approval`
      : 'Needs you · inbox at zero';
    const h2 = needs.querySelector('.h-section');
    if (h2) h2.textContent = drafts.length
      ? (drafts.length === 1 ? 'One quiet ask.' : `${drafts.length} quiet ask${drafts.length === 1 ? '' : 's'}.`)
      : 'Nothing pending.';

    // Remove all existing .need-card elements (prototype data)
    needs.querySelectorAll('.need-card').forEach(el => el.remove());

    if (drafts.length === 0) {
      const empty = document.createElement('article');
      empty.className = 'need-card';
      empty.innerHTML = `<div class="nc-body"><p style="opacity:.7;font-style:italic;">All drafts approved. Sara, take the morning off.</p></div>`;
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
    if (/\/seller\.html$/.test(path))    await gate(['seller','agent_sara','agent_james','admin']);
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
    try {
      res = await fetch('/api/seller/portal', {
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
  function avatarClassFor(temperature) {
    if (temperature === 'hot')  return 'avatar avatar-sm hot';
    if (temperature === 'warm') return 'avatar avatar-sm warm';
    return 'avatar avatar-sm';
  }

  const state = {
    leads: [],
    leadsById: new Map(),
    messageByLead: new Map(),
    activeFilter: 'all',
    selectedLeadId: null
  };

  function filterLeads() {
    const f = state.activeFilter;
    if (f === 'all') return state.leads;
    if (f === 'awaiting_reply') {
      return state.leads.filter((l) => {
        const m = state.messageByLead.get(l.id);
        return m && m.direction === 'inbound';
      });
    }
    return state.leads.filter((l) => l.temperature === f);
  }

  function paintLeadCounts() {
    const counts = { all: state.leads.length, hot: 0, warm: 0, new: 0, cold: 0 };
    state.leads.forEach((l) => { if (counts[l.temperature] != null) counts[l.temperature]++; });
    document.querySelectorAll('[data-count]').forEach((el) => {
      const k = el.getAttribute('data-count');
      if (counts[k] != null) el.textContent = String(counts[k]);
    });
  }

  function paintLeadList() {
    const container = document.querySelector('[data-lead-list]');
    if (!container) return;
    const leads = filterLeads();
    if (!leads.length) {
      container.innerHTML = `<div class="lead-row" style="opacity:.55;"><div class="lead-content"><div class="lead-name-row"><span class="lead-name" style="font-style:italic;">No leads in this filter yet.</span></div></div></div>`;
      return;
    }
    container.innerHTML = leads.map((l) => {
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
              ${tempBadge(l.temperature)}
              <span class="badge">${escHtml(leadTypeLabel(l))}</span>
              <span class="score">${l.score == null ? '—' : l.score}</span>
            </div>
          </div>
        </div>`;
    }).join('');
    container.querySelectorAll('[data-lead-id]').forEach((row) => {
      row.addEventListener('click', () => selectLeadId(row.getAttribute('data-lead-id')));
    });
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

    const initials = initialsOf(lead.first_name, lead.last_name, lead.email);
    const daysInPipeline = lead.created_at
      ? Math.max(0, Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000))
      : 0;
    const metaBits = [
      (lead.lead_type || 'lead').replace(/^./, (c) => c.toUpperCase()),
      (lead.areas && lead.areas[0]) || null,
      `${daysInPipeline} days in pipeline`,
      lead.temperature ? lead.temperature.replace(/^./, (c) => c.toUpperCase()) : null,
      `Score ${lead.score == null ? '—' : lead.score}`
    ].filter(Boolean);

    const pendingDraft = messages.find((m) => m.status === 'pending_approval' && m.ai_generated);
    const otherMessages = messages.filter((m) => m !== pendingDraft).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const draftHtml = pendingDraft ? `
      <div class="ai-draft" data-message-id="${escHtml(pendingDraft.id)}">
        <div class="ai-draft-head">
          <span class="ai-tag">Draft for your review</span>
          <span class="ai-source">${escHtml(pendingDraft.ai_draft_reasoning || 'AI-drafted reply awaiting approval')}</span>
        </div>
        <div class="ai-draft-body">
          <div class="ai-from">
            <div class="avatar avatar-sm"><img src="art/sara-headshot.png" alt="Sara"></div>
            <div>
              <div class="ld">From <strong>you</strong> · to <strong>${escHtml(fullName(lead))}</strong></div>
              <div class="sub">${pendingDraft.channel === 'sms' ? 'SMS' : 'Email'} · Will send only after you approve</div>
            </div>
          </div>
          ${pendingDraft.subject ? `<div class="ai-subject">${escHtml(pendingDraft.subject)}</div>` : ''}
          <p class="ai-msg" style="white-space:pre-wrap;" data-draft-body>${escHtml(pendingDraft.body || '')}</p>
        </div>
        <div class="ai-foot">
          <div class="ai-foot-l"><span><strong>Channel:</strong> ${pendingDraft.channel === 'sms' ? 'SMS' : 'Email'}</span></div>
          <div class="ai-foot-r">
            <button class="btn btn-ghost btn-sm" data-detail-action="edit">Edit</button>
            <button class="btn btn-brass btn-sm" data-detail-action="approve">Send as Sara →</button>
          </div>
        </div>
        <div data-detail-result style="font-size:13px;margin-top:8px;min-height:18px;"></div>
      </div>` : '';

    const threadHtml = otherMessages.length === 0
      ? `<div style="padding:16px;opacity:.55;font-style:italic;">No conversation yet.</div>`
      : otherMessages.map((m) => {
          const them = m.direction === 'inbound';
          const who  = them ? fullName(lead) : 'Sara Cooper';
          const init = them ? initials : 'SC';
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

    detailEl.innerHTML = `
      <div class="ld-head">
        <div class="ld-head-l">
          <div class="avatar avatar-lg" style="background: var(--hot); color: var(--shell); font-family: var(--serif); font-style: italic;">${escHtml(initials)}</div>
          <div>
            <h2>${escHtml(fullName(lead))}</h2>
            <div class="ld-head-meta">${escHtml(metaBits.join(' · '))}</div>
          </div>
        </div>
        <div class="ld-head-actions">
          <button class="btn btn-ghost btn-sm" disabled title="Click-to-call endpoint pending">◇ Call</button>
          <button class="btn btn-ghost btn-sm" disabled title="Tour scheduler endpoint pending">Schedule</button>
          <button class="btn btn-ink btn-sm" data-detail-action="enroll">Add to sequence</button>
        </div>
      </div>
      ${draftHtml}
      <div class="ld-thread">
        <div class="ld-thread-h">Conversation · ${messages.length} message${messages.length === 1 ? '' : 's'}</div>
        ${threadHtml}
      </div>
      <div class="composer" data-composer>
        <div class="composer-head">
          <span class="composer-tab on" data-composer-tab="email">Email</span>
          <span class="composer-tab" data-composer-tab="sms">SMS</span>
          <span class="composer-tab" data-composer-tab="note" title="Internal notes need a new lead_notes table — not wired yet">Note</span>
          <span class="composer-tab" data-composer-tab="internal" title="Internal notes need a new lead_notes table — not wired yet">Internal</span>
        </div>
        <input data-composer-subject placeholder="Subject" style="width:100%;border:1px solid #D9CFB7;padding:8px 10px;background:#fff;font:inherit;font-size:14px;margin-bottom:6px;">
        <textarea data-composer-body placeholder="Write to ${escHtml(fullName(lead))}…"></textarea>
        <div class="composer-foot">
          <div class="composer-tools"><span data-composer-status style="font-size:11px;opacity:.7;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;"></span></div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-ink btn-sm" data-detail-action="send">Send</button>
          </div>
        </div>
      </div>`;

    const draftEl = detailEl.querySelector('.ai-draft');
    if (draftEl && pendingDraft) wireDraftActions(draftEl, pendingDraft, lead);
    const enrollBtn = detailEl.querySelector('[data-detail-action="enroll"]');
    if (enrollBtn) enrollBtn.addEventListener('click', () => promptEnrollSequence(lead));

    // Wire the composer (channel toggle, Note/Internal placeholders, Send).
    wireComposer(detailEl, lead);

    const stages = ['new', 'nurture', 'touring', 'offer', 'close'];
    const stageIdx = Math.max(0, stages.indexOf(lead.pipeline_stage || 'new'));
    const stageHtml = stages.map((s, i) => {
      const cls = i < stageIdx ? 'done' : (i === stageIdx ? 'now' : '');
      return `<div class="stage-step ${cls}"><span class="l">${s.replace(/^./, (c) => c.toUpperCase())}</span></div>`;
    }).join('');

    const activityHtml = (events.slice(0, 8) || []).map((e) => {
      const d = e.event_data || {};
      // Stage move / reassignment (logged as score_change w/ event_data.change)
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
    profileEl.innerHTML = `
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
        <p style="font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; color: var(--ink-mute); margin-top: 10px; text-transform: uppercase;">In ${escHtml(lead.pipeline_stage || 'new')} · ${daysInPipeline}d</p>
      </div>
      <div class="lp-section">
        <h3>Assigned</h3>
        <div class="handoff">
          <div class="a">
            <div class="avatar avatar-sm" style="background: var(--brass); color: var(--shell); font-family: var(--serif); font-style: italic;">${assigned === 'james' ? 'JS' : 'SC'}</div>
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
        <h3>Activity · last events</h3>
        ${activityHtml}
      </div>
      <div class="lp-section">
        <h3>Saved · ${saved.length} propert${saved.length === 1 ? 'y' : 'ies'}</h3>
        ${savedHtml}
      </div>
      ${tours.length ? `<div class="lp-section"><h3>Tours · ${tours.length}</h3>${tours.slice(0,3).map((t) => `<div class="tl-item"><div class="tl-dot"></div><div><div class="tl-text"><strong>${escHtml(t.properties && t.properties.address || 'Tour')}</strong></div><div class="tl-when">${escHtml(fmtRel(t.scheduled_at))} · ${escHtml(t.status || '')}</div></div></div>`).join('')}</div>` : ''}
      ${offers.length ? `<div class="lp-section"><h3>Offers · ${offers.length}</h3>${offers.slice(0,3).map((o) => `<div class="tl-item"><div class="tl-dot ink"></div><div><div class="tl-text"><strong>${escHtml(fmtUSD(o.amount))}</strong> · ${escHtml(o.status || '')}</div><div class="tl-when">${escHtml(o.properties && o.properties.address || '')}</div></div></div>`).join('')}</div>` : ''}
    `;

    // Wire the Reassign button now that profileEl has the live markup.
    const reassignBtn = profileEl.querySelector('[data-detail-action="reassign"]');
    if (reassignBtn) reassignBtn.addEventListener('click', () => promptReassign(lead));
  }

  function wireDraftActions(card, message, lead) {
    const editBtn    = card.querySelector('[data-detail-action="edit"]');
    const approveBtn = card.querySelector('[data-detail-action="approve"]');
    const bodyEl     = card.querySelector('[data-draft-body]');
    const resultEl   = card.querySelector('[data-detail-result]');
    let editedTa = null;

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
        approveBtn.textContent = 'Send as Sara →';
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

  async function moveLeadToStage(leadId, newStage) {
    const stateLead = state.leadsById.get(leadId);
    if (!stateLead) return;
    const prevStage = stateLead.pipeline_stage;
    if (prevStage === newStage) return;

    // Optimistic
    stateLead.pipeline_stage = newStage;

    const r = await patchLead(leadId, { pipeline_stage: newStage });
    if (r.ok && r.json && r.json.lead) {
      // Server-truth — refresh kanban + (if this lead is open) the detail.
      // Cheapest reconcile: refetch the pipeline to get fresh counts/values.
      const pr = await window.Legacy.api('/api/crm/pipeline', { method: 'GET' });
      if (pr.ok) paintKanban(pr.json);
      if (state.selectedLeadId === leadId) loadLead(leadId);
    } else {
      // Roll back
      stateLead.pipeline_stage = prevStage;
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
        moveLeadToStage(leadId, newStage);
      });
    });
  }

  // ---- Composer (manual outbound via POST /api/crm/message) --------------
  function wireComposer(detailEl, lead) {
    const composer  = detailEl.querySelector('[data-composer]');
    if (!composer) return;
    const subjectEl = composer.querySelector('[data-composer-subject]');
    const bodyEl    = composer.querySelector('[data-composer-body]');
    const statusEl  = composer.querySelector('[data-composer-status]');
    const sendBtn   = composer.querySelector('[data-detail-action="send"]');
    const tabs      = Array.from(composer.querySelectorAll('[data-composer-tab]'));

    let channel = 'email';

    function setChannel(next) {
      channel = next;
      tabs.forEach((t) => t.classList.toggle('on', t.getAttribute('data-composer-tab') === next));
      const isNote = next === 'note' || next === 'internal';
      const isSms  = next === 'sms';
      if (isNote) {
        subjectEl.style.display = 'none';
        bodyEl.placeholder = 'Internal notes need a new lead_notes table — coordinate with backend before wiring.';
        bodyEl.disabled = true;
        bodyEl.style.opacity = '0.55';
        sendBtn.disabled = true;
        sendBtn.title    = 'Internal note endpoint pending';
        statusEl.textContent = 'NOTES NOT WIRED';
      } else {
        subjectEl.style.display = isSms ? 'none' : '';
        bodyEl.disabled = false;
        bodyEl.style.opacity = '';
        sendBtn.disabled = false;
        sendBtn.title = '';
        if (isSms) {
          if (!lead.phone) { sendBtn.disabled = true; statusEl.textContent = 'Lead has no phone'; bodyEl.placeholder = `No phone on file for ${fullName(lead)}.`; }
          else             { statusEl.textContent = '';                 bodyEl.placeholder = `Text ${fullName(lead)} (max 320 chars)`; }
        } else {
          if (!lead.email) { sendBtn.disabled = true; statusEl.textContent = 'Lead has no email'; bodyEl.placeholder = `No email on file for ${fullName(lead)}.`; }
          else             { statusEl.textContent = '';                 bodyEl.placeholder = `Email ${fullName(lead)}…`; }
        }
      }
    }
    tabs.forEach((t) => t.addEventListener('click', () => setChannel(t.getAttribute('data-composer-tab'))));
    setChannel('email');

    sendBtn.addEventListener('click', async () => {
      const text    = (bodyEl.value || '').trim();
      const subject = (subjectEl.value || '').trim();
      if (!text) { statusEl.textContent = 'Body is empty'; return; }
      if (channel === 'email' && !subject) { statusEl.textContent = 'Subject is required for email'; return; }

      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      statusEl.style.color = '';
      statusEl.textContent = 'Sending…';

      const r = await window.Legacy.api('/api/crm/message', {
        body: {
          lead_id: lead.id,
          channel,
          body:    text,
          subject: channel === 'email' ? subject : undefined
        }
      });

      if (r.ok && r.json && r.json.status === 'sent') {
        statusEl.style.color = '#2E5C3D';
        statusEl.textContent = `Sent via ${(r.json.provider && r.json.provider.via) || channel}`;
        bodyEl.value = '';
        if (subjectEl) subjectEl.value = '';
        sendBtn.textContent = 'Sent';
        // Refresh thread + the lead-list preview
        setTimeout(() => { loadLead(lead.id); refreshLeadListPreview(lead.id); }, 600);
        setTimeout(() => { sendBtn.textContent = 'Send'; sendBtn.disabled = false; }, 1800);
      } else {
        statusEl.style.color = '#9B2C2C';
        statusEl.textContent = (r.json && r.json.error) || 'Send failed.';
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
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

  function paintKanban(pipelineData) {
    const stages = (pipelineData && pipelineData.stages) || [];
    stages.forEach((stage) => {
      const col  = document.querySelector(`[data-stage="${stage.stage}"]`);
      if (!col) return;
      const head = col.querySelector('[data-stage-count]');
      const body = col.querySelector('[data-stage-body]');
      if (head) head.innerHTML = `${stage.count} · <span class="sum">${escHtml(fmtUSD(stage.estimated_value))}</span>`;
      if (!body) return;
      if (!stage.leads.length) {
        body.innerHTML = `<div style="opacity:.4;font-style:italic;font-size:12px;padding:8px 4px;">Empty.</div>`;
        return;
      }
      body.innerHTML = stage.leads.slice(0, 10).map((l) => {
        const pill = tempPill(l.temperature);
        const mid  = (l.price_min && l.price_max) ? (l.price_min + l.price_max) / 2 : (l.price_min || l.price_max || 0);
        const home = (l.areas && l.areas[0]) || (l.journey_stage || '').replace(/_/g, ' ');
        return `
          <div class="kan-card" data-lead-id="${escHtml(l.id)}">
            <div class="name">${escHtml(fullName(l))}</div>
            <div class="home">${mid ? `<span class="price">${escHtml(fmtUSD(mid))}</span> · ` : ''}${escHtml(home || '—')}</div>
            <div class="kan-card-foot">
              <span class="pill-status ${pill}">${escHtml((l.temperature || 'new').replace(/^./, (c) => c.toUpperCase()))} · ${l.score == null ? '—' : l.score}</span>
              <span>· ${escHtml(fmtRel(l.updated_at))}</span>
            </div>
          </div>`;
      }).join('');
      body.querySelectorAll('[data-lead-id]').forEach((card) => {
        card.addEventListener('click', () => {
          if (typeof window.selectView === 'function') window.selectView('inbox');
          selectLeadId(card.getAttribute('data-lead-id'));
        });
      });
    });

    const eyebrow = document.querySelector('[data-bind-pipe-eyebrow]');
    if (eyebrow) eyebrow.textContent = `Active pipeline · ${pipelineData.total_leads || 0} lead${pipelineData.total_leads === 1 ? '' : 's'}`;
    const inflight = document.querySelector('[data-bind-pipe-inflight]');
    if (inflight) inflight.textContent = fmtUSD(pipelineData.total_estimated_value || 0);

    // Wire HTML5 drag-and-drop so cards can be moved across stage columns.
    wireKanbanDnd();
  }

  async function loadLead(id) {
    const detailEl = document.querySelector('[data-lead-detail]');
    if (detailEl) detailEl.innerHTML = `<div style="padding:24px;opacity:.55;font-style:italic;">Loading…</div>`;
    const r = await window.Legacy.api(`/api/crm/lead?id=${encodeURIComponent(id)}`, { method: 'GET' });
    if (r.ok) paintLeadDetail(r.json);
    else if (detailEl) detailEl.innerHTML = `<div style="padding:24px;color:#9B2C2C;">${escHtml((r.json && r.json.error) || 'Could not load lead.')}</div>`;
  }

  function selectLeadId(id) {
    if (state.selectedLeadId === id) return;
    state.selectedLeadId = id;
    document.querySelectorAll('[data-lead-list] [data-lead-id]').forEach((r) => {
      r.classList.toggle('on', r.getAttribute('data-lead-id') === id);
    });
    loadLead(id);
  }

  async function bootCrmInbox() {
    if (!window.Legacy || !window.Legacy.api) { setTimeout(bootCrmInbox, 50); return; }
    paintFilters();

    const [pipelineRes, inboxRes] = await Promise.all([
      window.Legacy.api('/api/crm/pipeline', { method: 'GET' }),
      window.Legacy.api('/api/crm/inbox?filter=all&limit=100', { method: 'GET' })
    ]);
    if (!pipelineRes.ok) return;

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
})();

