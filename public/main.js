(async function(){
  const slug = (location.pathname.replace(/^\/+|\/+$/g,'') || 'default').toLowerCase();
  const themes = await fetch('/themes.json').then(r=>r.json());
  const known = Object.prototype.hasOwnProperty.call(themes, slug);
  const theme = known ? themes[slug] : themes['default'];

  // Apply theme
  const root = document.documentElement.style;
  Object.entries(theme.colors).forEach(([k,v]) => root.setProperty(`--brand-${k}`, v));
  document.getElementById('brandLogo').src = theme.logo;
  document.getElementById('favicon').href = theme.favicon || theme.logo;
  document.getElementById('pageTitle').textContent = `${theme.brandName||'POD'} — Upload POD`;

  // Unknown slug banner
  if (!known) {
    const banner = document.getElementById('banner');
    banner.innerHTML = `Unknown reference code. This upload will be sent to PODFY central ops.
      Visit the <a href="https://podfy.app" target="_blank">PODFY product page</a>.
      We recommend ticking “Email me a copy”.`;
    banner.hidden = false;
  }

  // Translations
  const strings = await fetch('/i18n.json').then(r=>r.json());
  const applyLang = code => {
    const dict = strings[code]||strings.en;
    document.querySelectorAll('[data-i18n]').forEach(el=>{
      const key=el.dataset.i18n; if(dict[key]) el.textContent=dict[key];
    });
  };
  applyLang('en');
  document.getElementById('translateBtn').onclick=()=>{
    const menu=document.getElementById('langMenu');
    menu.innerHTML=''; Object.entries(strings).forEach(([c,d])=>{
      const b=document.createElement('button'); b.textContent=d.__name||c;
      b.onclick=()=>{applyLang(c); menu.hidden=true;}; menu.appendChild(b);
    });
    menu.hidden=!menu.hidden;
  };

  // Form logic
  const fileInput=document.getElementById('fileInput');
  const submitBtn=document.getElementById('submitBtn');
  const copyCheck=document.getElementById('copyCheck');
  const emailField=document.getElementById('emailField');
  const dropzone=document.getElementById('dropzone');
  const statusEl=document.getElementById('status');
  const locCheck=document.getElementById('locCheck');
  const locStatus=document.getElementById('locStatus');

  copyCheck.onchange=()=>{emailField.disabled=!copyCheck.checked; if(!copyCheck.checked) emailField.value='';};
  fileInput.onchange=()=>{submitBtn.disabled=!fileInput.files.length;};
  dropzone.ondrop=e=>{e.preventDefault();fileInput.files=e.dataTransfer.files;submitBtn.disabled=!fileInput.files.length;};

  let locationPayload=null;
  locCheck.onchange=()=>{
    if(!locCheck.checked) return;
    navigator.geolocation.getCurrentPosition(p=>{
      locationPayload={lat:p.coords.latitude,lon:p.coords.longitude,acc:Math.round(p.coords.accuracy),loc_ts:new Date(p.timestamp).toISOString()};
      locStatus.textContent=`Location captured (±${locationPayload.acc} m).`;
    },err=>{locStatus.textContent="Location denied.";locCheck.checked=false;});
  };

  submitBtn.onclick=async()=>{
    const file=fileInput.files[0]; if(!file) return;
    if(file.size>25*1024*1024){statusEl.textContent='File too large';return;}
    submitBtn.disabled=true; submitBtn.textContent='Uploading…';
    const form=new FormData(); form.append('file',file);
    form.append('brand',slug); form.append('slug_original',slug); form.append('slug_known',known?'1':'0');
    if(copyCheck.checked&&emailField.value) form.append('email',emailField.value);
    if(locationPayload) Object.entries(locationPayload).forEach(([k,v])=>form.append(k,v));
    try{
      const r=await fetch('/api/upload',{method:'POST',body:form});
      if(!r.ok) throw new Error(); statusEl.textContent='Thanks. File received and sent.';
    }catch{statusEl.textContent='Delivery failed.';}
    submitBtn.textContent='Submit';
  };
})();
