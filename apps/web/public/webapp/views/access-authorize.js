// Web-experience gating — "Process URL" authorize flow
// (docs/service-access-gating.md, "Web-experience gating").
//
// A plain browser can't register the `flagship://` scheme, so the webapp can't
// be the deeplink target. Instead the visitor copies the knock page's link
// ("Get link to paste in the app") and pastes it here. We:
//
//   1. parse the `…/access?server=&svc=&ref=&page=` link,
//   2. show a confirm ("Open <app> on <server>?"),
//   3. require the webapp to be unlocked (its in-page UMK),
//   4. sign the KnockAuthorization + POST it to the box (lib/knockIdentity.js):
//      with this device's account device key on our own servers, the share's
//      member key on a server shared with us, our id for the app on a box we
//      redeemed an invite for, and not at all on any other box,
//   5. on success persist a SecuredSession + nudge the visitor back to the page,
//      whose poll then flips to the content.
//
// flagshipserver.com is never in this path — the authorize POSTs straight to
// the box's own pinned pipe.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { authorizeKnockFor, hostsFromPods, NO_DEVICE_KEY, NOT_YOUR_SERVER } from "../lib/knockIdentity.js";
import { listSharedWithMe } from "../lib/serverShares.js";
import { parseAccessDeepLink, serviceUrlFromDeepLink } from "../lib/serviceInvite.js";
import { liveSync } from "../lib/liveSync.js";
import { listPodTokenIds } from "../lib/profilesStore.js";
import { getActiveProfile } from "../lib/profiles.js";
import { controlApex } from "../lib/apex.js";
import { saveSecuredSession } from "../lib/securedSessions.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { accountReadFetch } from "../lib/accountRead.js";

import { tr } from "../lib/i18n.js";
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
      <div class="card-title">${tr("Open an app in a browser")}</div>
      <p class="note mt-2">
        ${tr("A private app's sign-in page gives you a link to paste here. On that page, choose \"Get link to paste in the app\", then paste the link below to sign that browser in.")}
      </p>
      <textarea id="aa-link" rows="3" class="mt-2" placeholder="https://flagshipserver.com/access?server=…" autocomplete="off" autocapitalize="off" spellcheck="false">${escapeHtml(prefill)}</textarea>
      ${error ? `<p class="err-text mt-2">${escapeHtml(error)}</p>` : ""}
      <button id="aa-process" class="full-width mt-2">${tr("Process URL")}</button>
    </div>`;
  $("aa-process")?.addEventListener("click", () => {
    const raw = $("aa-link")?.value ?? "";
    const parsed = parseAccessDeepLink(raw);
    if (!parsed) {
      renderPaste(raw, tr("That doesn't look like a Flagship access link."));
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
  const title = app ? tr("Open {0} on {1}?", app, server) : tr("Open {0}?", server);
  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(title)}</div>
      <p class="note mt-2">
        ${tr("This signs the browser at <strong>{0}</strong> in as you. Only do this for a browser you opened yourself.", escapeHtml(where))}
      </p>
      ${unlocked
        ? `<button id="aa-authorize" class="full-width mt-2">${tr("Open")}</button>`
        : `<p class="note mt-2">${tr("Unlock this device to continue.")}</p>
           <button id="aa-unlock" class="full-width mt-2">${tr("Unlock")}</button>`}
      <button id="aa-cancel" class="secondary full-width mt-2">${tr("Cancel")}</button>
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
    status.textContent = tr("signing in…");
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr("Signing in…");
  }
  try {
    const ownServers = await ownServerHosts(pendingLink.serverId, session.username);
    const profile = getActiveProfile();
    const device = profile?.accountId && profile?.deviceId ? { accountId: profile.accountId, deviceId: profile.deviceId } : null;
    const host = String(pendingLink.serverId || "").toLowerCase();
    const sharedServers = ownServers.has(host) ? [] : await listSharedWithMe().catch(() => []);
    const result = await authorizeKnockFor(pendingLink, session.umk, { ownServers, device, sharedServers });
    saveSecuredSession(result);
    const { app, where } = describeLink(pendingLink);
    const serviceUrl = serviceUrlFromDeepLink(pendingLink) || `https://${pendingLink.serverId}`;
    pendingLink = null;
    const root = $("access-authorize-content");
    root.innerHTML = `
      <div class="card">
        <div class="card-title">${tr("Signed in")}</div>
        <p class="note mt-2">
          ${tr("The browser at <strong>{0}</strong> is signed in. Go back to that page: it opens {1} on its own.", escapeHtml(where), app ? escapeHtml(app) : "the app")}
        </p>
        <a id="aa-open" class="full-width mt-2" style="display:block;text-align:center;text-decoration:none">${tr("Open {0}", app ? escapeHtml(app) : "the app")}</a>
        <button id="aa-sessions" class="secondary full-width mt-2">${tr("Manage secured sessions")}</button>
      </div>`;
    const open = $("aa-open");
    if (open) open.setAttribute("href", serviceUrl);
    $("aa-sessions")?.addEventListener("click", async () => {
      const { enterSecuredSessions } = await import("./secured-sessions.js");
      await enterSecuredSessions();
    });
  } catch (e) {
    const refusal = e?.code === "not-own" ? NOT_YOUR_SERVER : e?.code === "no-device" ? NO_DEVICE_KEY : "";
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = refusal || humanError(e);
    }
    if (refusal) {
      toast(refusal, "err");
      return;
    }
    throw e;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("Open");
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
    const r = await accountReadFetch(`${controlApex()}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" });
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
