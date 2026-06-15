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
    const session = await ensureSession(requiredRoles);
    if (session) return session;

    // Replace the page with an inline sign-in card (no HTML edits needed).
    document.body.innerHTML = '';
    document.body.style.cssText = 'background:#1A1714;color:#FAF6EC;font-family:Manrope,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:460px;width:100%;background:#FAF6EC;color:#1A1714;padding:36px 32px;';
    // Mode is determined by the PRIMARY (first) required role, not whether
    // agents are also allowed. CRM = password. Buyer/seller dashboards = magic link.
    const primaryRole = (requiredRoles || [])[0] || '';
    const isAgent = primaryRole.startsWith('agent_') || primaryRole === 'admin';
    const prefillEmail = new URLSearchParams(location.search).get('email') || '';
    card.innerHTML = `
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:10px;">Legacy Properties</div>
      <h2 style="font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:30px;margin:0 0 14px;">${isAgent ? 'Open the desk.' : 'See your dashboard.'}</h2>
      ${isAgent ? '' : '<p style="font-size:14px;line-height:1.55;color:#3A332B;margin:0 0 18px;">Enter your email and we will send you a one-click link. No password to remember.</p>'}
      <form id="leg-auth" style="display:flex;flex-direction:column;gap:10px;">
        <input name="email" type="email" placeholder="Email" required value="${prefillEmail.replace(/"/g,'')}" style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">
        ${isAgent ? '<input name="password" type="password" placeholder="Password" required style="font-size:15px;padding:10px 12px;border:1px solid #D9CFB7;background:#fff;">' : ''}
        <button type="submit" style="background:#1A1714;color:#FAF6EC;border:none;padding:14px;font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;cursor:pointer;">${isAgent ? 'Sign in' : 'Email me the link'}</button>
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
        if (r.ok) {
          // Replace the form with a confirmation panel
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
