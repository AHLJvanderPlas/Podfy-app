/* Main client script for Podfy */
(() => {
  const qs = sel => document.querySelector(sel);
  const qsa = sel => Array.from(document.querySelectorAll(sel));

  // Elements
  const translateBtn = qs('#translateBtn');
  const langMenu = qs('#langMenu');
  const banner = qs('#banner');
  const fileInput = qs('#fileInput');
  const dropzone = qs('#dropzone');
  const chooseFileBtn = qs('label[for="fileInput"]');
  const submitBtn = qs('#submitBtn');
  const statusEl = qs('#status');
  const acceptText = qs('#acceptText');
  const copyCheck = qs('#copyCheck');
  const emailWrap = qs('#emailWrap');
  const emailField = qs('#emailField');
  const locCheck = qs('#locCheck');
  const locStatus = qs('#locStatus');
  const brandLogo = qs('#brandLogo');

  // Slug, taken from path
  const path = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const rawSlug = path === '/' ? '' : path.slice(1).toLowerCase();
  let slug = rawSlug || 'default';

  // Globals
  let strings = {};
  let currentLang = 'en';
  let themes = {};
  let theme = null;

  // ---------------- i18n helpers ----------------

  function normalizeLangCode(code) {
    if (!code) return '';
    let c = code.toLowerCase().replace('_','-');
    // Map browser codes → our keys
    // special cases
    if (c === 'ro-md') return 'ro_MD';
    if (c === 'ku') return 'ku';       // Kurmanji
    if (c === 'ckb' || c === 'ku-iq') return 'ckb'; // Sorani
    if (c.startsWith('pt-')) return 'pt';
    if (c.startsWith('zh')) return 'en'; // fallback to en
    return c.split('-')[0]; // base language
  }

  function pickInitialLang(available) {
    // Priority: URL ?lang= → localStorage → navigator.languages → navigator.language → 'en'
    const urlLang = new URLSearchParams(location.search).get('lang');
    if (urlLang) {
      const k = normalizeLangCode(urlLang);
      // prefer exact first, then base
      if (available[k]) return k;
      if (available[normalizeLangCode(k)]) return normalizeLangCode(k);
    }
    const stored = localStorage.getItem('podfy_lang');
    if (stored && available[stored]) return stored;

    const preferred = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
      .map(normalizeLangCode);

    for (const cand of preferred) {
      if (available[cand]) return cand;
      // handle region mapping like ro_MD if present in file
      if (cand === 'ro' && available['ro_MD']) return 'ro_MD';
    }
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
    // Update menu button text (optional)
    const label = dict.__name ? `${dict.__name}` : code.toUpperCase();
    translateBtn.textContent = label;
  }

  function buildLangMenu() {
    langMenu.innerHTML = '';
    // Sort by localized __name (fallback to key)
    const entries = Object.keys(strings).map(k => ({
      key: k,
      name: strings[k].__name || k
    })).sort((a,b) => a.name.localeCompare(b.name, undefined, {sensitivity:'base'}));

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

  // ---------------- Theme load ----------------
  async function loadTheme() {
    const res = await fetch('/themes.json?v=' + Date.now(), { cache: 'no-store' });
    themes = await res.json();
    const isKnown = !!themes[slug];
    theme = isKnown ? themes[slug] : (themes['default'] || {});
    if (!isKnown && slug !== 'default') {
      // Unknown slug banner
      banner.hidden = false;
      const knownMsg = `Unknown reference “${slug}”. You can use the default tool below.`;
      banner.innerHTML = `${knownMsg} <a href="https://podfy.net/introduction" target="_blank" rel="noopener">Learn about Podfy</a>`;
      // Force default visuals, but keep original slug in memory (sent to server)
      slug = 'default';
    }
    // Apply theme colors & assets
    const r = document.documentElement;
    const c = theme.colors || {};
    r.style.setProperty('--brand-primary', c.primary || '#000');
    r.style.setProperty('--brand-accent', c.accent || '#1F2937');
    r.style.setProperty('--brand-text', c.text || '#0B1220');
    r.style.setProperty('--brand-muted', c.muted || '#6B7280');
    r.style.setProperty('--brand-border', c.border || '#E5E7EB');
    r.style.setProperty('--brand-button-text', c.buttonText || '#FFF');
    r.style.setProperty('--header-bg', (theme.header && theme.header.bg) || '#FFF');

    if (brandLogo && (theme.logo || theme.favicon)) {
      brandLogo.src = theme.logo || theme.favicon;
    }

    // Favicons (light/dark optional) – safe defaults
    const linkLight = document.getElementById('faviconLight');
    const linkDark  = document.getElementById('faviconDark');
    const favLight = theme.favicon || theme.logo || '/logos/default.svg';
    const favDark  = theme.faviconDark || theme.logoDark || favLight;
    if (linkLight) linkLight.href = favLight;
    if (linkDark)  linkDark.href  = favDark;
  }

  // ---------------- i18n load ----------------
  async function loadI18n() {
    const res = await fetch('/i18n.json?v=' + Date.now(), { cache: 'no-store' });
    strings = await res.json();
    const initial = pickInitialLang(strings);
    applyLang(initial);
    buildLangMenu();
  }

  // ---------------- UI wiring ----------------
  function wireUI() {
    // Translate menu toggle
    translateBtn?.addEventListener('click', () => {
      langMenu.hidden = !langMenu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!langMenu.contains(e.target) && e.target !== translateBtn) {
        langMenu.hidden = true;
      }
    });

    // Email copy toggles field
    copyCheck?.addEventListener('change', () => {
      const show = copyCheck.checked;
      if (emailWrap) {
        emailWrap.hidden = !show;
        if (!show && emailField) emailField.value = '';
      }
    });

    // Dropzone behavior
    const enableSubmitIfFile = () => {
      submitBtn.disabled = !fileInput.files || fileInput.files.length === 0;
    };
    chooseFileBtn?.addEventListener('click', () => fileInput?.click());
    dropzone?.addEventListener('dragover', e => { e.preventDefault(); dropzone.style.background = '#fafafa'; });
    dropzone?.addEventListener('dragleave', e => { e.preventDefault(); dropzone.style.background = 'transparent'; });
    dropzone?.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.style.background = 'transparent';
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        enableSubmitIfFile();
      }
    });
    fileInput?.addEventListener('change', enableSubmitIfFile);

    // Optional client location capture when user checks the box
    locCheck?.addEventListener('change', async () => {
      locStatus.textContent = '';
      if (locCheck.checked && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => {
            locStatus.textContent = `Location captured (±${Math.round(pos.coords.accuracy)} m)`;
            locStatus.dataset.lat = String(pos.coords.latitude);
            locStatus.dataset.lon = String(pos.coords.longitude);
            locStatus.dataset.acc = String(pos.coords.accuracy);
            locStatus.dataset.ts = String(Date.now());
          },
          _err => {
            locStatus.textContent = 'Location unavailable.';
          },
          { enableHighAccuracy: true, maximumAge: 30000, timeout: 8000 }
        );
      } else {
        delete locStatus.dataset.lat;
        delete locStatus.dataset.lon;
        delete locStatus.dataset.acc;
        delete locStatus.dataset.ts;
      }
    });

    // Info popovers (copy & location)
    qsa('.info-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('aria-controls');
        const pop = document.getElementById(id);
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
      if (!fileInput.files || !fileInput.files.length) return;

      submitBtn.disabled = true;
      statusEl.textContent = 'Uploading…';

      const f = fileInput.files[0];

      const form = new FormData();
      form.append('file', f);
      // The server still wants to know what the user typed (even if unknown)
      form.append('slug_original', rawSlug || 'default');
      // Let server know if slug is known to theme list
      form.append('slug_known', themes[rawSlug] ? '1' : '0');

      // email copy if provided
      if (copyCheck?.checked && emailField?.value && emailField.value.includes('@')) {
        form.append('email', emailField.value.trim());
      }
      // client GPS if captured
      if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
        form.append('lat', locStatus.dataset.lat);
        form.append('lon', locStatus.dataset.lon);
        if (locStatus.dataset.acc) form.append('acc', locStatus.dataset.acc);
        if (locStatus.dataset.ts)  form.append('loc_ts', locStatus.dataset.ts);
      }

      try {
        const resp = await fetch('/api/upload', { method: 'POST', body: form });
        if (!resp.ok) throw new Error('Upload failed');
        const data = await resp.json();
        statusEl.textContent = strings[currentLang]?.success || 'Thanks. File received.';
        // Reset UI
        fileInput.value = '';
        submitBtn.disabled = true;
      } catch (e) {
        statusEl.textContent = 'Upload failed. Please try again.';
      } finally {
        setTimeout(() => { submitBtn.disabled = false; }, 400);
      }
    });
  }

  // ---------------- Init ----------------
  (async function init() {
    await Promise.all([loadTheme(), loadI18n()]);
    wireUI();
  })();
})();
