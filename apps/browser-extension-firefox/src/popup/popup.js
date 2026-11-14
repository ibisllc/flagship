// The toolbar popup: which servers are paired, what the extension found about the current site, and unpair.
import { SITE_ORIGINS as ORIGINS } from "../lib/config.js";
import { t, localize } from "../lib/i18n.js";
import { isFlagshipHost } from "../lib/pinCheck.js";
import { loadBoxes } from "../lib/store.js";

const $ = (id) => document.getElementById(id);

const SITE_TEXT = {
  match: ["popupSiteMatch", "ok"],
  mismatch: ["popupSiteMismatch", "bad"],
  "expired-evidence": ["popupSiteStale", "warn"],
  "no-evidence": ["popupSiteUnchecked", "warn"],
  "unknown-name": ["popupSiteUnknown", "muted"],
};

async function renderSite() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab?.url ?? "").hostname; } catch { /* not a web page */ }
  $("site-host").textContent = host;
  const status = $("site-status");
  if (!host || !isFlagshipHost(host)) {
    status.textContent = t("popupSiteNotFlagship");
    status.className = "muted";
    return;
  }
  const saved = tab?.id !== undefined ? await browser.runtime.sendMessage({ type: "status", tabId: tab.id }) : null;
  if (!saved || saved.host !== host) {
    status.textContent = t("popupSiteReload");
    status.className = "muted";
    return;
  }
  const [key, cls] = SITE_TEXT[saved.verdict] ?? SITE_TEXT["unknown-name"];
  status.textContent = t(key, saved.serverDomain ?? "");
  status.className = cls;
}

function sessionLine(box, now) {
  if (box.session === "ended") return [t("popupSessionEnded"), "warn"];
  if (!(box.tokenExpiresAt > now)) return [t("popupSessionExpired"), "warn"];
  const until = new Date(box.tokenExpiresAt).toLocaleDateString(browser.i18n.getUILanguage());
  return [t("popupSessionActive", until), "muted"];
}

async function renderServers() {
  const boxes = Object.values(await loadBoxes()).sort((a, b) => a.serverDomain.localeCompare(b.serverDomain));
  const list = $("servers");
  list.replaceChildren();
  $("no-servers").classList.toggle("hidden", boxes.length > 0);
  const now = Date.now();
  for (const box of boxes) {
    const card = document.createElement("div");
    card.className = "card";
    const name = document.createElement("div");
    name.className = "mono";
    name.textContent = box.serverDomain;
    const [text, cls] = sessionLine(box, now);
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = text;
    const pin = document.createElement("div");
    pin.className = "muted";
    pin.textContent = box.evidence ? t("popupPinHeld", box.evidence.certSha256.slice(0, 16)) : t("popupPinNone");
    const forget = document.createElement("button");
    forget.className = "secondary";
    forget.textContent = t("popupForget");
    forget.addEventListener("click", async () => {
      if (!confirm(t("popupForgetConfirm", box.serverDomain))) return;
      await browser.runtime.sendMessage({ type: "forget", serverDomain: box.serverDomain });
      await renderServers();
    });
    const row = document.createElement("div");
    row.className = "row";
    const left = document.createElement("div");
    left.append(name, line, pin);
    row.append(left, forget);
    card.append(row);
    list.append(card);
  }
}

async function renderPermission() {
  const ok = await browser.permissions.contains({ origins: ORIGINS });
  $("perm").classList.toggle("hidden", ok);
}

document.addEventListener("DOMContentLoaded", async () => {
  localize();
  $("pair").addEventListener("click", async () => {
    await browser.tabs.create({ url: browser.runtime.getURL("src/pages/pair.html") });
    window.close();
  });
  $("grant").addEventListener("click", async () => {
    await browser.permissions.request({ origins: ORIGINS });
    await renderPermission();
  });
  await Promise.all([renderPermission(), renderSite(), renderServers()]);
});
