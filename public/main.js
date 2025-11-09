/* public/main.js — PODFY uploader
   ------------------------------------------------------------
   Purpose
   - Structured controller for the public uploader.

   Capabilities
   - Theme & i18n loading
   - File selection (buttons + drag/drop) with client-side validation
   - Optional driver-copy email (toggle + validation)
   - (3C) Robust GPS capture (Android/iOS friendly) on user gesture
   - Delivery outcome: “Clean delivery” vs “Issue” (code/notes)
   - (3D) Anti-bot timestamp + browser timezone
   - (3E) Upload with progress bar and clear UX states

   Notes
   - Backend will also derive location from EXIF/IP if GPS is missing.
   - Only the fields your API expects are submitted.
   ------------------------------------------------------------
*/

(() => {
  // ----------------------------------------------------------
  // 0) Tiny DOM helpers
  // ----------------------------------------------------------
  const qs  = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ----------------------------------------------------------
  // 1) Element references (UI)
  // ----------------------------------------------------------
  // Branding
  const brandLogo = qs('#brandLogo');
  const banner    = qs('#banner');
  const heading   = qs('#heading');

  // Dropzone & file pickers
  const dropzone     = qs('#dropzone');
  const fileInput    = qs('#fileInput');     // general picker
  const chooseBtn    = qs('#chooseBtn');
  const cameraInput  = qs('#cameraInput');   // camera picker (image/* capture=environment)
  const cameraBtn    = qs('#cameraBtn');

  // File preview & progress
  const filePreview    = qs('#filePreview');
  const fileNameEl     = qs('#fileName');
  const removeFileBtn  = qs('#removeFileBtn');
  const uploadProgress = qs('#uploadProgress');
  const progressBar    = qs('#progressBar');
  const progressLabel  = qs('#progressLabel');

  // Action & status
  const submitBtn = qs('#submitBtn');
  const statusEl  = qs('#status');

  // Email copy toggle + field
  const copyCheck  = qs('#copyCheck');
  const emailWrap  = qs('#emailWrap');
  const emailField = qs('#emailField');

  // Location (GPS) toggle + status
  const locCheck  = qs('#locCheck');
  const locStatus = qs('#locStatus');

  // Delivery outcome block
  const chkClean   = document.getElementById("chk_clean");
  const issuePanel = document.getElementById("issuePanel");
  const issueCode  = document.getElementById("issue_code");
  const issueNotes = document.getElementById("issue_notes");

  // Hidden form helpers
  const issuedAtInput = qs('#form_issued_at'); // anti-bot timestamp

  // Language UI
  const langTrigger = qs('#translateBtn');
  const langMenu    = qs('#langMenu');
  const langLabel   = qs('#currentLangLabel');

  // ----------------------------------------------------------
  // 2) Constants & local state
  // ----------------------------------------------------------
  const MAX_BYTES    = 25 * 1024 * 1024;
  const ALLOWED_EXT  = ['pdf','jpg','jpeg','png','heic','heif','webp'];
  const ALLOWED_MIME = ['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'];

  const path     = new URL(location.href).pathname.replace(/\/+$/, '') || '/';
  const segs     = path.split('/').filter(Boolean);
  const rawSlug  = (segs[0] || '').toLowerCase();
  const refRaw   = segs[1] || '';
  const refSafe  = refRaw.replace(/[^A-Za-z0-9._-]/g, '');
  let   slug     = rawSlug || 'default';

  let themes      = {};
  let theme       = null;
  let langStrings = {};
  let currentLang = 'en';
  let selectedFile = null;

  // (3D) Browser timezone
  let browserTz = 'UTC';
  try {
    browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {}

  // (3D) Ensure anti-bot timestamp exists
  if (issuedAtInput && !issuedAtInput.value) {
    issuedAtInput.value = String(Date.now());
  }

  // ----------------------------------------------------------
  // 3) Small utilities
  // ----------------------------------------------------------
  const extOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

  function validateClientFile(f) {
    const okType = ALLOWED_MIME.includes(f.type) || ALLOWED_EXT.includes(extOf(f.name));
    if (!okType) return { ok: false, msg: 'Unsupported file type.' };
    if (f.size > MAX_BYTES) return { ok: false, msg: 'File too large (max 25 MB).' };
    return { ok: true };
  }

  // Preview chip & progress helpers
  function showPreview(f) {
    if (!f || !f.name) return;
    if (fileNameEl) {
      const mb = (f.size / 1048576);
      fileNameEl.textContent = `${f.name} ${isFinite(mb) ? `(${mb.toFixed(1)} MB)` : ''}`;
    }
    filePreview?.removeAttribute('hidden');
    qs('.dz-sub')?.classList.add('hidden');
    qs('.dz-constraints')?.classList.add('hidden');
    qs('.dz-actions')?.setAttribute('hidden', '');
  }

  function hidePreview() {
    filePreview?.setAttribute('hidden', '');
    qs('.dz-sub')?.classList.remove('hidden');
    qs('.dz-constraints')?.classList.remove('hidden');
    qs('.dz-actions')?.removeAttribute('hidden');
    if (fileNameEl) fileNameEl.textContent = '';
  }

  function resetProgress() {
    uploadProgress?.setAttribute('hidden', '');
    if (progressBar) progressBar.style.width = '0%';
    uploadProgress?.setAttribute('aria-valuenow', '0');
    if (progressLabel) progressLabel.textContent = '0%';
    uploadProgress?.classList.remove('error', 'success');
  }

  function updateProgress(pct) {
    if (!uploadProgress) return;
    uploadProgress.removeAttribute('hidden');
    progressBar && (progressBar.style.width = pct + '%');
    uploadProgress.setAttribute('aria-valuenow', String(pct));
    progressLabel && (progressLabel.textContent = pct + '%');
  }

  // Make click handlers count as “trusted user gestures” on mobile
  function bindUserActivation(el, handler) {
    if (!el) return;
    if (window.PointerEvent) el.addEventListener('pointerup', handler);
    else el.addEventListener('click', handler);
  }

  // Safely open file inputs on mobile (iOS quirks)
  function resilientOpen(inputEl) {
    if (!inputEl) return;

    // Clean up old timers/styles
    if (inputEl._fallbackTimer)  { clearTimeout(inputEl._fallbackTimer);  inputEl._fallbackTimer = null; }
    if (inputEl._revertTimer)    { clearTimeout(inputEl._revertTimer);    inputEl._revertTimer = null; }
    if (inputEl._prevStyles) { Object.assign(inputEl.style, inputEl._prevStyles); inputEl._prevStyles = null; }

    let opened = false;
    const onChange = () => { opened = true; };
    inputEl.addEventListener('change', onChange, { once: true });

    inputEl.click?.();

    inputEl._fallbackTimer = setTimeout(() => {
      if (opened) return;

      inputEl._prevStyles = {
        position: inputEl.style.position, left: inputEl.style.left, top: inputEl.style.top,
        width: inputEl.style.width, height: inputEl.style.height, opacity: inputEl.style.opacity,
        display: inputEl.style.display
      };
      Object.assign(inputEl.style, { display: 'block', position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px', opacity: '0' });
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

  // ----------------------------------------------------------
  // 4) Language & theme
  // ----------------------------------------------------------
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
    return available[k] ? k : 'en';
  }

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

    // Description meta
    const meta = dict.metaDescription || (langStrings.en && langStrings.en.metaDescription) || '';
    ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']
      .map(sel => qs(sel))
      .forEach(m => m && m.setAttribute('content', meta));

    const rtl = new Set(['ar','fa','he','ur']);
    document.documentElement.setAttribute('lang', code);
    document.documentElement.setAttribute('dir', rtl.has(code) ? 'rtl' : 'ltr');

    // Keep localized title with/without ref
    if (heading) {
      if (refSafe) {
        const tmpl = (langStrings[code] && langStrings[code].headingWithRef) || 'Upload CMR / POD for reference {ref}';
        heading.textContent = tmpl.replace('{ref}', refSafe);
      } else {
        heading.textContent = (langStrings[code] && langStrings[code].heading) || 'Upload CMR / POD';
      }
    }

    currentLang = code;
    reflectLangSelection();
  }

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

    // Localized H1 title set in applyLang as well
    if (heading) {
      const dict = langStrings[currentLang] || langStrings['en'] || {};
      if (refSafe) {
        const tmpl = dict.headingWithRef || 'Upload CMR / POD for reference {ref}';
        heading.textContent = tmpl.replace('{ref}', refSafe);
      } else {
        heading.textContent = dict.heading || 'Upload CMR / POD';
      }
    }
  }

  function renderUnknownSlugBanner(slugValue) {
    if (!banner) return;
    const dict = langStrings[currentLang] || langStrings['en'] || {};
    const msgTmpl   = dict.unknownSlug || 'Unknown reference “{slug}”. You can use the default tool below.';
    const linkLabel = dict.learnAboutPodfy || 'Learn about Podfy';
    const msg = msgTmpl.replace('{slug}', slugValue);
    banner.hidden = false;
    banner.dataset.type = 'unknownSlug';
    banner.dataset.slug = slugValue;
    banner.innerHTML = `${msg} <a href="https://podfy.net/introduction" target="_blank" rel="noopener">${linkLabel}</a>`;
  }

  // Language menu wiring
  function buildLangMenu() {
    if (!langMenu || !langStrings) return;
    const entries = Object.keys(langStrings)
      .map(k => ({ key: k, name: langStrings[k].__name || k }))
      .sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base'}));

    langMenu.innerHTML = '';
    entries.forEach(({ key, name }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-item';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', String(key === currentLang));
      btn.setAttribute('data-lang', key);
      btn.textContent = name;
      btn.addEventListener('click', () => { applyLang(key); closeLangMenu(); });
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLangMenu(); });
  }

  // Info-popovers for (i) buttons
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
          p.hidden = true; p.setAttribute('aria-hidden', 'true'); btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        popovers.forEach((p, btn) => {
          p.hidden = true; p.setAttribute('aria-hidden', 'true'); btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
  }

  // ----------------------------------------------------------
  // 5) (3C) Location (GPS) capture: best effort + UI feedback
  // ----------------------------------------------------------
  function setLocDataFromPosition(pos) {
    const c = pos && pos.coords ? pos.coords : {};
    const ts = pos && pos.timestamp ? String(pos.timestamp) : String(Date.now());
    if (!locStatus) return;

    if (typeof c.latitude === 'number' && typeof c.longitude === 'number') {
      locStatus.textContent = `Location ready (${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)})`;
      locStatus.dataset.lat = String(c.latitude);
      locStatus.dataset.lon = String(c.longitude);
      if (typeof c.accuracy === 'number') locStatus.dataset.acc = String(Math.round(c.accuracy));
      locStatus.dataset.ts = ts;
    } else {
      locStatus.textContent = 'Location unavailable';
      ['lat','lon','acc','ts'].forEach(k => delete locStatus.dataset[k]);
    }
  }

  function getCurrentPositionOnce() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 12000, maximumAge: 0
      });
    });
  }

  function watchPositionOnce() {
    return new Promise((resolve, reject) => {
      const id = navigator.geolocation.watchPosition(
        (pos) => { navigator.geolocation.clearWatch(id); resolve(pos); },
        (err) => { navigator.geolocation.clearWatch(id); reject(err); },
        { enableHighAccuracy: true, maximumAge: 0 }
      );
      setTimeout(() => { try { navigator.geolocation.clearWatch(id); } catch {} reject(new Error('watch timeout')); }, 14000);
    });
  }

  async function requestLocationFix() {
    if (!navigator.geolocation || !locStatus) return false;
    locStatus.textContent = 'Requesting location…';
    try { if (navigator.permissions?.query) await navigator.permissions.query({ name: 'geolocation' }); } catch {}
    try {
      const pos = await getCurrentPositionOnce().catch(() => watchPositionOnce());
      setLocDataFromPosition(pos);
      return true;
    } catch (err) {
      console.warn('Geolocation error:', err);
      locStatus.textContent = 'Unable to get location (permission denied or timeout)';
      ['lat','lon','acc','ts'].forEach(k => delete locStatus.dataset[k]);
      return false;
    }
  }

  // ----------------------------------------------------------
  // 6) UI wiring (email toggle, issue toggle, pickers, dropzone)
  // ----------------------------------------------------------
  function wireUI() {
    // Initial button state
    if (submitBtn) submitBtn.disabled = true;

    // Email copy → show/hide + required toggle
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
    // Initialize email UI
    (() => {
      const show = !!copyCheck?.checked;
      if (emailWrap) { emailWrap.classList.toggle('hidden', !show); emailWrap.hidden = !show; }
      if (emailField) { if (show && emailField.type !== 'email') emailField.type = 'email'; emailField.required = !!show; }
    })();

    // Delivery outcome (“Clean” vs “Issue”)
    function syncIssueUI() {
      const isClean = !!(chkClean && chkClean.checked);
      if (issuePanel) issuePanel.hidden = isClean;   // outlined panel only when NOT clean
      if (isClean) {
        if (issueCode)  issueCode.value = "";
        if (issueNotes) issueNotes.value = "";
      }
    }
    if (chkClean) {
      chkClean.addEventListener("change", syncIssueUI);
      syncIssueUI(); // initialize
    }

    // Location checkbox → show status & try to capture on demand
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

    // Open pickers with robust user activation handling
    bindUserActivation(chooseBtn, () => resilientOpen(fileInput));
    bindUserActivation(cameraBtn, () => resilientOpen(cameraInput));

    // --- Dropzone (drag & drop only) ---
    if (dropzone) {
      const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };

      // Shield dropzone from button clicks (if buttons sit inside)
      const actionsWrap = qs('.dz-actions');
      if (actionsWrap) {
        const shield = (e) => { e.stopPropagation(); };
        actionsWrap.addEventListener('touchstart', shield, { capture: true, passive: false });
        actionsWrap.addEventListener('touchend',   shield, { capture: true, passive: false });
        actionsWrap.addEventListener('click',      shield, { capture: true });
      }

      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, (e) => {
          prevent(e);
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          dropzone.classList.add('dragover');
        });
      });

      ['dragleave', 'dragend'].forEach(ev => {
        dropzone.addEventListener(ev, (e) => {
          prevent(e);
          dropzone.classList.remove('dragover');
        });
      });

      dropzone.addEventListener('drop', (e) => {
        prevent(e);
        dropzone.classList.remove('dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        const f = files && files[0];
        if (!f) return;

        const v = validateClientFile(f);
        if (!v.ok) {
          statusEl && (statusEl.textContent = v.msg);
          dropzone.classList.remove('ready');
          hidePreview();
          resetProgress();
          submitBtn && (submitBtn.disabled = true);
          if (fileInput) fileInput.value = '';
          if (cameraInput) cameraInput.value = '';
          return;
        }

        selectedFile = f;
        dropzone.classList.add('ready');
        submitBtn && (submitBtn.disabled = false);
        statusEl && (statusEl.textContent = '');
        showPreview(f);
        resetProgress();
      });

      // Prevent activating chooser by clicking dropzone area
      dropzone.addEventListener('click', (e) => e.preventDefault());
      dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
      });
    }

    // File input changes
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const v = validateClientFile(f);
      if (!v.ok) {
        statusEl && (statusEl.textContent = v.msg);
        dropzone?.classList.remove('ready');
        hidePreview();
        resetProgress();
        submitBtn && (submitBtn.disabled = true);
        fileInput.value = '';
        return;
      }
      selectedFile = f;
      showPreview(f);
      resetProgress();
      dropzone?.classList.add('ready');
      submitBtn && (submitBtn.disabled = false);
      statusEl && (statusEl.textContent = '');
    });

    cameraInput?.addEventListener('change', () => {
      const f = cameraInput.files && cameraInput.files[0];
      if (!f) return;
      const v = validateClientFile(f);
      if (!v.ok) {
        statusEl && (statusEl.textContent = v.msg);
        dropzone?.classList.remove('ready');
        hidePreview();
        resetProgress();
        submitBtn && (submitBtn.disabled = true);
        cameraInput.value = '';
        return;
      }
      selectedFile = f;
      showPreview(f);
      resetProgress();
      dropzone?.classList.add('ready');
      submitBtn && (submitBtn.disabled = false);
      statusEl && (statusEl.textContent = '');
    });

    // Remove selected file
    removeFileBtn?.addEventListener('click', () => {
      selectedFile = null;
      dropzone?.classList.remove('ready');
      hidePreview();
      resetProgress();
      if (fileInput) fileInput.value = '';
      if (cameraInput) cameraInput.value = '';
      if (submitBtn) submitBtn.disabled = true;
      statusEl && (statusEl.textContent = '');
    });

    // Submit → validate email (if requested) and upload
    submitBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (copyCheck?.checked) {
        if (!emailField?.value || !emailField.checkValidity || !emailField.checkValidity()) {
          emailField?.reportValidity && emailField.reportValidity();
          statusEl && (statusEl.textContent = 'Please enter a valid email address.');
          return;
        }
      }
      if (selectedFile) await submitFile(selectedFile);
    });

    // Initial visual state
    hidePreview();
    resetProgress();
    dropzone?.classList.remove('ready');
    submitBtn && (submitBtn.disabled = true);
    statusEl && (statusEl.textContent = '');
  }

  // ----------------------------------------------------------
  // 7) Upload logic (with progress) — includes Steps 3D + 3E
  // ----------------------------------------------------------
  async function submitFile(f) {
    if (!f) return;

    // Refresh GPS right before submit if checkbox is on
    if (locCheck?.checked) {
      await requestLocationFix();
    }

    if (submitBtn) submitBtn.disabled = true;

    const form = new FormData();

    // (3D) Anti-bot + honeypot
    form.append('form_issued_at', issuedAtInput?.value || String(Date.now()));
    form.append('company_website', ''); // honeypot must remain empty

    // File + slug + ref
    form.append('file', f);
    form.append('brand', rawSlug || 'default');
    form.append('slug_original', rawSlug || 'default');
    form.append('slug_known', themes[rawSlug] ? '1' : '0');
    if (refSafe) form.append('reference', refSafe);

    // Email copy (optional)
    if (copyCheck?.checked && emailField?.value && emailField.checkValidity && emailField.checkValidity()) {
      form.append('email', emailField.value.trim());
    }

    // Delivery outcome flags (3E)
    const isClean = !!(chkClean && chkClean.checked);
    form.append('issue', isClean ? '0' : '1');
    if (!isClean) {
      if (issueCode && issueCode.value.trim())  form.append('issue_code',  issueCode.value.trim());
      if (issueNotes && issueNotes.value.trim()) form.append('issue_notes', issueNotes.value.trim());
    }

    // Browser GPS (3E). Backend falls back to EXIF/IP if absent.
    if (locStatus?.dataset?.lat && locStatus?.dataset?.lon) {
      form.append('lat',  locStatus.dataset.lat);
      form.append('lon',  locStatus.dataset.lon);
      if (locStatus.dataset.acc) form.append('accuracy', locStatus.dataset.acc);
      if (locStatus.dataset.ts)  form.append('loc_ts',  locStatus.dataset.ts);
    }

    // Browser timezone (3D)
    form.append('tz', browserTz);

    // Upload with progress using XHR (shows a proper progress bar)
    try {
      await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');

        // Initialize bar
        updateProgress(0);
        uploadProgress?.removeAttribute('hidden');
        progressLabel && (progressLabel.textContent = 'Starting… 0%');

        xhr.upload.addEventListener('progress', (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
          updateProgress(pct);
          progressLabel && (progressLabel.textContent = `Uploading… ${pct}%`);
        });

        xhr.addEventListener('load', () => {
          const ok = xhr.status >= 200 && xhr.status < 300;
          if (ok) {
            updateProgress(100);
            progressLabel && (progressLabel.textContent = 'Thanks. File received.');
            uploadProgress?.classList.remove('error');
            uploadProgress?.classList.add('success');

            // Reset UI
            hidePreview();
            selectedFile = null;
            dropzone?.classList.remove('ready');
            if (fileInput) fileInput.value = '';
            if (cameraInput) cameraInput.value = '';
            submitBtn && (submitBtn.disabled = true);
            statusEl && (statusEl.textContent = '');
          } else {
            progressLabel && (progressLabel.textContent = 'Upload failed. Please try again.');
            uploadProgress?.classList.remove('success');
            uploadProgress?.classList.add('error');
            submitBtn && (submitBtn.disabled = false);
          }
          resolve();
        });

        xhr.addEventListener('error', () => {
          progressLabel && (progressLabel.textContent = 'Network error. Please try again.');
          uploadProgress?.classList.remove('success');
          uploadProgress?.classList.add('error');
          submitBtn && (submitBtn.disabled = false);
          resolve();
        });

        xhr.send(form);
      });
    } catch (err) {
      console.error(err);
      statusEl && (statusEl.textContent = 'Upload failed. Please try again.');
      submitBtn && (submitBtn.disabled = false);
    }
  }

  // ----------------------------------------------------------
  // 8) Init
  // ----------------------------------------------------------
  (async function init() {
    await loadI18n();
    await loadTheme();
    buildLangMenu();
    wireLanguageMenu();
    wireInfoPopovers();
    wireUI();
  })();

})();
