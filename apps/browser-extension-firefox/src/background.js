// The background page: pins every Flagship box's certificate in Firefox (docs/browser-extension.md "As built").
//
// Firefox's webRequest.getSecurityInfo() gives the leaf certificate of each connection to a Flagship name; the pin
// check compares it with the fingerprint the box itself signed (verified under the server key the owner's phone
// pinned). A mismatch cancels the request before any of the page loads, and a top-level page is replaced with the
// extension's warning page. There is no "continue anyway".

import { CERT_PIN_PATH, REFRESH_TIMEOUT_MS } from "./lib/config.js";
import { acceptEvidence, checkPin, finalAction, isFlagshipHost, needsRefresh, normalizeFingerprint } from "./lib/pinCheck.js";
import { loadBoxes, updateBox } from "./lib/store.js";

const FILTER = { urls: ["https://*.flagship.services/*", "https://*.fshp.app/*"] };

/** Leaf fingerprints of the extension's own fetches of a box's signed fingerprint, by URL. */
const ownFetchLeaves = new Map();
/** One refresh at a time per box. */
const refreshing = new Map();

// ── the pin check ──

browser.webRequest.onHeadersReceived.addListener(onHeaders, FILTER, ["blocking"]);

async function onHeaders(details) {
  let url;
  try { url = new URL(details.url); } catch { return {}; }
  if (!isFlagshipHost(url.hostname)) return {};
  let info;
  try {
    info = await browser.webRequest.getSecurityInfo(details.requestId, {});
  } catch {
    return {};
  }
  // Firefox's own validation decides broken and insecure connections; the pin only narrows a valid one.
  if (!info || (info.state !== "secure" && info.state !== "weak")) return {};
  const leaf = normalizeFingerprint(info.certificates?.[0]?.fingerprint?.sha256);
  if (details.tabId === -1 && url.pathname === CERT_PIN_PATH && url.searchParams.has("n")) {
    ownFetchLeaves.set(details.url, leaf);
    return {};
  }

  const now = Date.now();
  let result = checkPin({ host: url.hostname, servedSha256: leaf, boxes: await loadBoxes(), now });
  if (needsRefresh(result.verdict) && result.serverDomain) {
    const outcome = await refreshEvidence(result.serverDomain);
    result = checkPin({ host: url.hostname, servedSha256: leaf, boxes: await loadBoxes(), now: Date.now() });
    // The box's word names one certificate and this connection shows another, before any pin was held.
    if (result.verdict === "no-evidence" && outcome?.reason === "served-other-certificate" && outcome.served === leaf) {
      result = { verdict: "mismatch", serverDomain: result.serverDomain, expected: outcome.expected, served: leaf };
    }
  }
  await recordStatus(details, url.hostname, result);
  if (finalAction(result.verdict) !== "block") return {};
  if (details.type === "main_frame" && details.tabId >= 0) {
    const page = browser.runtime.getURL("src/pages/blocked.html") + "?" + new URLSearchParams({
      host: url.hostname,
      server: result.serverDomain ?? "",
      expected: result.expected ?? "",
      served: result.served ?? "",
      url: details.url,
    });
    void browser.tabs.update(details.tabId, { url: page }).catch(() => {});
  }
  return { cancel: true };
}

/** Fetch a box's fresh signed fingerprint over its extension session and keep it as the pin when it checks out. */
function refreshEvidence(serverDomain) {
  const running = refreshing.get(serverDomain);
  if (running) return running;
  const p = doRefresh(serverDomain).finally(() => refreshing.delete(serverDomain));
  refreshing.set(serverDomain, p);
  return p;
}

