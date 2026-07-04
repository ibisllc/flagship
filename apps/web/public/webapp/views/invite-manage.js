// #82 — Invite manage view.
//
// Per-app pending invites + active accesses + revoke. Labels for both
// lists are resolved client-side from the local label-book (#82) — the
// daemon's response only carries opaque tags + IRK pubkey prefixes;
// the human-readable "John (work)" mapping never leaves this device.
//
// P6 status: the daemon BFF (`/api/screens/app-invite/{issue,list,access,revoke}`)
// is now live (commits 87868e8 + d0e6508). The legacy "no BFF" fallback
// branch is kept only as defence in depth for a misconfigured daemon
// (503 / 404) — the empty-state copy now matches the expected steady
// state ("no pending invites yet" rather than "tracked locally").

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { inlineConfirm } from "../lib/modal.js";
import { listLabelsForApp, removeLabel } from "../lib/labelBook.js";

registerView("view-invite-manage");

let currentApp = null;

export async function renderInviteManage(app) {
  currentApp = app;
  const root = $("invite-manage-content");
  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(app.slug ?? app.serviceId)}</div>
      <div class="muted-sm">${escapeHtml(app.url ?? "")}</div>
    </div>
    <h3 class="mt-4">Pending invites</h3>
    <div id="im-pending" class="mt-2"><div class="card placeholder">loading…</div></div>
    <h3 class="mt-4">Active accesses</h3>
    <div id="im-active" class="mt-2"><div class="card placeholder">loading…</div></div>
  `;

  const labels = await listLabelsForApp(app.serviceId);
  const labelByTag = new Map(labels.map((l) => [l.opaqueTagHex, l]));

  await renderPending(app, labelByTag);
  await renderActive(app, labelByTag);
}

async function renderPending(app, labelByTag) {
  const root = $("im-pending");
  try {
    const body = await screensFetch(
      `/api/screens/app-invite/list/${encodeURIComponent(app.serviceId)}`,
    );
    const pending = body.pending ?? [];
    if (pending.length === 0) {
      root.innerHTML = '<div class="card placeholder">no pending invites</div>';
      return;
    }
    root.innerHTML = pending.map((inv) => {
      const label = labelByTag.get((inv.opaqueTag ?? "").toLowerCase());
      const labelText = label ? label.displayName : "unknown";
      return `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(labelText)}</div>
              <div class="muted-sm">role: ${escapeHtml(inv.role ?? "")} · expires ${escapeHtml(new Date(inv.expiresAt ?? 0).toLocaleString())}</div>
              <div class="value text-xs">tag ${escapeHtml((inv.opaqueTag ?? "").slice(0, 12))}…</div>
            </div>
            <button class="danger" data-action="revoke-invite" data-name="${escapeHtml(labelText)}" data-tag="${escapeHtml(inv.opaqueTag ?? "")}" data-id="${escapeHtml(inv.inviteId ?? "")}">Revoke</button>
          </div>
        </div>
      `;
    }).join("");
    root.querySelectorAll('[data-action="revoke-invite"]').forEach((b) => {
      b.addEventListener("click", () => onRevokeInvite(app, b.getAttribute("data-id"), b.getAttribute("data-tag"), b.getAttribute("data-name")));
    });
  } catch (e) {
    if (e instanceof ScreensError && (e.status === 404 || e.status === 503)) {
      // Daemon BFF unreachable — render the locally-tracked labels as
      // a degraded read-only view so the user keeps the issuance log
      // even when the daemon can't be queried. The BFF is live in
      // production; this branch is defence-in-depth only.
      const local = [...labelByTag.values()];
      if (local.length === 0) {
        root.innerHTML = '<div class="card placeholder">no pending invites yet</div>';
        return;
      }
      root.innerHTML = local.map((l) => `
        <div class="card">
          <div class="weight-600">${escapeHtml(l.displayName)}</div>
          <div class="muted-sm">channel: ${escapeHtml(l.channel)} · sent ${escapeHtml(new Date(l.sentAt).toLocaleString())}</div>
          <div class="value text-xs">tag ${escapeHtml((l.opaqueTagHex ?? "").slice(0, 12))}…</div>
        </div>
      `).join("");
    } else {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(String(e))}</p></div>`;
    }
  }
}

async function renderActive(app, labelByTag) {
  const root = $("im-active");
  try {
    const body = await screensFetch(
      `/api/screens/app-invite/access/${encodeURIComponent(app.serviceId)}`,
    );
    const access = body.access ?? [];
    if (access.length === 0) {
      root.innerHTML = '<div class="card placeholder">no active access</div>';
      return;
    }
    root.innerHTML = access.map((a) => {
      const label = labelByTag.get((a.opaqueTag ?? "").toLowerCase());
      const labelText = label ? label.displayName : "unknown";
      return `
        <div class="card">
          <div class="row row-top">
            <div>
              <div class="weight-600">${escapeHtml(labelText)}</div>
              <div class="muted-sm">role: ${escapeHtml(a.role ?? "")} · since ${escapeHtml(new Date(a.grantedAt ?? 0).toLocaleString())}</div>
              <div class="value text-xs">IRK ${escapeHtml((a.irkPubHex ?? "").slice(0, 12))}…</div>
            </div>
            <button class="danger" data-action="revoke-access" data-name="${escapeHtml(labelText)}" data-irk="${escapeHtml(a.irkPubHex ?? "")}" data-tag="${escapeHtml(a.opaqueTag ?? "")}">Revoke</button>
          </div>
        </div>
      `;
    }).join("");
    root.querySelectorAll('[data-action="revoke-access"]').forEach((b) => {
      b.addEventListener("click", () => onRevokeAccess(app, b.getAttribute("data-irk"), b.getAttribute("data-tag"), b.getAttribute("data-name")));
    });
  } catch (e) {
    if (e instanceof ScreensError && (e.status === 404 || e.status === 503)) {
      root.innerHTML = '<div class="card placeholder">no active access yet</div>';
    } else {
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(String(e))}</p></div>`;
    }
  }
}

async function onRevokeInvite(app, inviteId, tag, name) {
  const who = name && name !== "unknown" ? name : "this invite";
  const ok = await inlineConfirm({
    title: "Revoke invite?",
    message: `${who} won't be able to accept this invite. This can't be undone.`,
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await screensFetch(`/api/screens/app-invite/revoke`, {
      method: "POST",
      body: JSON.stringify({ serviceId: app.serviceId, inviteId, scope: "invite" }),
    });
    if (tag) await removeLabel(app.serviceId, tag);
    toast("Invite revoked", "ok");
    await renderInviteManage(app);
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

async function onRevokeAccess(app, irkPubHex, tag, name) {
  const who = name && name !== "unknown" ? name : "this person";
  const ok = await inlineConfirm({
    title: "Revoke access?",
    message: `${who} will immediately lose access to this app. This can't be undone.`,
    okLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await screensFetch(`/api/screens/app-invite/revoke`, {
      method: "POST",
      body: JSON.stringify({ serviceId: app.serviceId, irkPubKey: irkPubHex, scope: "access" }),
    });
    if (tag) await removeLabel(app.serviceId, tag);
    toast("Access revoked", "ok");
    await renderInviteManage(app);
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

export function initInviteManageView() {
  $("invite-manage-back")?.addEventListener("click", async () => {
    if (currentApp) {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(currentApp.serviceId);
    } else {
      show("view-home");
    }
  });
  $("invite-manage-refresh")?.addEventListener("click", () => {
    if (currentApp) renderInviteManage(currentApp).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterInviteManage(app) {
  show("view-invite-manage");
  await renderInviteManage(app);
}
