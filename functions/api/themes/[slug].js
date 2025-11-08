// functions/api/themes/[slug].js
export async function onRequestGet({ env, params }) {
  const DB = env.DB;
  const slug = String(params.slug || "").toLowerCase();

  const sql = `
    SELECT slug,
           brand_name AS brandName,
           logo_path  AS logo,
           favicon_path AS favicon,
           status,
           color_primary AS primary,
           color_accent  AS accent,
           color_text    AS text,
           color_muted   AS muted,
           color_border  AS border,
           color_button_text AS buttonText,
           header_bg AS headerBg
    FROM themes
    WHERE slug = ?
    LIMIT 1;
  `;

  const row = await DB.prepare(sql).bind(slug).first();
  if (!row) return new Response("Not found", { status: 404 });

  const out = {
    brandName: row.brandName,
    logo: row.logo,
    colors: {
      primary: row.primary,
      accent: row.accent,
      text: row.text,
      muted: row.muted,
      border: row.border,
      buttonText: row.buttonText
    },
    header: { bg: row.headerBg },
    favicon: row.favicon,
    status: row.status
  };

  return new Response(JSON.stringify(out), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=300, stale-while-revalidate=86400"
    }
  });
}
