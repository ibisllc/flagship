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

/**
 * #37 — produces the HTML for N skeleton "card" placeholders the
 * various detail views render while their /api/screens/* fetch is in
 * flight. Each fake card has a title row + 2 body rows + a pill stub
 * so the layout doesn't reflow once the real data arrives.
 *
 * Use:  root.innerHTML = skeletonCards(3);
 */
export function skeletonCards(count = 1) {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `
      <div class="skeleton-card" aria-hidden="true">
        <div class="row">
          <span class="skeleton skeleton-row medium"></span>
          <span class="skeleton skeleton-pill"></span>
        </div>
        <div class="skeleton skeleton-row long"></div>
        <div class="skeleton skeleton-row short"></div>
      </div>`;
  }
  return out;
}
