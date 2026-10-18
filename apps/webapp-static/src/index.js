// Runs only when the static assets answer nothing: a missing file asked for by
// something other than a page navigation, or a method assets do not serve.
// (A navigation to a missing path never gets here: it is given index.html.)
const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
};

export default {
  async fetch(request) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { ...HEADERS, "content-type": "application/json", allow: "GET, HEAD" },
      });
    }
    return new Response("Not found", { status: 404, headers: HEADERS });
  },
};
