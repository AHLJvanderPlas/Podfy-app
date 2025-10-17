export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, env: "preview" }), {
    headers: { "content-type": "application/json" }
  });
}
