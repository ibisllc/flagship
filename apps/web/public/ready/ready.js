// Post-order landing. The homepage QR flow (heroQr.js) decrypts the recipe
// the phone delivered through the relay, stashes it in sessionStorage, and
// sends the browser here. This page hands the recipe to the user — copy it
// (preferred; nothing touches the disk) or download the .json — and points
// at the Flagship Assembler for their OS. flagshipserver.com never saw the
// plaintext: the recipe lived only in this tab's memory.

// MUST match heroQr.js's RECIPE_HANDOFF_KEY.
const RECIPE_HANDOFF_KEY = "flagship:qr:recipe";

// Installer links are on-brand: /download/<os> 302s to wherever the binary
// lives, so the storage URL never shows in the UI and the backend is
// swappable (see INSTALLER_DOWNLOADS in apps/com/src/route.ts).
const OS_INFO = {
  mac: { label: "macOS", note: "Apple Silicon & Intel · .dmg", href: "/download/mac" },
  windows: { label: "Windows", note: "Windows 10/11 · .exe", href: "/download/windows" },
  linux: { label: "Linux", note: "x86-64 · .AppImage", href: "/download/linux" },
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

function detectOS() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = ((navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform || "").toLowerCase();
  const s = `${plat} ${ua}`;
  // Mobile can't run the desktop Assembler — fall through to "pick a platform".
  if (/android|iphone|ipad|ipod/.test(s)) return null;
  if (/mac/.test(s)) return "mac";
  if (/win/.test(s)) return "windows";
  if (/linux|x11|cros/.test(s)) return "linux";
  return null;
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

// Download the custom Alpine boot image: POST the recipe to /api/personalize-iso
// via a real form submit so the browser streams the ~250 MB ISO straight to disk
// (a fetch().blob() would buffer the whole thing in memory). The server appends
// the signed recipe as a trailer to a pre-built base ISO and returns it with a
// Content-Disposition attachment, so the page stays put and the download starts.
function downloadAlpineIso(text) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/personalize-iso";
  form.style.display = "none";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "recipe";
  input.value = text;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 5000);
}

async function copyRecipe(text) {
  try {
    await navigator.clipboard.writeText(text);
    banner("Recipe copied — paste it into the Assembler.");
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
      if (ok) banner("Recipe copied — paste it into the Assembler.");
      else banner("Couldn't copy automatically — use Download .json instead.", false);
    } catch {
      banner("Couldn't copy automatically — use Download .json instead.", false);
    }
  }
}

function renderInstaller(detected) {
  const primary = $("installerPrimary");
  const others = $("installerOthers");
  if (!primary || !others) return;

  if (detected && OS_INFO[detected]) {
    const info = OS_INFO[detected];
    primary.innerHTML =
      `<a class="dl-primary" href="${info.href}">Download for ${escapeHtml(info.label)}</a>`;
    const note = document.createElement("div");
    note.className = "dl-note";
    note.textContent = info.note;
    primary.appendChild(note);

    const rest = OS_ORDER.filter((o) => o !== detected);
    others.innerHTML = "Also for: " + rest.map((o) =>
      `<a href="${OS_INFO[o].href}">${escapeHtml(OS_INFO[o].label)}</a>`
    ).join('<span class="sep">·</span>');
  } else {
    // Unknown / mobile — offer all three equally.
    primary.innerHTML = OS_ORDER.map((o) =>
      `<a class="btn-link" href="${OS_INFO[o].href}">${escapeHtml(OS_INFO[o].label)}</a>`
    ).join(" ");
    others.textContent = "The Assembler is a desktop app — pick your platform.";
  }

  // No-recipe view: point the "get the burner ahead of time" link at the
  // detected OS so the Assembler is reachable even without a pending recipe.
  const noRecipeLink = $("noRecipeInstaller");
  if (noRecipeLink && detected && OS_INFO[detected]) {
    noRecipeLink.href = OS_INFO[detected].href;
    noRecipeLink.textContent = `Download the Flagship Assembler for ${OS_INFO[detected].label}`;
  }
}

function main() {
  renderInstaller(detectOS());

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
  $("downloadIso")?.addEventListener("click", () => {
    downloadAlpineIso(recipeText);
    const s = $("isoStatus");
    if (s) s.textContent = "Building your image — the download will start in a moment.";
  });
  $("copyRecipe")?.addEventListener("click", () => copyRecipe(recipeText));
  $("downloadRecipe")?.addEventListener("click", () => {
    downloadRecipe(recipeText, filename);
    banner("Recipe downloaded — open it in the Assembler.");
  });

  // Clear the handoff so a refresh / back-forward doesn't resurface a stale
  // recipe; the text stays in this closure for the buttons.
  sessionStorage.removeItem(RECIPE_HANDOFF_KEY);
}

main();
