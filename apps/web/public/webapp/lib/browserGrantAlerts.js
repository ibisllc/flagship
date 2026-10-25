// Browser access beyond an app's manifest (SEC-BROWSER-002, packages/server-daemon/src/browser/grantRequests.ts).
// An app asks its server for more than the sites it declared at install (one visit, this browser
// session, always, or devices on the owner's network); the box holds the ask until the owner answers.
// The webapp lists waiting asks under Activity and on the app's page, and asks about each in a sheet
// like a chat request: on load, on focus, after a notification click and on the screens socket.
//
// Allow is an owner-signed `flagship/browser-grant/v1` over exactly what the sheet showed, for the
// duration the app asked (the box verifies that one); Deny carries no signature and the box makes the
// app wait before asking again. The sheet is built from the structured ask, never from the box's own
// English description.

import { boxClient, getPodBaseUrl } from "./api.js";
import { loadAccountPods, sessionServers } from "./appPlacement.js";
import { getSession } from "./state.js";
import { sensitiveSigner } from "./adminRoot.js";
import { canonicalBrowserGrantAnswer } from "./browserGrant.js";
import { isCompanionProfile } from "./companionGuard.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { pushNotificationsEnabled } from "./pushSetting.js";
import { ACCESS_SW_MESSAGE, SCREENS_EVENT, createAccessAlertController } from "./accessAlerts.js";
import { podShortName } from "./podSwitcher.js";
import { toast } from "./toast.js";
import { humanError } from "./humanError.js";
import { escapeHtml } from "./util.js";
import { tr } from "./i18n.js";

export const BROWSER_REQUESTS_PATH = "/api/browser/owner/grant-requests";
export const BROWSER_ANSWER_PATH = "/api/browser/owner/grant-requests/answer";
export const BROWSER_EVENT = "browser-grant-request";

const CAPS = ["navigate", "read-dom", "screenshot", "input", "download"];
const DURATIONS = ["once", "session", "service"];

export const BROWSER_GRANT_COPY = Object.freeze({
  title: tr("Browser access request"),
  sites: tr("Sites"),
  canDo: tr("It can:"),
  appSays: tr("The app says:"),
  deny: tr("Deny"),
  notNow: tr("Not now"),
  denyNote: tr("If you deny, the app has to wait before asking again."),
  sectionTitle: tr("Browser access"),
  manifestNote: tr("Approved when you installed it"),
  adminOnly: tr("This device can't approve browser access. Use an admin device."),
  gone: tr("That request is no longer waiting."),
  allowed: tr("Browser access allowed"),
  denied: tr("Browser access denied"),
});

const CAP_LABEL = Object.freeze({
  navigate: tr("Open pages"),
  "read-dom": tr("Read page content"),
  screenshot: tr("Take screenshots"),
  input: tr("Type and click"),
  download: tr("Download files"),
});

const DURATION_LINE = Object.freeze({
  once: tr("For one visit"),
  session: tr("Until this browser session ends"),
  service: tr("Until you remove it"),
});

const ALLOW_LABEL = Object.freeze({
  once: tr("Allow once"),
  session: tr("Allow for this session"),
  service: tr("Always allow"),
});

export const capabilityLabel = (c) => CAP_LABEL[c] ?? c;
export const durationLine = (d) => DURATION_LINE[d] ?? d;
export const allowLabel = (d) => ALLOW_LABEL[d] ?? tr("Allow");

const str = (v) => typeof v === "string" && v.length > 0;

/** One well-formed ask from the box's list, or null. */
export function readGrantRequest(r) {
  if (!r || typeof r !== "object" || !str(r.requestId) || !str(r.serviceId)) return null;
  if (!DURATIONS.includes(r.duration)) return null;
  const capabilities = Array.isArray(r.capabilities) ? r.capabilities.filter((c) => CAPS.includes(c)) : [];
  if (capabilities.length === 0) return null;
  const origins = Array.isArray(r.origins) ? r.origins.filter(str) : [];
  let localNetwork = null;
  const ln = r.localNetwork;
  if (ln && ln.kind === "whole-lan") localNetwork = { kind: "whole-lan" };
  else if (ln && ln.kind === "exact" && Array.isArray(ln.hosts) && ln.hosts.every(str) && ln.hosts.length > 0) localNetwork = { kind: "exact", hosts: [...ln.hosts] };
  else if (ln) return null;
  if (origins.length === 0 && !localNetwork) return null;
  return {
    requestId: r.requestId,
    serviceId: r.serviceId,
    capabilities,
    origins,
    localNetwork,
    duration: r.duration,
    explanation: typeof r.explanation === "string" ? r.explanation.slice(0, 500) : "",
    at: typeof r.at === "number" ? r.at : 0,
  };
}

