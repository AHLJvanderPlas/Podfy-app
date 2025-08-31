/* public/main.js — Podfy app client (fixed: header bg, language menu, info popovers, ref support, localized ref title, dropzone drag coloring) */

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
  const langTrigger = qs('#translateBtn');   // the globe button
  const langMenu    = qs('#langMenu');       // dropdown panel
  const langLabel   = qs('#currentLangLabel');

  // ---------- Slug + Reference from path ----------
  const path = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const segs = path.split('/').filter(Boolean);
  const rawSlug = (segs[0] || '').toLowerCase();
  const refFromPathRaw = segs[1] || '';
  const refFromPath = refFromPathRaw.replace(/[^A-Za-z0-9._-]/g, '');
  let   slug = rawSlug || 'default';

  const heading = qs('#heading');

  // ---------- State ----------
  let themes = {};
  let theme  = null;
  let langStrings = {};
  let currentLang = 'en';

  // ---------- Lang helpers ----------
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
    const dict = langStrings[currentLang] || langStrings['en'] || {};
    const msgTmpl   = dict.unknownSlug || 'Unknown reference “{slug}”. Please verify the URL or use the general uploader.';
    const linkLabel = dict.learnAboutPodfy || 'Learn about Podfy';
    const msg = msgTmpl.replace('{slug}', slugValue);
    banner.hidden = false;
    banner.dataset.type = 'unknownSlug';
    banner.dataset.slug = slugValue;
    banner.innerHTML = `${msg} <a href="https://podfy.net/introduction" target="_blank" rel="noopener">${linkLabel}</a>`;
  }

  // ---------- Build language menu ----------
  function buildLangMenu() {
    if (!langMenu || !langStrings) return;
    const entries = Object.keys(langStrings).map(k => ({
      key: k,
      name: langStrings[k].__name || k
    })).sort((a,b) => a.name.localeCompare(b.name, undefined, {sensitivity:'base'}));

    langMenu.innerHTML = '';
    entries.forEach(({ key, name }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-item';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', String(key === currentLang));
      btn.setAttribute('data-lang', key);
      btn.textContent = name;
      btn.addEventListener('click', () => {
        applyLang(key);
        closeLangMenu();
      });
      langMenu.appendChild(btn);
    });
    reflectLangSelection();
  }
  function reflectLangSelection() {
    if (langLabel) {
      const dict = langStrings[currentLang] || {};
      langLabel.textContent = dict.__name || currentLang.toUpperCase();
    }
    if (langMenu) {
      langMenu.querySelectorAll('.lang-item').forEach(btn => {
        btn.setAttribute('aria-checked', String(btn.getAttribute('data-lang') === currentLang));
      });
    }
  }
  function openLangMenu() {
    if (!langMenu || !langTrigger) return;
    langMenu.hidden = false;
    langMenu.setAttribute('aria-hidden', 'false');
    langTrigger.setAttribute('aria-expanded', 'true');
  }
  function closeLangMenu() {
    if (!langMenu || !langTrigger) return;
    langMenu.hidden = true;
    langMenu.setAttribute('aria-hidden', 'true');
    langTrigger.setAttribute('aria-expanded', 'false');
  }
  function wireLanguageMenu() {
    if (!langTrigger || !langMenu) return;
    langTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !!langMenu.hidden;
      if (willOpen) openLangMenu(); else closeLangMenu();
    });
    document.addEventListener('click', (e) => {
      if (!langTrigger.contains(e.target) && !langMenu.contains(e.target)) closeLangMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLangMenu();
    });
  }

  // ---------- Info popovers ----------
  function wireInfoPopovers() {
    const buttons = qsa('.info-btn');
    const popovers = new Map();
    buttons.forEach(btn => {
      const id = btn.getAttribute('aria-controls');
      const pop = id ? document.getElementById(id) : null;
      if (!pop) return;
      popovers.set(btn, pop);
      btn.setAttribute('aria-expanded', btn.getAttribute('aria-expanded') || 'false');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-hidden', pop.hasAttribute('hidden') ? 'true' : 'false');

      btn.addEventListener('click', (e) => {
        const p = popovers.get(btn);
        if (!p) return;
        const willOpen = p.hasAttribute('hidden');
        p.hidden = !willOpen ? true : false;
        p.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) setTimeout(() => { if (p.focus) p.setAttribute('tabindex','-1'), p.focus(); }, 0);
        e.stopPropagation();
      });
    });

    document.addEventListener('click', (e) => {
      const isBtn = Array.from(popovers.keys()).some(b => b === e.target);
      const inPop = Array.from(popovers.values()).some(p => p.contains(e.target));
      if (!isBtn && !inPop) {
        popovers.forEach((p, btn) => {
          p.hidden = true;
          p.setAttribute('aria-hidden', 'true');
          btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        popovers.forEach((p, btn) => {
          p.hidden = true;
          p.setAttribute('aria-hidden', 'true');
          btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
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
    const headerBg = (theme.header && theme.header.bg) || '#FFFFFF';
    r.style.setProperty('--header-bg', headerBg);

    if (brandLogo && theme.logo) brandLogo.src = theme.logo;
    const favicon = qs('link[rel="icon"]');
    if (favicon && theme.favicon) favicon.href = theme.favicon;

    // Localized H1 title
    if (heading) {
      const dict = langStrings[currentLang] || langStrings['en'] || {};
      if (refFromPath) {
        const tmpl = dict.headingWithRef || 'Upload CMR / POD for reference {ref}';
        heading.textContent = tmpl.replace('{ref}', refFromPath);
      } else {
        heading.textContent = dict.heading || 'Upload CMR / POD';
      }
    }
  }

  // ---------- i18n ----------
  async function loadI18n() {
    const res = await fetch('/i18n.json?v=' + Date.now(), { cache: 'no-store' });
    langStrings = await res.json();
    const first = pickInitialLang(langStrings);
    applyLang(first);
    buildLangMenu();
  }

  function applyLang(code) {
    const dict = langStrings[code] || langStrings['en'] || {};
    qsa('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    currentLang = code;

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

    const desc   = document.querySelector('meta[name="description"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const twDesc = document.querySelector('meta[name="twitter:description"]');
    const meta   = dict.metaDescription || (langStrings.en && langStrings.en.metaDescription) || '';
    [desc, ogDesc, twDesc].forEach(m => m && m.setAttribute('content', meta));

    const rtl = new Set(['ar','fa','he','ur']);
    document.documentElement.setAttribute('lang', code);
    document.documentElement.setAttribute('dir', rtl.has(code) ? 'rtl' : 'ltr');

    if (heading) {
      if (refFromPath) {
        const tmpl = (langStrings[code] && langStrings[code].headingWithRef) || 'Upload CMR / POD for reference {ref}';
        heading.textContent = tmpl.replace('{ref}', refFromPath);
      } else {
        heading.textContent = (langStrings[code] && langStrings[code].heading) || 'Upload CMR / POD';
      }
    }

    reflectLangSelection();
  }

  // ---------- Upload wiring ----------
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

      // drag & drop coloring + file handling
      const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach(ev => {
        dz.addEventListener(ev, (e) => {
          prevent(e);
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          dz.classList.add('dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(ev => {
        dz.addEventListener(ev, (e) => {
          prevent(e);
          dz.classList.remove('dragover');
        });
      });
      dz.addEventListener('drop', (e) => {
        prevent(e);
        dz.classList.remove('dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        const f = files && files[0];
        if (f) {
          dz.classList.add('ready');
          submitFile(f);
        }
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

      await tryGetLocation();

      if (submitBtn) submitBtn.disabled = true;
      statusEl && (statusEl.textContent = dict.uploading || 'Uploading…');

      const form = new FormData();
      form.append('file', f);
      form.append('slug_original', rawSlug || 'default');
      form.append('slug_known', themes[rawSlug] ? '1' : '0');
      if (refFromPath) form.append('reference', refFromPath);

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
        await resp.json();

        if (statusEl) statusEl.textContent = dict.success || 'Thanks. File received.';
        dropzone?.classList.remove('ready');
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

    fileInput?.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) { dropzone?.classList.add('ready'); submitFile(f); }
    });
    cameraInput?.addEventListener('change', () => {
      const f = cameraInput.files && cameraInput.files[0];
      if (f) { dropzone?.classList.add('ready'); submitFile(f); }
    });
  }

  // ---------- Init ----------
  (async function init() {
    await loadI18n();
    await loadTheme();
    buildLangMenu();
    wireLanguageMenu();
    wireInfoPopovers();
    wireUI();
  })();

})();
