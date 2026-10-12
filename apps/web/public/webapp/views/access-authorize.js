// Web-experience gating — "Process URL" authorize flow
// (docs/service-access-gating.md, "Web-experience gating").
//
// A plain browser can't register the `flagship://` scheme, so the webapp can't
// be the deeplink target. Instead the visitor copies the knock page's link
// ("Get link to paste in the app") and pastes it here. We:
//
//   1. parse the `flagship://access?server=&svc=&ref=&page=` link,
//   2. show a confirm ("Open <app> on <server>?"),
//   3. require the webapp to be unlocked (its in-page UMK),
//   4. sign the KnockAuthorization + POST it to the box (lib/knockIdentity.js):
//      with the global AID on our own servers, with the per-owner contact AID
//      on a box we redeemed an invite for (the AID the invite allow-listed),
//      and not at all on any other box,
//   5. on success persist a SecuredSession + nudge the visitor back to the page,
//      whose poll then flips to the content.
//
// flagshipserver.com is never in this path — the authorize POSTs straight to
// the box's own pinned pipe.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { authorizeKnockFor, hostsFromPods, NOT_YOUR_SERVER } from "../lib/knockIdentity.js";
import { parseAccessDeepLink, serviceUrlFromDeepLink } from "../lib/serviceInvite.js";
import { liveSync } from "../lib/liveSync.js";
import { listPodTokenIds } from "../lib/profilesStore.js";
import { getActiveProfile } from "../lib/profiles.js";
import { controlApex } from "../lib/apex.js";
import { saveSecuredSession } from "../lib/securedSessions.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-access-authorize");

// The parsed link awaiting confirmation, held across the (possible) unlock detour.
let pendingLink = null;

/** Enter the authorize view. An optional pre-filled `raw` link (e.g. routed
 *  from a clipboard paste) skips straight to the confirm step. */
export async function enterAccessAuthorize(raw) {
  setSubtitle("authorize");
  show("view-access-authorize");
  pendingLink = typeof raw === "string" ? parseAccessDeepLink(raw) : null;
  if (pendingLink) renderConfirm();
  else renderPaste();
}

function renderPaste(prefill = "", error = "") {
  const root = $("access-authorize-content");
  root.innerHTML = `
    <div class="card">
      <div class="card-title">Open an app in a browser</div>
      <p class="note mt-2">
        A private app's sign-in page gives you a link to paste here. On that
        page, choose "Get link to paste in the app", then paste the link below
        to sign that browser in.
      </p>
      <textarea id="aa-link" rows="3" class="mt-2" placeholder="flagship://access?server=…&amp;svc=…&amp;ref=…&amp;page=…" autocomplete="off" autocapitalize="off" spellcheck="false">${escapeHtml(prefill)}</textarea>
      ${error ? `<p class="err-text mt-2">${escapeHtml(error)}</p>` : ""}
      <button id="aa-process" class="full-width mt-2">Process URL</button>
    </div>`;
  $("aa-process")?.addEventListener("click", () => {
    const raw = $("aa-link")?.value ?? "";
    const parsed = parseAccessDeepLink(raw);
    if (!parsed) {
      renderPaste(raw, "That doesn't look like a Flagship access link.");
      return;
    }
    pendingLink = parsed;
    renderConfirm();
  });
}

