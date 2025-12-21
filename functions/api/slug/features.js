export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").toLowerCase().trim();

  if (!slug) return json({ error: "missing slug" }, 400);

  const row = await env.DB.prepare(`
    SELECT
      check_gps,
      check_copy,
      check_clean,
      check_ref,
      check_funct_5,
      check_funct_6,
      mail_notification,
      multi_file,
      pdf_header,
      pdf_footer,
      funct_11,
      funct_12
    FROM slug_details
    WHERE slug = ?
    LIMIT 1
  `).bind(slug).first();

  // If slug not found, default all to 1 (safe for now; you can change later)
  const f = normalizeFlags(row || {});

  return json({ slug, features: f }, 200);
}

function normalizeFlags(row) {
  const b = (v, def = 1) => (v === 0 ? 0 : v === 1 ? 1 : def); // keep strict 0, default to 1

  return {
    check_gps:         !!b(row.check_gps),
    check_copy:        !!b(row.check_copy),
    check_clean:       !!b(row.check_clean),
    check_ref:         !!b(row.check_ref),
    check_funct_5:     !!b(row.check_funct_5),
    check_funct_6:     !!b(row.check_funct_6),
    mail_notification: !!b(row.mail_notification),
    multi_file:        !!b(row.multi_file),
    pdf_header:        !!b(row.pdf_header),
    pdf_footer:        !!b(row.pdf_footer),
    funct_11:          !!b(row.funct_11),
    funct_12:          !!b(row.funct_12),
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
