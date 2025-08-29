(async function(){
  // Derive slug from path
  const slug = (location.pathname.replace(/^\/+|\/+$/g,'') || 'default').toLowerCase();

  // Cache-bust JSON fetches to avoid stale data
  const bust = `?v=${Date.now()}`;

  // Load themes and apply
  const themes = await fetch('/themes.json' + bust, { cache: 'no-store' }).then(r=>r.json());
  const known = Object.prototype.hasOwnProperty.call(themes, slug);
  const theme = known ? themes[slug] : themes['default'];

  const root = document.documentElement.style;
  root.setProperty('--brand-primary', theme.colors.primary);
  root.setProperty('--brand-accent', theme.colors.accent);
  root.setProperty('--brand-text', theme.colors.text);
  root.setProperty('--brand-muted', theme.colors.muted);
  root.setProperty('--brand-border', theme.colors.border);
  root.setProperty('--brand-button-text', theme.colors.buttonText);
  root.setProperty('--header-bg', theme.header?.bg || '#FFF');
  document.getElementById('brandLogo').src = theme.logo;
  document.getElementById('favicon').href = theme.favicon || theme.logo;
  document.getElementById('pageTitle').textContent = (theme.brandName||'POD') + ' — Upload POD';

  // Unknown slug banner
  if (!known) {
    const banner = document.getElementById('banner');
    banner.innerHTML =
      'Unknown reference code. This upload will be sent to PODFY central ops. ' +
      'Visit the <a href="https://podfy.net/introduction" target="_blank" rel="noopener">PODFY product page</a>. ' +
      'We recommend ticking “Email me a copy” so you receive a confirmation.';
    banner.hidden = false;
  }

  // Translations
  const strings = await fetch('/i18n.json' + bust, { cache: 'no-store' }).then(r=>r.json());
  const langMenu = document.getElementById('langMenu');
  document.getElementById('translateBtn').addEventListener('click', () => {
    langMenu.innerHTML='';
    Object.entries(strings).forEach(([code,dict])=>{
      const b=document.createElement('button');
      b.textContent= dict.__name || code;
      b.addEventListener('click',()=>{applyLang(code); langMenu.hidden=true;});
      langMenu.appendChild(b);
    });
    langMenu.hidden = !langMenu.hidden;
  });
  function applyLang(code){
    const dict = strings[code] || strings['en'];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
  }
  applyLang('en');

  // Elements
  const fileInput = document.getElementById('fileInput');
  const submitBtn = document.getElementById('submitBtn');
  const dropzone = document.getElementById('dropzone');
  const statusEl = document.getElementById('status');

  const copyCheck = document.getElementById('copyCheck');
  const emailWrap = document.getElementById('emailWrap');
  const emailField = document.getElementById('emailField');

  const locCheck = document.getElementById('locCheck');
  const locStatus = document.getElementById('locStatus');

  // Info buttons (small popovers)
  setupPopover('copyInfo');
  setupPopover('locInfo');
  function setupPopover(id){
    const pop = document.getElementById(id);
    const btn = document.querySelector(`[aria-controls="${id}"]`);
    if (!pop || !btn) return;
    const closeAll = () => {
      document.querySelectorAll('.popover').forEach(p => p.hidden = true);
      document.querySelectorAll('.info-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded','false'));
    };
    btn.addEventListener('click', (e)=>{
      const open = btn.getAttribute('aria-expanded') === 'true';
      closeAll();
      if (!open) {
        pop.hidden = false;
        btn.setAttribute('aria-expanded','true');
      }
      e.stopPropagation();
    });
    document.addEventListener('click', (e)=>{
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded','false');
      }
    });
  }

  // Email field visibility toggled by checkbox
  copyCheck.addEventListener('change', () => {
    const show = copyCheck.checked;
    emailWrap.hidden = !show;
    if (!show) emailField.value = '';
  });

  // Drag & drop
  const updateSubmit = () => { submitBtn.disabled = !fileInput.files.length; };
  fileInput.addEventListener('change', updateSubmit);
  ['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt,(e)=>{e.preventDefault();dropzone.style.background='#FAFAFA';}));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt,(e)=>{e.preventDefault();dropzone.style.background='transparent';}));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) { fileInput.files = e.dataTransfer.files; updateSubmit(); }
  });

  // Optional precise GPS (permission-based)
  let locationPayload=null;
  locCheck?.addEventListener('change', () => {
    locationPayload = null;
    locStatus.textContent='';
    if (!locCheck.checked) return;
    if (!('geolocation' in navigator)) { locStatus.textContent='Location not supported by this browser.'; locCheck.checked=false; return; }
    locStatus.textContent='Requesting location…';
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        const {latitude, longitude, accuracy} = pos.coords;
        locationPayload = {lat: latitude, lon: longitude, acc: Math.round(accuracy), loc_ts: new Date(pos.timestamp).toISOString()};
        locStatus.textContent = `Location captured (±${locationPayload.acc} m).`;
      },
      (err)=>{ locStatus.textContent='Location denied or unavailable.'; locCheck.checked=false; },
      { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
    );
  });

  // Submit
  submitBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 25*1024*1024){ statusEl.textContent='File too large (max 25 MB).'; return; }
    submitBtn.disabled=true; submitBtn.textContent='Uploading…'; statusEl.textContent='';

    try{
      const form = new FormData();
      form.append('file', file);
      form.append('brand', slug);
      form.append('slug_original', slug);
      form.append('slug_known', known ? '1' : '0');

      // Only send copy if box checked AND email present
      if (copyCheck.checked && emailField.value && emailField.value.includes('@')) {
        form.append('email', emailField.value.trim());
      }

      if (locationPayload){ Object.entries(locationPayload).forEach(([k,v])=>form.append(k, String(v))); }

      const res = await fetch('/api/upload', { method:'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');

      statusEl.textContent = (strings['en']?.success) || 'Thanks. Your file was received and has been sent.';
      submitBtn.textContent='Submit';
      submitBtn.disabled=true; fileInput.value=''; emailField.value=''; emailWrap.hidden = !copyCheck.checked;
    }catch(e){
      statusEl.textContent='Delivery failed. Please try again.';
      submitBtn.textContent='Submit'; submitBtn.disabled=false;
    }
  });
})();
