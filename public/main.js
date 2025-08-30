/* public/main.js — Podfy app client */

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

  // Copy/email + location
  const copyCheck   = qs('#copyCheck');
  const emailWrap   = qs('#emailWrap');
  const emailField  = qs('#emailField');
  const locCheck    = qs('#locCheck');
  const locStatus   = qs('#locStatus');

  // Language UI
  const langTrigger = qs('#translateBtn');   // the globe button
  const langMenu    = qs('#langMenu');       // dropdown panel
  const langLabel   = qs('#currentLangLabel');

  // ---------- Slug ----------
  const path    = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const rawSlug = path === '/' ? '' : path.slice(1).toLowerCase();
  let   slug    = rawSlug || 'default';

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
      if (k === 'ro' && available['ro_MD']) return 'ro_MD';
    }
    const stored = localStorage.getItem('podfy_lang');
    if (stored && available[stored]) return stored;

    const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
      .map(normalizeLangCode);
    for (const cand of prefs) {
      if (available[cand]) return cand;
      if (cand === 'ro' && available['ro_MD']) return 'ro_MD';
    }
    return 'en';
  }

  // ---------- Apply language ----------
  /**
   * Applies the given language key:
   * - updates text for [data-i18n]
   * - translates common attributes (title / aria-label / placeholder)
   * - updates meta descriptions (SEO/social)
   * - updates <html lang> and dir (RTL-aware)
   * - re-renders the unknown-slug banner if visible
   */
  function applyLang(code) {
    const dict = strings[code] || strings['en'] || {};
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

    // meta descriptions for SEO / social previews
    const desc   = document.querySelector('meta[name="description"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const twDesc = document.querySelector('meta[name="twitter:description"]');
    const meta   = dict.metaDescription || (strings.en && strings.en.metaDescription) || '';
    [desc, ogDesc, twDesc].forEach(m => m && m.setAttribute('content', meta));

    // update <html> lang + dir
    const rtl = new Set(['ar','fa','he','ur']);
    document.documentElement.setAttribute('lang', code);
    document.documentElement.setAttribute('dir', rtl.has(code) ? 'rtl' : 'ltr');

    localStorage.setItem('podfy_lang', code);

    // visible UI label
    const label = dict.__name ? dict.__name : code.toUpperCase();
    if (langLabel) langLabel.textContent = label;
    else if (langTrigger) langTrigger.textContent = label;

    // reflect selection in menu
    if (langMenu) {
      langMenu.querySelectorAll('.lang-item').forEach(btn => {
        btn.setAttribute('aria-checked', String(btn.getAttribute('data-lang') === code));
      });
    }

    // Re-render banner if an unknown slug is currently shown so language changes apply immediately
    if (banner && !banner.hidden && ((banner.dataset && banner.dataset.type === 'unknownSlug') || (rawSlug && !themes[rawSlug]))) {
      const slugValue = (banner.dataset && banner.dataset.slug) ? banner.dataset.slug : rawSlug;
      if (typeof renderUnknownSlugBanner === 'function' && slugValue) renderUnknownSlugBanner(slugValue);
    }
  }

  // ---------- Build language menu ----------
  function buildLangMenu() {
    if (!langMenu) return;

    const entries = Object.keys(strings).map(k => ({
      key: k,
      name: strings[k].__name || k
    })).sort((a,b) => a.name.localeCompare(b.name, undefined, {sensitivity:'base'}));

    langMenu.innerHTML = '';
    entries.forEach(({ key, name }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-item';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('data-lang', key);
      btn.setAttribute('aria-checked', String(key === currentLang));

      const bullet = document.createElement('span');
      bullet.className = 'lang-bullet';

      const label = document.createElement('span');
      label.textContent = name;

      btn.appendChild(bullet);
      btn.appendChild(label);

      btn.addEventListener('click', () => {
        applyLang(key);
        langMenu.hidden = true;
        langTrigger?.setAttribute('aria-expanded', 'false');
      });

      langMenu.appendChild(btn);
    });
  }

  // ---------- Toggle wiring (open/close dropdown) ----------
  /** Wires the language dropdown toggle, handles outside-click and Escape to close. */
  function wireLanguageToggle() {
    const btn  = langTrigger;
    const menu = langMenu;
    if (!btn || !menu) return;

    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const open = menu.hidden === false;
      menu.hidden = open;
      btn.setAttribute('aria-expanded', String(!open));
    });

    menu.addEventListener('click', (ev) => ev.stopPropagation());

    document.addEventListener('click', (ev) => {
      if (!btn.contains(ev.target) && !menu.contains(ev.target)) {
        if (menu.hidden === false) {
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
        }
      }
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && menu.hidden === false) {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });
  }

  // ---------- Unknown-slug banner renderer ----------
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
    r.style.setProperty('--header-bg', (theme.header && theme.header.bg) || '#FFFFFF');

    if (brandLogo && (theme.logo || theme.favicon)) {
      brandLogo.src = theme.logo || theme.favicon;
    }

    // Optional favicons (adaptive fallback)
    const linkLight = document.getElementById('faviconLight');
    const linkDark  = document.getElementById('faviconDark');
    const favLight  = theme.favicon || theme.logo || '/logos/podfy-favicon-adaptive.svg';
    const favDark   = theme.faviconDark || theme.logoDark || favLight;
    if (linkLight) linkLight.href = favLight;
    if (linkDark)  linkDark.href  = favDark;
  }

  // ---------- i18n load ----------
  async function loadI18n() {
    const res = await fetch('/i18n.json?v=' + Date.now(), { cache: 'no-store' });
    strings = await res.json();

    // Ensure key exists for the camera button if some locales missed it
    Object.keys(strings).forEach(k => {
      if (!strings[k].takePhoto) strings[k].takePhoto = (k === 'nl') ? 'Foto maken' : 'Take photo';
    });

    const initial = pickInitialLang(strings);
    applyLang(initial);
    buildLangMenu();
    wireLanguageToggle();
  }

  // ---------- Upload UI wiring ----------
  /**
   * Wires lightweight info popovers for buttons with .info-btn.
   * Uses the button's aria-controls attribute to find the associated popover element.
   * - Toggles visibility on click.
   * - Closes on outside click or Escape.
   * - Updates aria-expanded for a11y.
   */
  function wirePopovers() {
    const buttons = Array.from(document.querySelectorAll('.info-btn'));
    const popovers = new Map(); // btn -> popover

    buttons.forEach(btn => {
      const id = btn.getAttribute('aria-controls');
      const pop = id ? document.getElementById(id) : null;
      if (!pop) return;
      popovers.set(btn, pop);

      // Ensure base a11y attributes
      btn.setAttribute('aria-expanded', btn.getAttribute('aria-expanded') || 'false');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-hidden', pop.hasAttribute('hidden') ? 'true' : 'false');
    });

    function closeAll(exceptBtn = null) {
      popovers.forEach((pop, btn) => {
        if (btn !== exceptBtn) {
          pop.hidden = true;
          pop.setAttribute('aria-hidden', 'true');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // Click to toggle
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const pop = popovers.get(btn);
        if (!pop) return;
        const willOpen = !!pop.hidden;
        closeAll(btn);
        pop.hidden = !willOpen ? true : false;
        pop.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) {
          setTimeout(() => { if (pop.focus) pop.setAttribute('tabindex','-1'), pop.focus(); }, 0);
        }
        e.stopPropagation();
      });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      const target = e.target;
      const isBtn = buttons.some(b => b === target);
      const inPop = Array.from(popovers.values()).some(pop => pop.contains(target));
      if (!isBtn && !inPop) closeAll(null);
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll(null);
    });
  }

  /** Sets up the upload UI: file pickers, copy-to-email toggle, submit handling, and status updates. */
  function wireUI() {
    // Toggle email field
    copyCheck?.addEventListener('change', () => {
      const show = !!copyCheck.checked;
      if (emailWrap) {
        emailWrap.hidden = !show;
        if (!show && emailField) emailField.value = '';
      }
    });

    // Enable/disable submit + color icon when a file is present
    const enableSubmitIfFile = () => {
      const hasFile = !!(fileInput?.files && fileInput.files.length);
      if (submitBtn) submitBtn.disabled = !hasFile;
      document.getElementById('dropzone')?.classList.toggle('ready', hasFile);
    };

    // File pickers
    chooseBtn?.addEventListener('click', () => fileInput?.click());
    cameraBtn?.addEventListener('click', () => cameraInput?.click());

    cameraInput?.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files.length) {
        fileInput.files = cameraInput.files;
        enableSubmitIfFile();
      }
    });

    // Drag/drop visuals
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone?.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        enableSubmitIfFile();
      }
    });
    fileInput?.addEventListener('change', enableSubmitIfFile);

    // Location capture on demand
    locCheck?.addEventListener('change', () => {
      if (!locStatus) return;
      locStatus.textContent = '';
      if (locCheck.checked && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            locStatus.textContent = `Location captured (±${Math.round(pos.coords.accuracy)} m)`;
            locStatus.dataset.lat = String(pos.coords.latitude);
            locStatus.dataset.lon = String(pos.coords.longitude);
            locStatus.dataset.acc = String(pos.coords.accuracy);
            locStatus.dataset.ts  = String(Date.now());
          },
          () => { locStatus.textContent = 'Location unavailable.'; },
          { enableHighAccuracy: true, maximumAge: 30000, timeout: 8000 }
        );
      } else {
        delete locStatus.dataset.lat;
        delete locStatus.dataset.lon;
        delete locStatus.dataset.acc;
        delete locStatus.dataset.ts;
      }
    });

    // Submit handler
    submitBtn?.addEventListener('click', async () => {
      if (!fileInput?.files || !fileInput.files.length) return;

      submitBtn.disabled = true;
      const dict = strings[currentLang] || strings['en'] || {};
      if (statusEl) statusEl.textContent = dict.uploading || 'Uploading…';

      const f = fileInput.files[0];
      const form = new FormData();
      form.append('file', f);

      form.append('slug_original', rawSlug || 'default');
      form.append('slug_known', themes[rawSlug] ? '1' : '0');

      if (copyCheck?.checked && emailField?.value && emailField.value.includes('@')) {
        form.append('email', emailField.value.trim());
      }

      if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
        form.append('lat',  locStatus.dataset.lat);
        form.append('lon',  locStatus.dataset.lon);
        if (locStatus.dataset.acc) form.append('acc', locStatus.dataset.acc);
        if (locStatus.dataset.ts)  form.append('loc_ts', locStatus.dataset.ts);
      }

      try {
        const resp = await fetch('/api/upload', { method: 'POST', body: form });
        if (!resp.ok) throw new Error('Upload failed');
        const _data = await resp.json(); // eslint-disable-line no-unused-vars

        if (statusEl) statusEl.textContent = dict.success || 'Thanks. File received.';

        // Reset inputs & states
        if (fileInput) fileInput.value = '';
        if (cameraInput) cameraInput.value = '';
        submitBtn.disabled = true;
        document.getElementById('dropzone')?.classList.remove('ready');
      } catch (err) {
        if (statusEl) statusEl.textContent = dict.uploadFailed || 'Upload failed. Please try again.';
      } finally {
        setTimeout(() => { submitBtn && (submitBtn.disabled = false); }, 400);
      }
    });
  }

  // ---------- Init ----------
  (async function init() {
    await loadI18n();  // load strings first so early UI can be localized
    await loadTheme(); // then theme (may render unknown-slug banner)
    wirePopovers();
    wireUI();
  })();

})();
