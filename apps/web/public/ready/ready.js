// Post-order landing. The homepage QR flow (heroQr.js) decrypts the recipe
// the phone delivered through the relay, stashes it in sessionStorage, and
// sends the browser here. This page downloads that recipe and points the
// user at the Assembler. flagshipserver.com never sees the plaintext — the
// recipe lived only in this browser tab's memory until now.

// MUST match heroQr.js's RECIPE_HANDOFF_KEY.
const RECIPE_HANDOFF_KEY = "flagship:qr:recipe";

// Where the Flagship Assembler installer is hosted. Empty → the page links
// to /how-to.html (which explains how to get it) instead of a direct
// download. Set this to the DMG/installer URL once it's hosted to turn the
// section into a one-click download.
const INSTALLER_URL = "";

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function show(id) { document.getElementById(id)?.classList.remove("hidden"); }
function hide(id) { document.getElementById(id)?.classList.add("hidden"); }

function recipeFilename(recipe) {
  const domain = (recipe && recipe.serverDomain) ? String(recipe.serverDomain) : "server";
  let stamp = "";
  try {
    const exp = recipe?.authCode?.expiresAt;
    if (typeof exp === "number") {
      stamp = "-" + new Date(exp).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    }
  } catch { /* no stamp */ }
  return `flagship-recipe-${domain}${stamp}.json`;
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function renderInstaller() {
  const host = document.getElementById("installerActions");
  if (!host) return;
  if (INSTALLER_URL) {
    const a = document.createElement("a");
    a.className = "btn-link";
    a.href = INSTALLER_URL;
    a.textContent = "Download the Assembler";
    a.setAttribute("download", "");
    host.appendChild(a);
  } else {
    const a = document.createElement("a");
    a.className = "btn-link";
    a.href = "/how-to.html";
    a.textContent = "Get the Assembler →";
    host.appendChild(a);
  }
}

function renderMeta(recipe) {
  const el = document.getElementById("recipeMeta");
  if (!el) return;
  const lines = [];
  if (recipe?.serverDomain) lines.push(`server:  <strong>${escapeHtml(recipe.serverDomain)}</strong>`);
  const exp = recipe?.authCode?.expiresAt;
  if (typeof exp === "number") {
    lines.push(`expires: <strong>${escapeHtml(new Date(exp).toISOString())}</strong>`);
  }
  el.innerHTML = lines.join("<br>");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function main() {
  renderInstaller();

  const stashed = sessionStorage.getItem(RECIPE_HANDOFF_KEY);
  if (!stashed) {
    show("noRecipe");
    return;
  }

  let bytes, recipe;
  try {
    bytes = b64urlDecode(stashed);
    recipe = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    // A corrupt handoff → treat as "no recipe" rather than show a broken UI.
    console.warn("ready: could not decode the stashed recipe", e);
    show("noRecipe");
    return;
  }

  show("hasRecipe");
  const filename = recipeFilename(recipe);
  if (recipe?.serverDomain) {
    const dom = document.getElementById("serverDomain");
    if (dom) dom.textContent = recipe.serverDomain;
  }
  renderMeta(recipe);

  // Auto-download once on arrival (the user came straight from approving on
  // their phone). Some browsers block programmatic downloads without a
  // gesture — the "Download recipe again" button is always available.
  let autoOk = true;
  try {
    triggerDownload(bytes, filename);
  } catch (e) {
    autoOk = false;
    console.warn("ready: auto-download blocked", e);
  }
  const bannerText = document.getElementById("dlBannerText");
  if (bannerText && !autoOk) {
    bannerText.innerHTML = "Tap <strong>Download recipe again</strong> below to save your recipe.";
  }

  const btn = document.getElementById("downloadRecipe");
  if (btn) btn.onclick = () => triggerDownload(bytes, filename);

  // Clear the handoff so a back/forward or refresh doesn't silently re-download
  // on a stale tab. The bytes stay in this closure for the manual button.
  sessionStorage.removeItem(RECIPE_HANDOFF_KEY);
}

main();
