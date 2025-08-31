/* public/main.js — Podfy
   - Drag & drop only dropzone; file selection via buttons
   - Reliable file/camera pickers (mobile/desktop) with cancelable off-screen fallback
   - No auto-upload; Submit triggers upload
   - Email field required when checked
   - GPS-only from client; backend chooses IP fallback if GPS absent
   - Title localization with headingWithRef and meta description per i18n
*/

(() => {
  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  // ---------- Elements ----------
  const brandLogo   = qs('#brandLogo');
  const banner      = qs('#banner');

  const dropzone    = qs('#dropzone');
  const fileInput   = qs('#fileInput');   // general picker
  const chooseBtn   = qs('#chooseBtn');

  const cameraInput = qs('#cameraInput'); // camera-only picker (accept="image/*" capture="environment")
  const cameraBtn   = qs('#cameraBtn');

  const submitBtn   = qs('#submitBtn');
  const statusEl    = qs('#status');

  // Email
  const copyCheck   = qs('#copyCheck');
  const emailWrap   = qs('#emailWrap');
  const emailField  = qs('#emailField');

  // Location
  const locCheck    = qs('#locCheck');
  const locStatus   = qs('#locStatus');

  // Language
  const langTrigger = qs('#translateBtn');
  const langMenu    = qs('#langMenu');
  const langLabel   = qs('#currentLangLabel');

  const heading     = qs('#heading');

  // ---------- Path: slug + optional reference ----------
  const path = new URL(location.href).pathname.replace(/\/+$/,'') || '/';
  const segs = path.split('/').filter(Boolean);
  const rawSlug = (segs[0] || '').toLowerCase();
  const refFromPathRaw = segs[1] || '';
  const refFromPath = refFromPathRaw.replace(/[^A-Za-z0-9._-]/g, '');
  let   slug = rawSlug || 'default';

  // ---------- State ----------
  let themes = {};
  let theme  = null;
  let langStrings = {};
  let currentLang = 'en';
  let selectedFile = null;

  // ---------- Language helpers ----------
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
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
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

  // ---------- Language menu ----------
  function buildLangMenu() {
    if (!langMenu || !langStrings) return;
    const entries = Object.keys(langStrings).map(k => ({
      key: k, name: langStrings[k].__name || k
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

    const isKnown = !!themes[rawSlug];
    theme = isKnown ? themes[rawSlug] : (themes['default'] || {});
    if (!isKnown && rawSlug) renderUnknownSlugBanner(rawSlug);
    if (!isKnown) slug = 'default';

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

    // keep localized title with/without ref after language changes
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

  // ---------- Location (GPS only from client) ----------
  function setLocDataFromPosition(pos) {
    const c = pos && pos.coords ? pos.coords : {};
    const ts = pos && pos.timestamp ? String(pos.timestamp) : String(Date.now());
    if (!locStatus) return;

    if (typeof c.latitude === 'number' && typeof c.longitude === 'number') {
      locStatus.textContent = `Location ready (${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)})`;
      locStatus.dataset.lat = String(c.latitude);
      locStatus.dataset.lon = String(c.longitude);
      if (typeof c.accuracy === 'number') locStatus.dataset.acc = String(c.accuracy);
      locStatus.dataset.ts = ts;
    } else {
      locStatus.textContent = 'Location unavailable';
      ['lat','lon','acc','ts'].forEach(k => delete locStatus.dataset[k]);
    }
  }

  async function requestLocationFix() {
    if (!navigator.geolocation || !locStatus) return;
    locStatus.textContent = 'Requesting location…';
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => { setLocDataFromPosition(pos); resolve(true); },
        (err) => {
          console.warn('Geolocation error:', err);
          locStatus.textContent = 'Unable to get location (permission denied or timeout)';
          ['lat','lon','acc','ts'].forEach(k => delete locStatus.dataset[k]);
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // ---------- Picker helpers (mobile/desktop safe) ----------
  function cancelTimersForInput(inputEl) {
    if (!inputEl) return;
    if (inputEl._fallbackTimer) { clearTimeout(inputEl._fallbackTimer); inputEl._fallbackTimer = null; }
    if (inputEl._revertTimer)   { clearTimeout(inputEl._revertTimer);   inputEl._revertTimer = null; }
    if (inputEl._prevStyles) {
      Object.assign(inputEl.style, inputEl._prevStyles);
      inputEl._prevStyles = null;
    }
  }

  function resilientOpen(inputEl) {
    if (!inputEl) return;

    // Clear any prior timers before opening
    cancelTimersForInput(inputEl);

    let opened = false;
    const onChange = () => {
      opened = true;
      cancelTimersForInput(inputEl); // stop fallback if a file was chosen
    };
    inputEl.addEventListener('change', onChange, { once: true });

    // Try normal programmatic click within user gesture
    inputEl.click?.();

    // Fallback if dialog didn’t open / selection not made
    inputEl._fallbackTimer = setTimeout(() => {
      if (opened) return;

      // Move input fully off-screen but still interactive for iOS
      inputEl._prevStyles = {
        position: inputEl.style.position,
        left:     inputEl.style.left,
        top:      inputEl.style.top,
        width:    inputEl.style.width,
        height:   inputEl.style.height,
        opacity:  inputEl.style.opacity,
        display:  inputEl.style.display
      };
      Object.assign(inputEl.style, {
        display:  'block',
        position: 'fixed',
        left:     '-9999px',
        top:      '0',
        width:    '1px',
        height:   '1px',
        opacity:  '0'
      });

      // iOS sometimes needs a focus() before showing the chooser
      inputEl.focus?.();

      inputEl._revertTimer = setTimeout(() => {
        if (inputEl._prevStyles) {
          Object.assign(inputEl.style, inputEl._prevStyles);
          inputEl._prevStyles = null;
        }
        inputEl._revertTimer = null;
      }, 3000);

      inputEl._fallbackTimer = null;
    }, 400);
  }

  // --- NEW: user-activation-safe binder (pointerup preferred, no preventDefault) ---
  function bindUserActivation(el, handler) {
    if (!el) return;
    if (window.PointerEvent) {
      el.addEventListener('pointerup', handler);    // counts as a trusted user activation
    } else {
      el.addEventListener('click', handler);        // fallback for older browsers
    }
  }

  // ---------- Upload wiring ----------
  function wireUI() {
    if (submitBtn) submitBtn.disabled = true;

    // Email checkbox: show/hide + required
    copyCheck?.addEventListener('change', () => {
      const show = !!copyCheck.checked;

      if (emailWrap) {
        emailWrap.classList.toggle('hidden', !show);
        emailWrap.hidden = !show;
      }
      if (emailField) {
        if (show) {
          if (emailField.type !== 'email') emailField.type = 'email';
          emailField.required = true;
          emailField.setAttribute('aria-required', 'true');
          emailField.focus();
        } else {
          emailField.required = false;
          emailField.removeAttribute('aria-required');
          emailField.setCustomValidity && emailField.setCustomValidity('');
          emailField.value = '';
        }
      }
    });
    // Initialize email UI on load
    (function initEmailCopyUI() {
      const show = !!copyCheck?.checked;
      if (emailWrap) { emailWrap.classList.toggle('hidden', !show); emailWrap.hidden = !show; }
      if (emailField) { if (show && emailField.type !== 'email') emailField.type = 'email'; emailField.required = !!show; }
    })();

    // Location checkbox: show status + request fix immediately
    locCheck?.addEventListener('change', async () => {
      const on = !!locCheck.checked;
      if (locStatus) {
        locStatus.classList.toggle('hidden', !on);
        if (!on) {
          locStatus.textContent = '';
          ['lat','lon','acc','ts'].forEach(k => delete locStatus.dataset[k]);
        } else {
          await requestLocationFix();
        }
      }
    });
    // Init location UI on load
    (() => {
      const on = !!locCheck?.checked;
      if (locStatus) {
        locStatus.classList.toggle('hidden', !on);
        if (on) requestLocationFix();
      }
    })();

    // Buttons → open pickers (now pointerup/click without preventDefault)
    bindUserActivation(chooseBtn, () => resilientOpen(fileInput));
    bindUserActivation(cameraBtn, () => resilientOpen(cameraInput));

    // --- Dropzone: drag & drop only (no click-to-open) ---
    const dz = dropzone;
    if (dz) {
      const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };

      // SHIELD: if buttons live inside the dropzone, stop their events in capture phase
      const actionsWrap = document.querySelector('.dz-actions');
      if (actionsWrap) {
        const shield = (e) => { e.stopPropagation(); };
        actionsWrap.addEventListener('touchstart', shield, { capture: true, passive: false });
        actionsWrap.addEventListener('touchend',   shield, { capture: true, passive: false });
        actionsWrap.addEventListener('click',      shield, { capture: true });
      }

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
          selectedFile = f;
          dz.classList.add('ready');
          if (submitBtn) submitBtn.disabled = false;
          if (statusEl) statusEl.textContent = '';
        }
      });

      // Block click + keyboard activation on the dropzone itself
      dz.addEventListener('click', (e) => e.preventDefault());
      dz.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
      });
    }

    // On file picker/camera selection: select file, don’t upload
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) {
        selectedFile = f;
        dropzone?.classList.add('ready');
        if (submitBtn) submitBtn.disabled = false;
        if (statusEl) statusEl.textContent = '';
      }
    });
    cameraInput?.addEventListener('change', () => {
      const f = cameraInput.files && cameraInput.files[0];
      if (f) {
        selectedFile = f;
        dropzone?.classList.add('ready');
        if (submitBtn) submitBtn.disabled = false;
        if (statusEl) statusEl.textContent = '';
      }
    });

    // Submit click → upload selected file
    submitBtn?.addEventListener('click', async (e) => {
      e.preventDefault();

      // If email copy is requested, require valid email
      if (copyCheck?.checked) {
        if (!emailField?.value || !emailField.checkValidity()) {
          emailField?.reportValidity && emailField.reportValidity();
          statusEl && (statusEl.textContent = 'Please enter a valid email address.');
          return;
        }
      }

      if (selectedFile) await submitFile(selectedFile);
    });
  }

  // ---------- Upload ----------
  async function submitFile(f) {
    const dict = langStrings[currentLang] || langStrings['en'] || {};
    if (!f) return;

    // refresh GPS before submit if requested
    if (locCheck?.checked) {
      await requestLocationFix();
    }

    if (submitBtn) submitBtn.disabled = true;
    statusEl && (statusEl.textContent = dict.uploading || 'Uploading…');

    const form = new FormData();
    form.append('file', f);
    form.append('slug_original', rawSlug || 'default');
    form.append('slug_known', themes[rawSlug] ? '1' : '0');
    if (refFromPath) form.append('reference', refFromPath);

    // Email (only if valid)
    if (copyCheck?.checked && emailField?.value && emailField.checkValidity && emailField.checkValidity()) {
      form.append('email', emailField.value.trim());
    }

    // GPS fields only; backend picks IP fallback if GPS absent
    if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
      form.append('lat',  locStatus.dataset.lat);
      form.append('lon',  locStatus.dataset.lon);
      if (locStatus.dataset.acc) form.append('accuracy', locStatus.dataset.acc);
      if (locStatus.dataset.ts)  form.append('loc_ts',  locStatus.dataset.ts);
    }

    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: form });
      if (!resp.ok) throw new Error('Upload failed');
      await resp.json();

      if (statusEl) statusEl.textContent = dict.success || 'Thanks. File received.';

      // reset UI
      selectedFile = null;
      dropzone?.classList.remove('ready');

      // cancel any pending picker fallback timers so dialogs don't re-open
      [fileInput, cameraInput].forEach(cancelTimersForInput);

      if (fileInput) fileInput.value = '';
      if (cameraInput) cameraInput.value = '';
      if (submitBtn) submitBtn.disabled = true;
    } catch (err) {
      console.error(err);
      if (statusEl) statusEl.textContent = 'Upload failed. Please try again.';
      if (submitBtn) submitBtn.disabled = false;
    }
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