export function readGrantRequests(body) {
  return (Array.isArray(body?.requests) ? body.requests : []).map(readGrantRequest).filter(Boolean);
}

/** `{serviceId: name}` from a box's apps list: the name the owner knows the app by. */
export function appNamesOf(appsBody) {
  const out = {};
  for (const a of Array.isArray(appsBody?.apps) ? appsBody.apps : []) {
    if (a && str(a.serviceId)) out[a.serviceId] = str(a.slug) ? a.slug : a.serviceId;
  }
  return out;
}

/**
 * Every waiting ask on every server this device has a session for, each tagged with its
 * `serverDomain` and the app's name from that box's own list. A 404 (no app browser, an older box)
 * or an unreachable box adds nothing.
 */
export async function fetchBrowserGrantsOnServers(servers) {
  const lists = await Promise.all(
    (servers ?? []).map(async (s) => {
      let requests;
      try {
        requests = readGrantRequests(await s.fetchJson(BROWSER_REQUESTS_PATH));
      } catch {
        return [];
      }
      if (requests.length === 0) return [];
      let names = {};
      try {
        names = appNamesOf(await s.fetchJson("/api/screens/apps-list"));
      } catch {
        names = {};
      }
      return requests.map((r) => ({ ...r, serverDomain: s.fqdn, appName: names[r.serviceId] ?? r.serviceId }));
    }),
  );
  return lists.flat();
}

export const browserGrantKey = (r) => `${r.serverDomain ?? ""}\nbrowser\n${r.requestId}`;

/** "{app} wants to use this server's browser." */
export const grantRequestTitle = (r) => tr("{0} wants to use this server's browser.", r.appName ?? r.serviceId);

/** What one site entry means: a `*.x` pattern covers every address under x. */
export const siteNote = (origin) => (origin.startsWith("*.") ? tr("and every address under it") : "");

export function localNetworkLine(l) {
  if (!l) return "";
  if (l.kind === "whole-lan") return tr("Every device on your local network");
  return tr("These devices on your network: {0}", l.hosts.join(", "));
}

/** The body of the sheet and the cards: sites, local network, what it can do, for how long, its words. */
export function grantDetailsHtml(r, { small = false } = {}) {
  const note = small ? "note small" : "modal-message";
  const sites = r.origins.length
    ? `<p class="${note}"><strong>${escapeHtml(BROWSER_GRANT_COPY.sites)}</strong></p>
       <ul class="sd-egress-hosts" data-grant-sites>${r.origins
         .map((o) => `<li><span class="mono text-sm">${escapeHtml(o)}</span>${siteNote(o) ? ` <span class="note small">${escapeHtml(siteNote(o))}</span>` : ""}</li>`)
         .join("")}</ul>`
    : "";
  const lan = r.localNetwork ? `<p class="${note}" data-grant-lan>${escapeHtml(localNetworkLine(r.localNetwork))}</p>` : "";
  const caps = `<p class="${note}"><strong>${escapeHtml(BROWSER_GRANT_COPY.canDo)}</strong></p>
    <ul data-grant-caps>${r.capabilities.map((c) => `<li>${escapeHtml(capabilityLabel(c))}</li>`).join("")}</ul>`;
  const dur = `<p class="${note}" data-grant-duration>${escapeHtml(durationLine(r.duration))}</p>`;
  const says = r.explanation
    ? `<p class="${note}" data-grant-explanation>${escapeHtml(BROWSER_GRANT_COPY.appSays)} “${escapeHtml(r.explanation)}”</p>`
    : "";
  return `${sites}${lan}${caps}${dur}${says}`;
}

