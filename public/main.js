/* public/main.js — Podfy app client */
(() => {
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  // --------- Elements ----------
  const translateBtn = qs('#translateBtn');
  const langMenu     = qs('#langMenu');
  const banner       = qs('#banner');

  const dropzone     = qs('#dropzone');
  const fileInput    = qs('#fileInput');
  const chooseBtn    = qs('#chooseBtn');

  const cameraInput  = qs('#cameraInput');
  const cameraBtn    = qs('#cameraBtn');

  const submitBtn    = qs('#submitBtn');
  const statusEl     = qs('#status');

  const copyCheck    = qs('#copyCheck');
  const emailWrap    = qs('#emailWrap');
  const emailField   = qs('#emailField');

  const locCheck     = qs('#locCheck');
  const locStatus    = qs('#locStatus');

  const brandLogo    = qs('#brandLogo');

  // --------- Slug from path ----------
  const path    = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const rawSlug = path === '/' ? '' : path.slice(1).toLowerCase();
  let   slug    = rawSlug || 'default';        // used for theming if known

  // --------- Globals ----------
  let strings = {};
  let currentLang = 'en';
  let themes = {};
  let theme  = null;

  // --------- Language helpers ----------
  function normalizeLangCode(code) {
    if (!code) return '';
    let c = code.toLowerCase().replace('_','-');
    // special-case mappings to our keys
    if (c === 'ro-md') return 'ro_MD';
    if (c === 'ckb' || c === 'ku-iq') return 'ckb'; // Kurdish Sorani
    if (c.startsWith('pt-')) return 'pt';           // PT-BR, PT-PT → pt
    return c.split('-')[0];                         // base language e.g. 'de'
  }

  function pickInitialLang(available) {
    // 1) ?lang=
    const urlLang = new URLSearchParams(location.search).get('lang');
    if (urlLang) {
      const k = normalizeLangCode(urlLang);
      if (available[k]) return k;
      if (k === 'ro' && available['ro_MD']) return 'ro_MD';
    }
    // 2) localStorage
    const stored = localStorage.getItem('podfy_lang');
    if (stored && available[stored]) return stored;
    // 3) browser-preferred
    const prefs = (navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || 'en']).map(normalizeLangCode);
    for (const cand of prefs) {
      if (available[cand]) return cand;
      if (cand === 'ro' && available['ro_MD']) return 'ro_MD';
    }
    // 4) fallback
    return 'en';
  }

  function applyLang(code) {
    const dict = strings[code] || strings['en'] || {};
    qsa('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    currentLang = code;
    localStorage.setItem('podfy_lang', code);
    // Reflect current language on button
    const label = dict.__name ? dict.__name : code.toUpperCase();
    if (translateBtn) translateBtn.textContent = label;
  }

  function buildLangMenu() {
    if (!langMenu) return;
    langMenu.innerHTML = '';

    // Show all languages in i18n.json, sorted by localized name
    const entries = Object.keys(strings).map(k => ({
      key: k,
      name: strings[k].__name || k
    })).sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    entries.forEach(({ key, name }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.setAttribute('data-lang', key);
      if (key === currentLang) b.style.fontWeight = '600';
      b.addEventListener('click', () => {
        applyLang(key);
        langMenu.hidden = true;
      });
      langMenu.appendChild(b);
    });
  }

  // --------- Theme load ----------
  async function loadTheme() {
    const res = await fetch('/themes.json?v=' + Date.now(), { cache: 'no-store' });
    themes = await res.json();

    const isKnown = !!themes[slug];
    theme = isKnown ? themes[slug] : (themes['default'] || {});

    if (!isKnown && rawSlug) {
      // Unknown slug banner and fallback visuals
      if (banner) {
        banner.hidden = false;
        banner.innerHTML =
          `Unknown reference “${rawSlug}”. You can use the default tool below. ` +
          `<a href="https://podfy.net/introduction" target="_blank" rel="noopener">Learn about Podfy</a>`;
      }
      slug = 'default';
    }

    // Apply colors
    const r = document.documentElement;
    const c = theme.colors || {};
    r.style.setProperty('--brand-primary', c.primary || '#000');
    r.style.setProperty('--brand-accent',  c.accent  || '#1F2937');
    r.style.setProperty('--brand-text',    c.text    || '#0B1220');
    r.style.setProperty('--brand-muted',   c.muted   || '#6B7280');
    r.style.setProperty('--brand-border',  c.border  || '#E5E7EB');
    r.style.setProperty('--brand-button-text', c.buttonText || '#FFF');
    r.style.setProperty('--header-bg', (theme.header && theme.header.bg) || '#FFF');

    // Header logo
    if (brandLogo && (theme.logo || theme.favicon)) {
      brandLogo.src = theme.logo || theme.favicon;
    }

    // Favicons (optional light/dark pair if present)
    const favLight = theme.favicon || theme.logo || '/logos/default.svg';
    const favDark  = theme.faviconDark || theme.logoDark || favLight;
    const linkLight = document.getElementById('faviconLight');
    const linkDark  = document.getElementById('faviconDark');
    if (linkLight) linkLight.href = favLight;
    if (linkDark)  linkDark.href  = favDark;
  }

  // --------- i18n load ----------
  async function loadI18n() {
    const res = await fetch('/i18n.json?v=' + Date.now(), { cache: 'no-store' });
    strings = await res.json();

    // Ensure "takePhoto" exists (fallback English label if missing)
    Object.keys(strings).forEach(k => {
      if (!strings[k].takePhoto) strings[k].takePhoto = (k === 'nl') ? 'Foto maken' : 'Take photo';
    });

    const initial = pickInitialLang(strings);
    applyLang(initial);
    buildLangMenu();
  }

  // --------- UI wiring ----------
  function wireUI() {
    // Translate menu toggle
    translateBtn?.addEventListener('click', () => {
      if (!langMenu) return;
      langMenu.hidden = !langMenu.hidden;
    });
    // Close lang menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!langMenu) return;
      if (!langMenu.contains(e.target) && e.target !== translateBtn) {
        langMenu.hidden = true;
      }
    });

    // Copy-to-email: show/hide the email field
    copyCheck?.addEventListener('change', () => {
      const show = !!copyCheck.checked;
      if (emailWrap) {
        emailWrap.hidden = !show;
        if (!show && emailField) emailField.value = '';
      }
    });

    // Dropzone visuals & wiring
const enableSubmitIfFile = () => {
  const hasFile = !!(fileInput?.files && fileInput.files.length);
  if (submitBtn) submitBtn.disabled = !hasFile;
  // color the icon when a file is ready
  document.getElementById('dropzone')?.classList.toggle('ready', hasFile);
};

    chooseBtn?.addEventListener('click', () => fileInput?.click());
    cameraBtn?.addEventListener('click', () => cameraInput?.click());

    cameraInput?.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files.length) {
        // copy camera selection to main input so the rest works the same
        fileInput.files = cameraInput.files;
        enableSubmitIfFile();
      }
    });

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

    // Optional client location capture (only when user checks the box)
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

    // Info popovers (the little ⓘ buttons)
    qsa('.info-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id  = btn.getAttribute('aria-controls');
        const pop = id ? document.getElementById(id) : null;
        const open = pop && pop.hidden === false;
        qsa('.popover').forEach(p => p.hidden = true);
        if (pop) {
          pop.hidden = open; // toggle
          btn.setAttribute('aria-expanded', String(!open));
        }
      });
    });

    // Submit
    submitBtn?.addEventListener('click', async () => {
      if (!fileInput?.files || !fileInput.files.length) return;

      submitBtn.disabled = true;
      statusEl && (statusEl.textContent = 'Uploading…');

      const f = fileInput.files[0];
      const form = new FormData();
      form.append('file', f);

      // Always send original slug typed in URL (even if unknown)
      form.append('slug_original', rawSlug || 'default');
      form.append('slug_known', themes[rawSlug] ? '1' : '0');

      // Email copy if requested
      if (copyCheck?.checked && emailField?.value && emailField.value.includes('@')) {
        form.append('email', emailField.value.trim());
      }

      // Client GPS if captured
      if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
        form.append('lat', locStatus.dataset.lat);
        form.append('lon', locStatus.dataset.lon);
        if (locStatus.dataset.acc) form.append('acc', locStatus.dataset.acc);
        if (locStatus.dataset.ts)  form.append('loc_ts', locStatus.dataset.ts);
      }

      try {
        const resp = await fetch('/api/upload', { method: 'POST', body: form });
        if (!resp.ok) throw new Error('Upload failed');
        const data = await resp.json(); // eslint-disable-line no-unused-vars
        const dict = strings[currentLang] || strings['en'] || {};
        statusEl && (statusEl.textContent = dict.success || 'Thanks. File received.');

        // Reset inputs
        if (fileInput) fileInput.value = '';
        if (cameraInput) cameraInput.value = '';
        submitBtn.disabled = true;
      } catch (err) {
        statusEl && (statusEl.textContent = 'Upload failed. Please try again.');
      } finally {
        setTimeout(() => { submitBtn && (submitBtn.disabled = false); }, 400);
      }
    });
  }

  // --------- Init ----------
  (async function init() {
    await Promise.all([loadTheme(), loadI18n()]);
    wireUI();
  })();
})();
