// Web-experience gating — "Process URL" authorize flow
// (docs/service-access-gating.md, "Web-experience gating").
//
// A plain browser can't register the `flagship://` scheme, so the webapp can't
// be the deeplink target. Instead the visitor copies the knock page's link
// ("Get link to paste in the app") and pastes it here. We:
//
//   1. parse the `flagship://access?server=&svc=&ref=&page=` link,
//   2. show a confirm ("Authorize this site? <svc>.<server>"),
//   3. require the webapp to be unlocked (its in-page UMK → stable AID),
//   4. AID-sign the KnockAuthorization + POST it to the box,
//   5. on success persist a SecuredSession + nudge the visitor back to the page,
//      whose poll then flips to the content.
//
// flagshipserver.com is never in this path — the authorize POSTs straight to
// the box's own pinned pipe.

import { $, registerView, show, setSubtitle } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { deriveAccountIdFromSeed, signWithAccountId } from "../keystore.js";
import {
  parseAccessDeepLink,
  serviceUrlFromDeepLink,
  authorizeKnock,
} from "../lib/serviceInvite.js";
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
      <div class="card-title">Authorize a site</div>
      <p class="note mt-2">
        A restricted site showed you a link to paste here. Copy the link from the
        site's "Get link to paste in the app" option, then paste it below to let
        that browser in.
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
  const where = pendingLink.svc ? `${pendingLink.svc}.${pendingLink.serverId}` : pendingLink.serverId;
  const session = getSession();
  const unlocked = !!(session && session.umk);
  root.innerHTML = `
    <div class="card">
      <div class="card-title">Authorize this site?</div>
      <p class="note mt-2">
        Let a browser in to <strong>${escapeHtml(where)}</strong>. Only do this
        for a browser you opened — it gets a session on this restricted site.
      </p>
      ${unlocked
        ? `<button id="aa-authorize" class="full-width mt-2">Authorize</button>`
        : `<p class="note mt-2">Unlock this device to authorize.</p>
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
    status.textContent = "authorizing…";
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Authorizing…";
  }
  try {
    const aid = await deriveAccountIdFromSeed(session.umk);
    const result = await authorizeKnock({
      serverId: pendingLink.serverId,
      serviceRef: pendingLink.serviceRef,
      pageId: pendingLink.pageId,
      svc: pendingLink.svc,
      visitorAID: aid.publicKey,
      umk: session.umk,
      signWithAccountId,
    });
    saveSecuredSession(result);
    const where = pendingLink.svc ? `${pendingLink.svc}.${pendingLink.serverId}` : pendingLink.serverId;
    const serviceUrl = serviceUrlFromDeepLink(pendingLink) || `https://${pendingLink.serverId}`;
    pendingLink = null;
    const root = $("access-authorize-content");
    root.innerHTML = `
      <div class="card">
        <div class="card-title">Authorized</div>
        <p class="note mt-2">
          The browser at <strong>${escapeHtml(where)}</strong> can now get in. Go
          back to that page — it'll load the site automatically.
        </p>
        <a id="aa-open" class="full-width mt-2" style="display:block;text-align:center;text-decoration:none">Open the site</a>
        <button id="aa-sessions" class="secondary full-width mt-2">Manage secured sessions</button>
      </div>`;
    const open = $("aa-open");
    if (open) open.setAttribute("href", serviceUrl);
    $("aa-sessions")?.addEventListener("click", async () => {
      const { enterSecuredSessions } = await import("./secured-sessions.js");
      await enterSecuredSessions();
    });
  } catch (e) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = humanError(e);
    }
    throw e;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Authorize";
    }
  }
}

export function initAccessAuthorizeView() {
  $("access-authorize-back")?.addEventListener("click", () => {
    pendingLink = null;
    show("view-settings-tab");
  });
}