async function doRefresh(serverDomain) {
  const box = (await loadBoxes())[serverDomain];
  const now = Date.now();
  if (!box) return { ok: false, reason: "not-paired" };
  if (box.session !== "active" || !(box.tokenExpiresAt > now)) return { ok: false, reason: "no-session" };
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const target = `https://${serverDomain}${CERT_PIN_PATH}?n=${nonce}`;
  let res;
  try {
    res = await fetch(target, {
      headers: { "x-flagship-session": box.token, accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    ownFetchLeaves.delete(target);
    return { ok: false, reason: "unreachable" };
  }
  const leaf = ownFetchLeaves.get(target) ?? null;
  ownFetchLeaves.delete(target);
  if (res.status === 401) {
    // Believe "your session is over" only from the box itself: a connection with the certificate already pinned.
    if (leaf && box.evidence && leaf === box.evidence.certSha256) {
      await updateBox(serverDomain, (b) => (b ? { ...b, session: "ended", token: "" } : null));
      return { ok: false, reason: "session-ended" };
    }
    return { ok: false, reason: "refused" };
  }
  if (!res.ok) return { ok: false, reason: "unavailable" };
  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: "malformed" }; }
  const verdict = await acceptEvidence({ box, body, servedSha256: leaf, now: Date.now() });
  if (!verdict.ok) return verdict;
  await updateBox(serverDomain, (b) => (b ? { ...b, evidence: verdict.evidence } : null));
  return { ok: true };
}

// ── what the popup and the toolbar show ──

const BADGE = {
  match: { text: "✓", color: "#0f766e", title: "badgeMatch" },
  mismatch: { text: "!", color: "#b91c1c", title: "badgeMismatch" },
  "expired-evidence": { text: "?", color: "#b45309", title: "badgeStale" },
  "no-evidence": { text: "?", color: "#b45309", title: "badgeUnchecked" },
};

async function recordStatus(details, host, result) {
  if (details.tabId < 0 || details.type !== "main_frame") return;
  const status = { host, verdict: result.verdict, serverDomain: result.serverDomain ?? null, at: Date.now() };
  try {
    await browser.storage.session.set({ [`tab:${details.tabId}`]: status });
  } catch { /* the popup then says to reload */ }
  const b = BADGE[result.verdict];
  try {
    await browser.action.setBadgeText({ tabId: details.tabId, text: b ? b.text : "" });
    if (b) await browser.action.setBadgeBackgroundColor({ tabId: details.tabId, color: b.color });
    await browser.action.setTitle({ tabId: details.tabId, title: browser.i18n.getMessage(b ? b.title : "extName") });
  } catch { /* the tab went away */ }
}

browser.tabs.onRemoved.addListener((tabId) => {
  void browser.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

// ── messages from the popup, the pairing page, the warning page and the knock content script ──

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  // Only the extension's own pages may change what it keeps; the content script may only ask.
  const ownPage = sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(""));
  if (msg.type === "knock" && sender.tab && !ownPage) return knockStatus(sender.tab, msg);
  if (!ownPage) return undefined;
  if (msg.type === "status") return browser.storage.session.get(`tab:${msg.tabId}`).then((r) => r[`tab:${msg.tabId}`] ?? null);
  if (msg.type === "refresh" && typeof msg.serverDomain === "string") return refreshEvidence(msg.serverDomain);
  if (msg.type === "forget" && typeof msg.serverDomain === "string") return updateBox(msg.serverDomain, () => null).then(() => ({ ok: true }));
  return undefined;
});

/** What the knock banner may say about the page it found: the pin verdict for that tab's site. */
async function knockStatus(tab, msg) {
  let host = "";
  try { host = new URL(tab.url).hostname; } catch { return null; }
  const saved = (await browser.storage.session.get(`tab:${tab.id}`))[`tab:${tab.id}`];
  const boxes = await loadBoxes();
  const status = saved && saved.host === host ? saved : { host, verdict: "unknown-name", serverDomain: null };
  const server = typeof msg.server === "string" ? msg.server.toLowerCase() : "";
  return {
    verdict: status.verdict,
    serverDomain: status.serverDomain,
    // The link's server is one of the owner's paired boxes and the site's certificate is the one it signed.
    linkServerVerified: status.verdict === "match" && status.serverDomain === server,
    paired: Object.keys(boxes).length > 0,
  };
}
