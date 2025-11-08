// functions/api/themes/index.js
export async function onRequestGet({ env }) {
  const DB = env.DB; // D1 binding (Preview = podfy-themes-qa)

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
    ORDER BY slug;
  `;

  const { results } = await DB.prepare(sql).all();

  // Build the same shape as your public/themes.json
  const out = {};
  for (const r of results) {
    out[r.slug] = {
      brandName: r.brandName,
      logo: r.logo,
      colors: {
        primary: r.primary,
        accent: r.accent,
        text: r.text,
        muted: r.muted,
        border: r.border,
        buttonText: r.buttonText
      },
      header: { bg: r.headerBg },
      favicon: r.favicon,
      status: r.status
    };
  }

  return new Response(JSON.stringify(out), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Edge cache; safe to tune later
      "cache-control": "s-maxage=300, stale-while-revalidate=86400"
    }
  });
}
