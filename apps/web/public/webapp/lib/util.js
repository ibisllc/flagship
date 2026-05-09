// Tiny helpers shared across views.

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sha256Bytes(input) {
  const buf = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(buf);
}