/** The POST body for an answer. Allow signs the ask exactly as shown, for the duration the app asked. */
export async function browserGrantAnswerBody(r, decision, { serverDomain, sign, now = Date.now }) {
  const issuedAt = now();
  if (decision === "deny") return { requestId: r.requestId, decision: "deny", issuedAt };
  const bytes = await canonicalBrowserGrantAnswer({
    serverDomain,
    requestId: r.requestId,
    serviceId: r.serviceId,
    decision: "allow",
    duration: r.duration,
    capabilities: r.capabilities,
    origins: r.origins,
    localNetwork: r.localNetwork,
    issuedAt,
  });
  const sig = await sign(bytes);
  return {
    requestId: r.requestId,
    decision: "allow",
    issuedAt,
    signature: Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

/** Answer one ask on the server that holds it; Allow is signed with this session's sensitive-order key. */
export async function answerBrowserGrant(r, decision, { client = boxClient(r.serverDomain || ""), sign, now = Date.now } = {}) {
  let signer = sign;
  if (!signer && decision === "allow") {
    const session = getSession();
    if (!session?.umk) throw new Error(tr("Unlock the webapp first"));
    signer = (bytes) => sensitiveSigner()(session.umk, bytes);
  }
  const body = await browserGrantAnswerBody(r, decision, { serverDomain: client.fqdn || r.serverDomain, sign: signer, now });
  return client.fetch(BROWSER_ANSWER_PATH, { method: "POST", body: JSON.stringify(body) });
}

export function browserGrantError(e) {
  if (e?.status === 404) return BROWSER_GRANT_COPY.gone;
  if (e?.status === 403) return BROWSER_GRANT_COPY.adminOnly;
  const reason = e?.body && typeof e.body === "object" && typeof e.body.error === "string" ? e.body.error : "";
  return reason || humanError(e);
}

export const browserAnsweredText = (decision) => (decision === "deny" ? BROWSER_GRANT_COPY.denied : BROWSER_GRANT_COPY.allowed);

// ───────────────────────────── the sheet ─────────────────────────────

function openSheet(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="modal-card" role="document">${html}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close("later");
      }
    };
    overlay.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => close(b.getAttribute("data-choice"))));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close("later");
    });
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => overlay.querySelector('[data-choice="deny"]')?.focus({ preventScroll: true }));
  });
}

/** Allow (labelled by the ask's duration) / Deny / Not now. Resolves to the choice. */
export function showBrowserGrantSheet(r, { multi = false } = {}) {
  return openSheet(`
    <h3 class="modal-title" data-browser-grant-sheet>${escapeHtml(BROWSER_GRANT_COPY.title)}</h3>
    <p class="modal-message" data-grant-title>${escapeHtml(grantRequestTitle(r))}</p>
    ${multi ? `<p class="note small">${escapeHtml(podShortName(r.serverDomain))}</p>` : ""}
    ${grantDetailsHtml(r)}
    <p class="note small">${escapeHtml(BROWSER_GRANT_COPY.denyNote)}</p>
    <div class="row-2 mt-3">
      <button class="secondary" data-choice="deny">${escapeHtml(BROWSER_GRANT_COPY.deny)}</button>
      <button data-choice="allow">${escapeHtml(allowLabel(r.duration))}</button>
    </div>
    <div class="access-sheet-later mt-2"><button class="linklike" data-choice="later">${escapeHtml(BROWSER_GRANT_COPY.notNow)}</button></div>
  `);
}

// ───────────────────────────── the cards (Activity, the app's page) ─────────────────────────────

/** One waiting ask as a card with its answers; a device that can't sign sees why instead. */
export function grantRequestCardHtml(r, i, { canAnswer, multi = false, withTitle = true } = {}) {
  const buttons = canAnswer
    ? `<div class="row-2 mt-2">
        <button class="secondary" data-browser-answer="deny" data-browser-i="${i}">${escapeHtml(BROWSER_GRANT_COPY.deny)}</button>
        <button data-browser-answer="allow" data-browser-i="${i}">${escapeHtml(allowLabel(r.duration))}</button>
      </div>
      <p class="note small">${escapeHtml(BROWSER_GRANT_COPY.denyNote)}</p>`
    : `<p class="note small">${escapeHtml(BROWSER_GRANT_COPY.adminOnly)}</p>`;
  return `<div class="card" data-browser-request="${escapeHtml(r.requestId)}">
    ${withTitle ? `<p class="value">${escapeHtml(grantRequestTitle(r))}</p>` : `<p class="value">${escapeHtml(BROWSER_GRANT_COPY.title)}</p>`}
    ${multi ? `<p class="note small">${escapeHtml(podShortName(r.serverDomain))}</p>` : ""}
    ${grantDetailsHtml(r, { small: true })}
    ${buttons}
  </div>`;
}

function bindAnswers(root, requests, after) {
  root.querySelectorAll("[data-browser-answer]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = requests[Number(b.getAttribute("data-browser-i"))];
      const decision = b.getAttribute("data-browser-answer");
      if (!r) return;
      root.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await answerBrowserGrant(r, decision);
        toast(browserAnsweredText(decision), "ok");
      } catch (e) {
        toast(browserGrantError(e), "err");
      }
      await after();
    }),
  );
}

/** Activity's Browser access requests section (`#activity-browser`): hidden when nothing waits. */
export async function renderBrowserGrantSection({ section = document.getElementById("activity-browser"), servers } = {}) {
  if (!section) return;
  const content = section.querySelector("#activity-browser-content");
  if (!content) return;
  if (isCompanionProfile()) {
    section.hidden = true;
    return;
  }
  const list = servers ?? sessionServers(await loadAccountPods(getSession()?.username));
  const requests = await fetchBrowserGrantsOnServers(list);
  if (requests.length === 0) {
    section.hidden = true;
    content.innerHTML = "";
    return;
  }
  const multi = new Set(requests.map((r) => r.serverDomain)).size > 1;
  const canAnswer = canSignAdminOrders();
  content.innerHTML = requests.map((r, i) => grantRequestCardHtml(r, i, { canAnswer, multi })).join("");
  section.hidden = false;
  bindAnswers(content, requests, () => renderBrowserGrantSection({ section, servers: list }));
}