function renderConfirm() {
  const root = $("access-authorize-content");
  if (!pendingLink) {
    renderPaste();
    return;
  }
  const { app, server, where } = describeLink(pendingLink);
  const session = getSession();
  const unlocked = !!(session && session.umk);
  const title = app ? `Open ${app} on ${server}?` : `Open ${server}?`;
  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(title)}</div>
      <p class="note mt-2">
        This signs the browser at <strong>${escapeHtml(where)}</strong> in as
        you. Only do this for a browser you opened yourself.
      </p>
      ${unlocked
        ? `<button id="aa-authorize" class="full-width mt-2">Open</button>`
        : `<p class="note mt-2">Unlock this device to continue.</p>
           <button id="aa-unlock" class="full-width mt-2">Unlock</button>`}
      <button id="aa-cancel" class="secondary full-width mt-2">Cancel</button>
      <div id="aa-status" class="mt-2 text-sm"></div>
    </div>`;
  $("aa-cancel")?.addEventListener("click", () => {
    pendingLink = null;
    renderPaste();
  });
  $("aa-unlock")?.addEventListener("click", () => show("view-unlock"));
  $("aa-authorize")?.addEventListener("click", () =>
    onAuthorize().catch((e) => {
      console.error(e);
      toast(humanError(e), "err");
    }),
  );
}

async function onAuthorize() {
  const session = getSession();
  const status = $("aa-status");
  const btn = $("aa-authorize");
  if (btn?.disabled) return;
  if (!session.umk) {
    show("view-unlock");
    return;
  }
  if (!pendingLink) return;
  if (status) {
    status.className = "mt-2 text-sm";
    status.textContent = "signing in…";
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Signing in…";
  }
  try {
    const ownServers = await ownServerHosts(pendingLink.serverId, session.username);
    const result = await authorizeKnockFor(pendingLink, session.umk, { ownServers });
    saveSecuredSession(result);
    const { app, where } = describeLink(pendingLink);
    const serviceUrl = serviceUrlFromDeepLink(pendingLink) || `https://${pendingLink.serverId}`;
    pendingLink = null;
    const root = $("access-authorize-content");
    root.innerHTML = `
      <div class="card">
        <div class="card-title">Signed in</div>
        <p class="note mt-2">
          The browser at <strong>${escapeHtml(where)}</strong> is signed in. Go
          back to that page: it opens ${app ? escapeHtml(app) : "the app"} on its own.
        </p>
        <a id="aa-open" class="full-width mt-2" style="display:block;text-align:center;text-decoration:none">Open ${app ? escapeHtml(app) : "the app"}</a>
        <button id="aa-sessions" class="secondary full-width mt-2">Manage secured sessions</button>
      </div>`;
    const open = $("aa-open");
    if (open) open.setAttribute("href", serviceUrl);
    $("aa-sessions")?.addEventListener("click", async () => {
      const { enterSecuredSessions } = await import("./secured-sessions.js");
      await enterSecuredSessions();
    });
  } catch (e) {
    const notOwn = e?.code === "not-own";
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = notOwn ? NOT_YOUR_SERVER : humanError(e);
    }
    if (notOwn) {
      toast(NOT_YOUR_SERVER, "err");
      return;
    }
    throw e;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Open";
    }
  }
}

/**
 * The user's own server hosts: the LiveSync list, the boxes this device holds
 * a session for, and a demo account's server. When `serverId` isn't among
 * them, read `/pods` once in case LiveSync hasn't loaded yet.
 */
async function ownServerHosts(serverId, username) {
  const hosts = new Set(hostsFromPods(liveSync.get?.()?.pods));
  try {
    for (const h of listPodTokenIds()) hosts.add(String(h).toLowerCase());
  } catch {
    /* no active profile */
  }
  try {
    const demo = getActiveProfile()?.demoServer?.fqdn;
    if (typeof demo === "string" && demo) hosts.add(demo.trim().toLowerCase());
  } catch {
    /* no profile */
  }
  const host = String(serverId || "").toLowerCase();
  if (hosts.has(host) || !username) return hosts;
  try {
    const r = await fetch(`${controlApex()}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" });
    if (r.ok) for (const h of hostsFromPods((await r.json())?.pods)) hosts.add(h);
  } catch {
    /* offline: decide with what we have */
  }
  return hosts;
}

/** `{ app, server, where }` for a parsed link: the app's url label, the box's
 *  short name, and the full host the browser is on. */
function describeLink(link) {
  const server = String(link.serverId || "").split(".")[0] || link.serverId;
  const app = link.svc || "";
  const where = app ? `${app}.${link.serverId}` : link.serverId;
  return { app, server, where };
}

export function initAccessAuthorizeView() {
  $("access-authorize-back")?.addEventListener("click", () => {
    pendingLink = null;
    show("view-settings-tab");
  });
}
