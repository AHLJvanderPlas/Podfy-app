export const onRequestPost = async ({ request, env }) => {
  try {
    const form = await request.formData();
    const file = form.get('file'); if(!file) return new Response("Missing file",{status:400});

    const slugOriginal=form.get('slug_original')||'default';
    const slugKnown=form.get('slug_known')==='1';
    const slug=slugKnown?slugOriginal:'default';
    const emailCopy=form.get('email')||'';
    const {lat,lon,acc,loc_ts}=Object.fromEntries(form);

    const themes=await (await fetch(new URL('/themes.json',request.url))).json();
    const theme=themes[slug]||themes.default;
    const mailTo=theme.mailTo;

    const now=new Date(), id=crypto.randomUUID().slice(0,8);
    const ymd=now.toISOString().slice(0,10).replace(/-/g,'');
    const hms=now.toTimeString().slice(0,8).replace(/:/g,'');
    const safeName=(file.name||'upload.bin').replace(/[^A-Za-z0-9_.-]/g,'_');
    const ext=safeName.split('.').pop();
    const base=`${slug}_${ymd}_${hms}_${id}`;
    const key=`${ymd}/${base}.${ext}`;

    await env.PODFY_BUCKET.put(key,file.stream(),{
      httpMetadata:{contentType:file.type||'application/octet-stream'}
    });

    const subject=`[PODFY] ${slug.toUpperCase()} ${ymd} ${hms} (${safeName})${slugKnown?'':` [UNKNOWN:${slugOriginal}]`}`;
    const text=`Slug used: ${slug}
Original slug: ${slugOriginal} (${slugKnown?'known':'UNKNOWN'})
File: ${safeName}
Stored: r2://${key}
Email copy: ${emailCopy||'No'}
Location: ${lat&&lon?`${lat},${lon} ±${acc}m @${loc_ts}`:'Not provided'}
`;

    const send=body=>fetch("https://api.mailchannels.net/tx/v1/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    await send({personalizations:[{to:[{email:mailTo}]}],from:{email:`noreply@${env.MAIL_DOMAIN}`},subject,content:[{type:"text/plain",value:text}]});
    if(emailCopy){await send({personalizations:[{to:[{email:emailCopy}]}],from:{email:`noreply@${env.MAIL_DOMAIN}`},subject:"Copy of your uploaded POD/CMR",content:[{type:"text/plain",value:`Thanks. Reference: ${base}`}]});}

    return new Response(JSON.stringify({ok:true,key}),{headers:{"content-type":"application/json"}});
  }catch{ return new Response("Upload failed",{status:500}); }
};
