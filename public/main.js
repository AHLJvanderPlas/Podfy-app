/* public/main.js — Podfy app client (updated for /[company]/[ref]) */

(() => {
  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  // ---------- Elements ----------
  const brandLogo   = qs('#brandLogo');
  const banner      = qs('#banner');

  // Upload UI
  const dropzone    = qs('#dropzone');
  const fileInput   = qs('#fileInput');
  const chooseBtn   = qs('#chooseBtn');
  const cameraInput = qs('#cameraInput');
  const cameraBtn   = qs('#cameraBtn');
  const submitBtn   = qs('#submitBtn');
  const statusEl    = qs('#status');

  // Email copy
  const copyCheck   = qs('#copyCheck');
  const emailWrap   = qs('#emailWrap');
  const emailField  = qs('#emailField');

  // Location
  const locCheck    = qs('#locCheck');
  const locStatus   = qs('#locStatus');

  // Language UI
  const langTrigger = qs('#translateBtn');
  const langMenu    = qs('#langMenu');
  const langLabel   = qs('#currentLangLabel');

  // ---------- Slug + Reference from path ----------
  // Accept: /            -> slug='',  ref=''
  //         /dhl         -> slug='dhl', ref=''
  //         /dhl/REF123  -> slug='dhl', ref='REF123'
  const path = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const segs = path.split('/').filter(Boolean);
  const rawSlug = (segs[0] || '').toLowerCase();
  const refFromPathRaw = segs[1] || '';
  // sanitize ref for transport
  const refFromPath = refFromPathRaw.replace(/[^A-Za-z0-9._-]/g, '');
  let   slug = rawSlug || 'default';

  // Heading we will update if reference exists
  const heading = qs('#heading');

  // ---------- State ----------
  let themes = {};
  let theme  = null;
  let strings = {};
  let currentLang = 'en';

  // ---------- Helpers: language codes ----------
  function normalizeLangCode(code) {
    if (!code) return '';
    let c = code.toLowerCase().replace('_','-');
    if (c === 'ro-md') return 'ro_MD';
    if (c === 'ckb' || c === 'ku-iq') return 'ckb';
    if (c.startsWith('pt-')) return 'pt';
    return c.split('-')[0];
  }

  function pickInitialLang(available) {
    const urlLang = new URLSearchParams(location.search).get('lang');
    if (urlLang) {
      const k = normalizeLangCode(urlLang);
      if (available[k]) return k;
    }
    const nav = navigator.languages && navigator.languages[0] || navigator.language || 'en';
    const k = normalizeLangCode(nav);
    if (available[k]) return k;
    return 'en';
  }

  // ---------- Unknown slug banner ----------
  function renderUnknownSlugBanner(slugValue) {
    if (!banner) return;
    const dict = strings[currentLang] || strings['en'] || {};
    const msgTmpl   = dict.unknownSlug || 'Unknown reference “{slug}”. Please verify the URL or use the general uploader.';
    const linkLabel = dict.learnAboutPodfy || 'Learn about Podfy';
    const msg = msgTmpl.replace('{slug}', slugValue);
    banner.hidden = false;
    banner.dataset.type = 'unknownSlug';
    banner.dataset.slug = slugValue;
    banner.innerHTML = `${msg} <a href="https://podfy.net/introduction" target="_blank" rel="noopener">${linkLabel}</a>`;
  }

  // ---------- Theme load ----------
  async function loadTheme() {
    const res = await fetch('/themes.json?v=' + Date.now(), { cache: 'no-store' });
    themes = await res.json();

    const isKnown = !!themes[slug];
    theme = isKnown ? themes[slug] : (themes['default'] || {});
    if (!isKnown && rawSlug) {
      renderUnknownSlugBanner(rawSlug);
      slug = 'default';
    }

    const r = document.documentElement;
    const c = theme.colors || {};
    r.style.setProperty('--brand-primary', c.primary || '#000000');
    r.style.setProperty('--brand-accent',  c.accent  || '#1F2937');
    r.style.setProperty('--brand-text',    c.text    || '#0B1220');
    r.style.setProperty('--brand-muted',   c.muted   || '#6B7280');
    r.style.setProperty('--brand-border',  c.border  || '#E5E7EB');
    r.style.setProperty('--brand-button-text', c.buttonText || '#FFFFFF');

    if (brandLogo && theme.logo) brandLogo.src = theme.logo;
    const favicon = qs('link[rel="icon"]');
    if (favicon && theme.favicon) favicon.href = theme.favicon;

    // Update the on-page title (H1) to include the reference if present
    if (heading) {
      if (refFromPath) {
        heading.textContent = `Upload CMR / POD for shipment ${refFromPath}`;
      } else {
        heading.textContent = 'Upload CMR / POD';
      }
    }
  }

  // ---------- i18n ----------
  let langStrings = {};
  async function loadI18n() {
    const res = await fetch('/i18n.json?v=' + Date.now(), { cache: 'no-store' });
    langStrings = await res.json();
    const first = pickInitialLang(langStrings);
    applyLang(first);
  }

  function applyLang(code) {
    const dict = langStrings[code] || langStrings['en'] || {};
    qsa('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    currentLang = code;

    // translate common attributes for i18n
    qsa('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (dict[key]) el.setAttribute('title', dict[key]);
    });
    qsa('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label');
      if (dict[key]) el.setAttribute('aria-label', dict[key]);
    });
    qsa('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (dict[key]) el.setAttribute('placeholder', dict[key]);
    });

    // meta descriptions
    const desc   = document.querySelector('meta[name="description"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const twDesc = document.querySelector('meta[name="twitter:description"]');
    const meta   = dict.metaDescription || (langStrings.en && langStrings.en.metaDescription) || '';
    [desc, ogDesc, twDesc].forEach(m => m && m.setAttribute('content', meta));

    // update <html> lang + dir
    const rtl = new Set(['ar','fa','he','ur']);
    document.documentElement.setAttribute('lang', code);
    document.documentElement.setAttribute('dir', rtl.has(code) ? 'rtl' : 'ltr');

    // If an unknown slug banner is visible, re-render in the new language
    if (banner && !banner.hidden && ((banner.dataset && banner.dataset.type === 'unknownSlug') || (rawSlug && !themes[rawSlug]))) {
      const slugValue = (banner.dataset && banner.dataset.slug) ? banner.dataset.slug : rawSlug;
      if (typeof renderUnknownSlugBanner === 'function' && slugValue) renderUnknownSlugBanner(slugValue);
    }

    // Reflect selected language button (if menu exists)
    if (langLabel) langLabel.textContent = dict.__name ? dict.__name : code.toUpperCase();
    if (langMenu) {
      langMenu.querySelectorAll('.lang-item').forEach(btn => {
        btn.setAttribute('aria-checked', String(btn.getAttribute('data-lang') === code));
      });
    }
  }

  // ---------- Popovers (help menus etc.) ----------
  const popovers = new Map();
  function wirePopovers() {
    const buttons = qsa('[data-popover]');
    buttons.forEach(btn => {
      const id = btn.getAttribute('aria-controls');
      const pop = id ? document.getElementById(id) : null;
      if (!pop) return;
      popovers.set(btn, pop);
      btn.setAttribute('aria-expanded', btn.getAttribute('aria-expanded') || 'false');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-hidden', pop.hasAttribute('hidden') ? 'true' : 'false');

      btn.addEventListener('click', (e) => {
        const pop = popovers.get(btn);
        if (!pop) return;
        const willOpen = pop.hasAttribute('hidden');
        pop.hidden = !willOpen ? true : false;
        pop.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) setTimeout(() => { if (pop.focus) pop.setAttribute('tabindex','-1'), pop.focus(); }, 0);
        e.stopPropagation();
      });
    });

    document.addEventListener('click', (e) => {
      const isBtn = Array.from(popovers.keys()).some(b => b === e.target);
      const inPop = Array.from(popovers.values()).some(pop => pop.contains(e.target));
      if (!isBtn && !inPop) popovers.forEach((pop, btn) => {
        pop.hidden = true;
        pop.setAttribute('aria-hidden', 'true');
        btn.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') popovers.forEach((pop, btn) => {
        pop.hidden = true;
        pop.setAttribute('aria-hidden', 'true');
        btn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /** Sets up the upload UI: file pickers, copy-to-email toggle, submit handling, and status updates. */
  function wireUI() {
    copyCheck?.addEventListener('change', () => {
      const show = !!copyCheck.checked;
      emailWrap?.classList.toggle('hidden', !show);
      if (!show && emailField) emailField.value = '';
    });

    chooseBtn?.addEventListener('click', () => fileInput?.click());
    cameraBtn?.addEventListener('click', () => cameraInput?.click());

    const dz = dropzone;
    if (dz) {
      const pick = () => fileInput?.click();
      dz.addEventListener('click', pick);
      dz.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    }

    async function tryGetLocation() {
      if (!locCheck?.checked || !navigator.geolocation || !locStatus) return;
      locStatus.textContent = 'Requesting location…';
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition((pos) => {
          const c = pos.coords || {};
          const ts = pos.timestamp ? String(pos.timestamp) : '';
          locStatus.textContent = `Location ready (${c.latitude?.toFixed(5)}, ${c.longitude?.toFixed(5)})`;
          locStatus.dataset.lat = String(c.latitude || '');
          locStatus.dataset.lon = String(c.longitude || '');
          locStatus.dataset.acc = String(c.accuracy || '');
          locStatus.dataset.ts  = ts;
          resolve();
        }, () => {
          locStatus.textContent = 'Unable to get location (permission denied?)';
          resolve();
        }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
      });
    }

    async function submitFile(f) {
      const dict = langStrings[currentLang] || langStrings['en'] || {};
      if (!f) return;

      // optionally fetch a location
      await tryGetLocation();

      if (submitBtn) submitBtn.disabled = true;
      statusEl && (statusEl.textContent = dict.uploading || 'Uploading…');

      const form = new FormData();
      form.append('file', f);

      // Slug we saw in the URL (first path segment)
      form.append('slug_original', rawSlug || 'default');
      form.append('slug_known', themes[rawSlug] ? '1' : '0');

      // Reference, if provided in path (second segment)
      if (refFromPath) form.append('reference', refFromPath);

      // Optional copy to uploader
      if (copyCheck?.checked && emailField?.value && emailField.value.includes('@')) {
        form.append('email', emailField.value.trim());
      }

      // Optional geo (client)
      if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
        form.append('lat',  locStatus.dataset.lat);
        form.append('lon',  locStatus.dataset.lon);
        if (locStatus.dataset.acc) form.append('acc', locStatus.dataset.acc);
        if (locStatus.dataset.ts)  form.append('loc_ts', locStatus.dataset.ts);
      }

      try {
        const resp = await fetch('/api/upload', { method: 'POST', body: form });
        if (!resp.ok) throw new Error('Upload failed');
        await resp.json();

        if (statusEl) statusEl.textContent = dict.success || 'Thanks. File received.';

        // Reset inputs & states
        if (fileInput) fileInput.value = '';
        if (cameraInput) cameraInput.value = '';
        if (submitBtn) submitBtn.disabled = false;
        setTimeout(() => { submitBtn && (submitBtn.disabled = false); }, 400);
      } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = 'Upload failed. Please try again.';
        setTimeout(() => { submitBtn && (submitBtn.disabled = false); }, 400);
      }
    }

    // Hook file inputs
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) submitFile(f);
    });
    cameraInput?.addEventListener('change', () => {
      const f = cameraInput.files && cameraInput.files[0];
      if (f) submitFile(f);
    });
  }

  // ---------- Init ----------
  (async function init() {
    await loadI18n();      // load strings first
    await loadTheme();     // then theme
    wirePopovers();
    wireUI();
  })();

})();