/** The sites an app's manifest declares (`browser.domains`), approved with the install. */
export function manifestBrowserDomains(manifest) {
  const d = manifest && typeof manifest === "object" ? manifest.browser?.domains : null;
  return Array.isArray(d) ? d.filter(str) : [];
}

/**
 * The app page's "Browser access" section: what the manifest grants, then this app's waiting asks
 * with their answers. Empty when the app has neither.
 */
export function browserAccessSectionHtml({ domains = [], requests = [], canAnswer = false } = {}) {
  if (domains.length === 0 && requests.length === 0) return "";
  const declared = domains.length
    ? `<div class="card" data-browser-manifest>
        <ul class="sd-egress-hosts">${domains.map((d) => `<li class="mono text-sm">${escapeHtml(d)}</li>`).join("")}</ul>
        <p class="note small">${escapeHtml(BROWSER_GRANT_COPY.manifestNote)}</p>
      </div>`
    : "";
  return `<h2 class="mt-4">${escapeHtml(BROWSER_GRANT_COPY.sectionTitle)}</h2>
    ${declared}
    ${requests.map((r, i) => grantRequestCardHtml(r, i, { canAnswer, withTitle: false })).join("")}`;
}

/** Fill the app page's slot for `app` on the server `client` talks to. */
export async function loadBrowserAccessSection(slot, { app, manifest, client = boxClient(), isCurrent = () => true } = {}) {
  if (!slot || isCompanionProfile()) return;
  let requests = [];
  try {
    const all = readGrantRequests(await client.fetch(BROWSER_REQUESTS_PATH));
    requests = all.filter((r) => r.serviceId === app.serviceId).map((r) => ({ ...r, serverDomain: client.fqdn, appName: app.slug ?? app.serviceId }));
  } catch {
    requests = [];
  }
  if (!isCurrent()) return;
  slot.innerHTML = browserAccessSectionHtml({ domains: manifestBrowserDomains(manifest), requests, canAnswer: canSignAdminOrders() });
  bindAnswers(slot, requests, () => loadBrowserAccessSection(slot, { app, manifest, client, isCurrent }));
}

// ───────────────────────────── the shell ─────────────────────────────

/** Ask about each waiting request in a sheet; nothing over the lock, on a companion, on a device that can't sign, or with Push notifications off. */
export function startBrowserGrantAlerts({ isUnlocked }) {
  const isActive = () => {
    try {
      return isUnlocked() && pushNotificationsEnabled() && !isCompanionProfile() && canSignAdminOrders() && !!getPodBaseUrl() && !!getSession()?.umk;
    } catch {
      return false;
    }
  };
  const refreshActivity = () => {
    const section = document.getElementById("activity-browser");
    const view = document.getElementById("view-activity");
    if (section && view && !view.classList.contains("hidden")) void renderBrowserGrantSection({ section }).catch(() => {});
  };
  let multi = false;
  const controller = createAccessAlertController({
    isActive,
    keyOf: browserGrantKey,
    fetchRequests: async () => {
      const list = await fetchBrowserGrantsOnServers(sessionServers(await loadAccountPods(getSession()?.username)));
      multi = new Set(list.map((r) => r.serverDomain)).size > 1;
      return list;
    },
    handle: async (r) => {
      const choice = await showBrowserGrantSheet(r, { multi });
      if (choice !== "allow" && choice !== "deny") return "later";
      try {
        await answerBrowserGrant(r, choice);
      } catch (e) {
        toast(browserGrantError(e), "err");
        return "failed";
      }
      toast(browserAnsweredText(choice), "ok");
      refreshActivity();
      return choice;
    },
  });
  const poke = (force = false) => void controller.check({ force });
  document.addEventListener(SCREENS_EVENT, (ev) => {
    if (ev.detail?.type !== BROWSER_EVENT) return;
    poke(true);
    refreshActivity();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poke();
  });
  window.addEventListener("focus", () => poke());
  document.addEventListener("flagship:view-shown", () => poke());
  try {
    navigator.serviceWorker?.addEventListener("message", (ev) => {
      if (ev.data?.type === ACCESS_SW_MESSAGE) poke(true);
    });
  } catch {
    /* no service worker */
  }
  poke();
  return { controller, check: (force = true) => poke(force) };
}
