// Post-order landing. The homepage QR flow (heroQr.js) decrypts the recipe
// the phone delivered through the relay, stashes it in sessionStorage, and
// sends the browser here. This page hands the recipe to the user — copy it
// (preferred; nothing touches the disk) or download the .json — and points
// at the Flagship Studio for their OS. flagshipserver.com never saw the
// plaintext: the recipe lived only in this tab's memory.

// MUST match heroQr.js's RECIPE_HANDOFF_KEY.
const RECIPE_HANDOFF_KEY = "flagship:qr:recipe";

// Installer links are on-brand: /download/<os> 302s to wherever the binary
// lives, so the storage URL never shows in the UI and the backend is
// swappable (see INSTALLER_DOWNLOADS in apps/com/src/route.ts).
const OS_INFO = {
  mac: { label: "macOS", note: "Apple Silicon & Intel · .dmg", href: "/download/mac" },
  windows: { label: "Windows", note: "Coming soon", href: null },
  linux: { label: "Linux", note: "Coming soon", href: null },
};
const OS_ORDER = ["mac", "windows", "linux"];

function $(id) { return document.getElementById(id); }
function show(id) { $(id)?.classList.remove("hidden"); }

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function banner(text, ok = true) {
  const b = $("statusBanner");
  const t = $("statusBannerText");
  if (!b || !t) return;
  t.textContent = text;
  b.classList.remove("hidden");
  b.querySelector(".tick").textContent = ok ? "✓" : "!";
}

function recipeFilename(recipe) {
  const domain = recipe && recipe.serverDomain ? String(recipe.serverDomain) : "server";
  let stamp = "";
  try {
    const exp = recipe?.authCode?.expiresAt;
    if (typeof exp === "number") stamp = "-" + new Date(exp).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  } catch { /* no stamp */ }
  return `flagship-recipe-${domain}${stamp}.json`;
}

function downloadRecipe(text, filename) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyRecipe(text) {
  try {
    await navigator.clipboard.writeText(text);
    banner("Recipe copied — paste it into the Builder.");
  } catch {
    // Fallback for browsers that block the async clipboard API.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) banner("Recipe copied — paste it into the Builder.");
      else banner("Couldn't copy automatically — use Download .json instead.", false);
    } catch {
      banner("Couldn't copy automatically — use Download .json instead.", false);
    }
  }
}

function renderInstaller() {
  const primary = $("installerPrimary");
  const others = $("installerOthers");
  if (!primary || !others) return;

  const mac = OS_INFO.mac;
  primary.innerHTML =
    `<a class="dl-primary" href="${mac.href}">Download for ${escapeHtml(mac.label)}</a>` +
    OS_ORDER.filter((os) => os !== "mac").map((os) =>
      `<span class="dl-pending" aria-disabled="true" title="${escapeHtml(OS_INFO[os].note)}">${escapeHtml(OS_INFO[os].label)} · ${escapeHtml(OS_INFO[os].note)}</span>`
    ).join("");
  const note = document.createElement("div");
  note.className = "dl-note";
  note.textContent = mac.note;
  primary.appendChild(note);
  others.textContent = "Mac is available now. Windows and Linux are still in pre-release development.";
}

function main() {
  renderInstaller();

  const stashed = sessionStorage.getItem(RECIPE_HANDOFF_KEY);
  if (!stashed) {
    show("noRecipe");
    return;
  }

  let recipeText, recipe;
  try {
    recipeText = new TextDecoder().decode(b64urlDecode(stashed));
    recipe = JSON.parse(recipeText);
  } catch (e) {
    console.warn("ready: could not decode the stashed recipe", e);
    show("noRecipe");
    return;
  }

  show("hasRecipe");
  if (recipe?.serverDomain) {
    const dom = $("serverDomain");
    if (dom) dom.textContent = recipe.serverDomain;
  }
  const meta = $("recipeMeta");
  if (meta) {
    const lines = [];
    if (recipe?.serverDomain) lines.push(`server:  <strong>${escapeHtml(recipe.serverDomain)}</strong>`);
    const exp = recipe?.authCode?.expiresAt;
    if (typeof exp === "number") lines.push(`expires: <strong>${escapeHtml(new Date(exp).toISOString())}</strong>`);
    meta.innerHTML = lines.join("<br>");
  }

  const filename = recipeFilename(recipe);
  $("copyRecipe")?.addEventListener("click", () => copyRecipe(recipeText));
  $("downloadRecipe")?.addEventListener("click", () => {
    downloadRecipe(recipeText, filename);
    banner("Recipe downloaded — open it in the Builder.");
  });

  // Clear the handoff so a refresh / back-forward doesn't resurface a stale
  // recipe; the text stays in this closure for the buttons.
  sessionStorage.removeItem(RECIPE_HANDOFF_KEY);
}

main();
