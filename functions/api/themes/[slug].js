// functions/api/themes/[slug].js
export async function onRequestGet({ env, params }) {
  const DB = env.DB;
  const slug = String(params.slug || "").toLowerCase();

  // Adjusted to match the renamed columns in your new table
  const sql = `
    SELECT
      slug,
      brand_name AS brandName,
      logo,
      status,
      color_primary AS primary,
      color_accent  AS accent,
      color_text    AS text,
      color_muted   AS muted,
      color_border  AS border,
      color_button_text AS buttonText,
      header_bg AS headerBg,
      issue_report,
      driver_copy,
      gps_check,
      mail_notification,
      multi_file
    FROM slug_details
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
    status: row.status,
    flags: {
      gps_check: !!row.gps_check,
      driver_copy: !!row.driver_copy,
      issue_report: !!row.issue_report,
      mail_notification: !!row.mail_notification,
      multi_file: !!row.multi_file
    }
  };

  return new Response(JSON.stringify(out), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "s-maxage=300, stale-while-revalidate=86400"
    }
  });
}
