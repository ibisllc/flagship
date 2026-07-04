// #82 — Invite issue view.
//
// Per-app invite composer. The phone-equivalent here:
//   1. Pick a random 16-byte opaqueTag (kept local; never to .com).
//   2. Generate a random 32-byte share-secret.
//   3. Sign an IssueInvite envelope with the user's PSK + POST it to
//      the pod at /.flagship/app/:serviceId/invite. The daemon stores the
//      secret hash and replies with the inviteId + the shareable
//      secret echoed back.
//   4. Compose the share URL (`<appUrl>/invite#k=<secret>&a=<serviceId>`).
//   5. Record a local label (displayName / channel / sentTo) keyed on
//      `(serviceId, opaqueTag)` so the manage view can resolve "John
//      (work)" later. The daemon never sees this metadata.
//   6. Open the Web Share API if available; fallback to a "Copy link"
//      button. Both happen client-side — no upstream call.
//
// Cross-worker dependency: PSK signing. The current webapp keystore
// holds the user's IRK; the PSK-equivalent for paired sessions is the
// session token already in localStorage (the daemon's invite handler
// trusts paired-session-gated POSTs as PSK-equivalent, see #80's
// security model section). When real PSK derivation lands, this view
// switches to calling `signIssueInvite` from lib/state.js.

import { $, registerView, show } from "../lib/router.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  buildShareUrl,
  generateOpaqueTag,
  putLabel,
} from "../lib/labelBook.js";

registerView("view-invite-issue");

let currentApp = null;

export async function renderInviteIssue(app) {
  currentApp = app;
  const root = $("invite-issue-content");
  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(app.slug ?? app.serviceId)}</div>
      <div class="muted-sm">${escapeHtml(app.url ?? "")}</div>
    </div>
    <div class="card mt-2">
      <p class="note">
        Invites are bearer share-links. Anyone with the link can claim
        access — the daemon enforces single-use + a 24-hour default TTL.
        Names you type below stay on this device.
      </p>
      <label>Label <span class="faint-sm">(visible only to you)</span></label>
      <input id="ii-label" type="text" placeholder="John (work)" autocomplete="off" />
      <label>Role</label>
      <select id="ii-role">
        <option value="member">member</option>
        <option value="admin">admin</option>
        <option value="reader">reader</option>
      </select>
      <label>Channel</label>
      <select id="ii-channel">
        <option value="imessage">iMessage</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="telegram">Telegram</option>
        <option value="signal">Signal</option>
        <option value="email">Email</option>
        <option value="qr">QR</option>
        <option value="airdrop">AirDrop</option>
        <option value="manual">Manual paste</option>
        <option value="other" selected>Other</option>
      </select>
      <label>Sent to <span class="faint-sm">(memo)</span></label>
      <input id="ii-sentto" type="text" placeholder="+1 555 0142" autocomplete="off" />
      <label>Context note <span class="faint-sm">(shown to invitee)</span></label>
      <input id="ii-context" type="text" placeholder="from harry's phone — work" autocomplete="off" maxlength="280" />
      <button id="ii-go" class="full-width mt-2">Issue invite</button>
      <div id="ii-status" class="mt-2 text-sm"></div>
      <div id="ii-result" class="mt-2 hidden">
        <label>Shareable link</label>
        <input id="ii-link" type="text" readonly class="mt-1" />
        <div class="row-2 mt-2">
          <button id="ii-share" class="secondary">Share…</button>
          <button id="ii-copy" class="secondary">Copy link</button>
        </div>
      </div>
    </div>
  `;
  $("ii-go")?.addEventListener("click", () => onIssue(app));
}

async function onIssue(app) {
  const status = $("ii-status");
  const goBtn = $("ii-go");
  // L6 — guard against a double-submit: an invite is a single-use bearer
  // credential, so a double-tap while the POST is in flight would mint TWO.
  // iOS/Android disable + relabel the button; do the same. The disabled check
  // also short-circuits a programmatic re-entry.
  if (goBtn?.disabled) return;
  const labelEl = $("ii-label");
  const roleEl = $("ii-role");
  const channelEl = $("ii-channel");
  const sentToEl = $("ii-sentto");
  const contextEl = $("ii-context");
  status.className = "mt-2 text-sm";
  status.textContent = "issuing…";

  const displayName = labelEl?.value?.trim() ?? "";
  if (displayName.length === 0) {
    status.className = "mt-2 text-sm err-text";
    status.textContent = "label is required (kept local)";
    return;
  }

  const opaqueTag = generateOpaqueTag();
  const role = roleEl?.value ?? "member";
  const channel = channelEl?.value ?? "other";
  const sentTo = sentToEl?.value ?? "";
  const contextNote = contextEl?.value ?? "";

  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = "Issuing…";
  }
  try {
    // Issue via the screens BFF. The pod-side IssueInvite signing
    // happens daemon-side off the paired-session token (the daemon
    // treats paired-session as PSK-equivalent for owner-controlled
    // operations). When the phone-issued PSK envelope path lands,
    // this call switches to /.flagship/app/<id>/invite directly.
    const body = await screensFetch(`/api/screens/app-invite/issue`, {
      method: "POST",
      body: JSON.stringify({
        serviceId: app.serviceId,
        role,
        opaqueTag,
        contextNote: contextNote || null,
      }),
    });
    const link = buildShareUrl(app.url, body.secret, app.serviceId);
    // Persist the local label BEFORE we surface the link — if the user
    // then taps share & the page is closed mid-flow, the label still
    // exists for the manage view to resolve.
    await putLabel(app.serviceId, opaqueTag, {
      displayName,
      channel,
      sentTo,
      notes: "",
    });
    status.className = "mt-2 text-sm ok-text";
    status.textContent = `Issued — expires ${formatWhen(body.expiresAt)}`;
    const result = $("ii-result");
    const linkEl = $("ii-link");
    result.classList.remove("hidden");
    linkEl.value = link;
    $("ii-share")?.addEventListener("click", () => shareIt(link));
    $("ii-copy")?.addEventListener("click", () => copyIt(link));
  } catch (e) {
    status.className = "mt-2 text-sm err-text";
    status.textContent = e instanceof ScreensError ? e.message : String(e);
  } finally {
    if (goBtn) {
      goBtn.disabled = false;
      goBtn.textContent = "Issue invite";
    }
  }
}

async function shareIt(link) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Flagship invite", url: link });
    } catch (e) {
      // user cancelled — non-fatal
    }
  } else {
    await copyIt(link);
  }
}

async function copyIt(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast("link copied", "ok");
  } catch {
    toast("copy failed — long-press the field to copy", "err");
  }
}

export function initInviteIssueView() {
  $("invite-issue-back")?.addEventListener("click", async () => {
    if (currentApp) {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(currentApp.serviceId);
    } else {
      show("view-home");
    }
  });
}

export async function enterInviteIssue(app) {
  show("view-invite-issue");
  await renderInviteIssue(app);
}
