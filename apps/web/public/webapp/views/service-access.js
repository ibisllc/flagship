// Service access gating — admin UI (docs/service-access-gating.md).
//
// Per-service open ⇄ restricted toggle + (when restricted) an allow-list
// manager: add a person (name + optional photo → mint a capability invite via
// .com → copyable link), the list of added people (decrypted from the
// household-key-sealed bundle .com stores as ciphertext), and remove (revoke on
// .com AND prune the bound AID on the box — the .com revoke alone doesn't reach
// the box, whose allow-list is add-only, so the box prune is what enforces).
//
// Identity model: the access-mode change is OWNER-IRK-signed to the box's
// pinned pipe (POST /api/service-access); the invite create/revoke are
// IRK-signed to .com. The bound principal is the friend's STABLE AID. See
// lib/serviceInvite.js for the wire + canonical bytes.
//
// Read-path note: the daemon exposes no GET for the current mode, so the
// toggle is last-write-wins, persisted locally per service (the box's POST
// response is the source of truth on change). The allow-list IS read
// authoritatively from .com's listInvites (who is bound, decrypted locally).

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { getPodBaseUrl } from "../lib/api.js";
import { controlApex } from "../lib/apex.js";
import {
  deriveAccountIdFromSeed,
  deriveHouseholdKeyFromSeed,
  deriveIrkFromSeed,
  signWithIrk,
  signWithAccountId,
} from "../keystore.js";
import {
  createInvite,
  listInvites,
  removeServiceAllow,
  revokeInvite,
  setServiceAccessMode,
} from "../lib/serviceInvite.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-service-access");

let currentService = null;

// localStorage key for the last-known access mode (the daemon has no GET).
const MODE_KEY_PREFIX = "flagship.serviceAccessMode.";
// localStorage counter for the monotonic per-(account,device) inviteId input.
const COUNTER_KEY_PREFIX = "flagship.serviceInviteCounter.";

function modeKey(serviceRef) {
  return `${MODE_KEY_PREFIX}${serviceRef}`;
}
function lastKnownMode(serviceRef) {
  try {
    const v = localStorage.getItem(modeKey(serviceRef));
    return v === "restricted" || v === "open" ? v : null;
  } catch {
    return null;
  }
}
function rememberMode(serviceRef, mode) {
  try {
    localStorage.setItem(modeKey(serviceRef), mode);
  } catch {
    /* private mode — the box POST response remains the source of truth */
  }
}

/** Next monotonic invite counter for this account+device (best-effort local). */
function nextInviteCounter(serviceRef) {
  const key = `${COUNTER_KEY_PREFIX}${serviceRef}`;
  let n = 0;
  try {
    n = Number(localStorage.getItem(key)) || 0;
    localStorage.setItem(key, String(n + 1));
  } catch {
    // Fall back to a time-derived counter so two adds in the same render don't
    // collide on the inviteId (the daemon also dedups by inviteId).
    n = Date.now() % 1_000_000_000;
  }
  return n;
}

/** Box base URL of the currently-paired pod (canonical-bytes input). */
function podBaseUrl() {
  return getPodBaseUrl() ?? "";
}

export async function enterServiceAccess(service) {
  currentService = service;
  show("view-service-access");
  await renderServiceAccess(service);
}

export async function renderServiceAccess(service) {
  currentService = service;
  const root = $("service-access-content");
  root.innerHTML = skeletonCards(2);
  const serviceRef = service.serviceId;
  const session = getSession();
  if (!session.username || !session.umk) {
    root.innerHTML = `<div class="card"><p class="err-text">Unlock the webapp first.</p></div>`;
    return;
  }

  const mode = lastKnownMode(serviceRef) ?? "open";
  const restricted = mode === "restricted";

  root.innerHTML = `
    <div class="card">
      <div class="card-title">${escapeHtml(service.slug ?? serviceRef)}</div>
      <div class="muted-sm text-xs mt-1">id: ${escapeHtml(serviceRef)}</div>
    </div>

    <h2 class="mt-4">Who can open this</h2>
    <div class="card">
      <p class="note">
        <strong>Open</strong> — anyone with the link can open it.
        <strong>Restricted</strong> — only people you add below.
      </p>
      <label class="inline-check mt-2">
        <input type="checkbox" id="sa-restricted-toggle" ${restricted ? "checked" : ""} />
        Restrict to an allow-list
      </label>
      <div id="sa-mode-status" class="mt-2 text-xs muted-sm">
        ${lastKnownMode(serviceRef) ? `Current: ${restricted ? "restricted" : "open"}` : "Set the mode to confirm it on your server."}
      </div>
    </div>

    <div id="sa-allow-section" class="${restricted ? "" : "hidden"}">
      <h2 class="mt-4">Add a person</h2>
      <div class="card">
        <p class="note">
          Names &amp; photos stay encrypted to your account — flagshipserver.com
          stores only ciphertext and never sees them. The link is a bearer
          capability: send it over a private channel. It locks to the first
          account that opens it.
        </p>
        <label>Name <span class="faint-sm">(only you and your servers see it)</span></label>
        <input id="sa-name" type="text" placeholder="Alex" autocomplete="off" maxlength="120" />
        <label class="mt-2">Photo <span class="faint-sm">(optional)</span></label>
        <input id="sa-photo" type="file" accept="image/*" />
        <div id="sa-photo-preview" class="mt-2"></div>
        <button id="sa-add-go" class="full-width mt-2">Create invite link</button>
        <div id="sa-add-status" class="mt-2 text-sm"></div>
        <div id="sa-add-result" class="mt-2 hidden">
          <label>Shareable link</label>
          <input id="sa-link" type="text" readonly class="mt-1" />
          <div class="row-2 mt-2">
            <button id="sa-share" class="secondary">Share…</button>
            <button id="sa-copy" class="secondary">Copy link</button>
          </div>
        </div>
      </div>

      <h2 class="mt-4">People with access</h2>
      <div id="sa-people" class="mt-2"><div class="card placeholder">loading…</div></div>
    </div>
  `;

  $("sa-restricted-toggle")?.addEventListener("change", (ev) => {
    onToggleMode(serviceRef, !!ev.currentTarget.checked).catch((e) => {
      console.error(e);
      toast(humanError(e), "err");
    });
  });
  $("sa-photo")?.addEventListener("change", onPhotoPicked);
  $("sa-add-go")?.addEventListener("click", () => {
    onAddPerson(serviceRef).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });

  if (restricted) await renderPeople(serviceRef);
}

/** OWNER-IRK-sign + POST the access-mode change to the box. */
async function onToggleMode(serviceRef, wantRestricted) {
  const session = getSession();
  const status = $("sa-mode-status");
  const toggle = $("sa-restricted-toggle");
  const mode = wantRestricted ? "restricted" : "open";
  if (status) status.textContent = "saving…";
  if (toggle) toggle.disabled = true;
  try {
    await setServiceAccessMode({
      baseUrl: podBaseUrl(),
      serviceRef,
      mode,
      umk: session.umk,
      signWithIrk,
    });
    rememberMode(serviceRef, mode);
    if (status) status.textContent = `Current: ${mode}`;
    // Reveal/hide the allow-list section without a full re-render.
    const section = $("sa-allow-section");
    if (section) section.classList.toggle("hidden", mode !== "restricted");
    if (mode === "restricted") await renderPeople(serviceRef);
    toast(mode === "restricted" ? "Now restricted to your allow-list." : "Now open to anyone with the link.");
  } catch (e) {
    // Revert the toggle to its prior state on failure.
    if (toggle) toggle.checked = !wantRestricted;
    if (status) status.textContent = "Couldn't change the mode.";
    throw e;
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

let pickedPhotoDataUri = null;

/** Read the chosen image as a data: URI (capped) for the encrypted bundle. */
function onPhotoPicked(ev) {
  const file = ev.currentTarget.files?.[0];
  const preview = $("sa-photo-preview");
  pickedPhotoDataUri = null;
  if (preview) preview.innerHTML = "";
  if (!file) return;
  // Cap at ~256 KB encoded so the sealed bundle stays small (.com stores it).
  if (file.size > 256 * 1024) {
    toast("Photo is too large (max 256 KB). Pick a smaller image.", "err");
    if (ev.currentTarget) ev.currentTarget.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pickedPhotoDataUri = String(reader.result || "");
    if (preview && pickedPhotoDataUri) {
      preview.innerHTML = `<img src="${escapeHtml(pickedPhotoDataUri)}" alt="" style="max-height:64px;border-radius:8px;" />`;
    }
  };
  reader.onerror = () => toast("Couldn't read that image.", "err");
  reader.readAsDataURL(file);
}

/** Mint a capability invite for a new person and surface the share-link. */
async function onAddPerson(serviceRef) {
  const session = getSession();
  const status = $("sa-add-status");
  const goBtn = $("sa-add-go");
  if (goBtn?.disabled) return;
  const name = ($("sa-name")?.value || "").trim();
  if (!name) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = "Name is required (kept private to your account).";
    }
    return;
  }
  if (status) {
    status.className = "mt-2 text-sm";
    status.textContent = "creating…";
  }
  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = "Creating…";
  }
  try {
    const [aid, householdKey, device] = await Promise.all([
      deriveAccountIdFromSeed(session.umk),
      deriveHouseholdKeyFromSeed(session.umk),
      deriveIrkFromSeed(session.umk),
    ]);
    const bundle = pickedPhotoDataUri ? { name, photo: pickedPhotoDataUri } : { name };
    const r = await createInvite({
      comBase: controlApex(),
      username: session.username,
      podBaseUrl: podBaseUrl(),
      authorAID: aid.publicKey,
      authorDevicePub: device.publicKey,
      counter: nextInviteCounter(serviceRef),
      serviceRef,
      bundle,
      householdKey,
      umk: session.umk,
      signWithIrk,
    });
    if (status) {
      status.className = "mt-2 text-sm ok-text";
      status.textContent = `Invite for ${name} created.`;
    }
    const result = $("sa-add-result");
    const linkEl = $("sa-link");
    if (result) result.classList.remove("hidden");
    if (linkEl) linkEl.value = r.link;
    $("sa-share")?.addEventListener("click", () => shareIt(r.link));
    $("sa-copy")?.addEventListener("click", () => copyIt(r.link));
    // Clear the composer + refresh the people list (it now shows an unbound row).
    if ($("sa-name")) $("sa-name").value = "";
    if ($("sa-photo")) $("sa-photo").value = "";
    pickedPhotoDataUri = null;
    if ($("sa-photo-preview")) $("sa-photo-preview").innerHTML = "";
    await renderPeople(serviceRef);
  } catch (e) {
    if (status) {
      status.className = "mt-2 text-sm err-text";
      status.textContent = humanError(e);
    }
    throw e;
  } finally {
    if (goBtn) {
      goBtn.disabled = false;
      goBtn.textContent = "Create invite link";
    }
  }
}

/** Render the allow-list from .com (bundles decrypted locally). */
async function renderPeople(serviceRef) {
  const root = $("sa-people");
  if (!root) return;
  const session = getSession();
  try {
    const [aid, householdKey] = await Promise.all([
      deriveAccountIdFromSeed(session.umk),
      deriveHouseholdKeyFromSeed(session.umk),
    ]);
    const invites = await listInvites({
      comBase: controlApex(),
      username: session.username,
      authorAID: aid.publicKey,
      householdKey,
      serviceRef,
    });
    const live = invites.filter((i) => !i.revokedAt);
    if (live.length === 0) {
      root.innerHTML = '<div class="card placeholder">No one added yet. Create an invite link above.</div>';
      return;
    }
    root.innerHTML = live
      .map((i) => {
        const name = i.bundle?.name ?? "unknown";
        const photo = i.bundle?.photo;
        const bound = !!i.boundAID;
        const statusText = bound ? "active" : "invite sent — not opened yet";
        const avatar = photo
          ? `<img src="${escapeHtml(photo)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" />`
          : `<div class="avatar-mono" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface-2,#1f2937);">${escapeHtml((name[0] || "?").toUpperCase())}</div>`;
        return `
          <div class="card">
            <div class="row row-top">
              <div class="row" style="gap:10px;align-items:center;">
                ${avatar}
                <div>
                  <div class="weight-600">${escapeHtml(name)}</div>
                  <div class="muted-sm text-xs">${escapeHtml(statusText)}</div>
                </div>
              </div>
              <button class="danger small" data-action="sa-remove" data-id="${escapeHtml(i.inviteId)}" data-aid="${escapeHtml(i.boundAID ?? "")}" data-name="${escapeHtml(name)}">Remove</button>
            </div>
          </div>`;
      })
      .join("");
    root.querySelectorAll('[data-action="sa-remove"]').forEach((b) => {
      b.addEventListener("click", () =>
        onRemovePerson(serviceRef, b.getAttribute("data-id"), b.getAttribute("data-name"), b.getAttribute("data-aid") || null).catch((e) => {
          console.error(e);
          toast(humanError(e), "err");
        }),
      );
    });
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(e))}</p></div>`;
  }
}

/**
 * Remove a person: revoke the invite on .com AND (when they've bound an AID)
 * prune that AID from the box's allow-list. The .com revoke only records the
 * revocation — the box's allow-list is add-only, so the box prune is what
 * actually denies the friend's next request. Both legs run; an unredeemed invite
 * (no boundAID) is just the .com revoke (nothing to prune).
 */
async function onRemovePerson(serviceRef, inviteId, name, boundAID) {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: `Remove ${name || "this person"}?`,
    message: "They'll lose access the next time they try to open it. You can re-add them later with a new link.",
    okLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  const session = getSession();
  // 1) Record the revocation on .com (drops the invite from the authored list).
  await revokeInvite({
    comBase: controlApex(),
    username: session.username,
    inviteId,
    umk: session.umk,
    signWithIrk,
  });
  // 2) Prune the bound AID on the BOX — the leg that actually enforces. Surface a
  //    clear error if it fails so the admin knows the friend may still have access.
  if (boundAID) {
    try {
      await removeServiceAllow({
        baseUrl: podBaseUrl(),
        serviceRef,
        aid: boundAID,
        umk: session.umk,
        signWithIrk,
      });
    } catch (e) {
      await renderPeople(serviceRef);
      throw err(
        `Revoked on flagshipserver.com, but couldn't remove their access on your server (${humanError(e)}). They may still have access — try again.`,
        "box-prune-failed",
      );
    }
  }
  toast("Removed.");
  await renderPeople(serviceRef);
}

/** Tag an Error with a code (mirrors lib/serviceInvite.js's `err`). */
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function shareIt(link) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Flagship invite", url: link });
    } catch {
      /* user cancelled */
    }
  } else {
    await copyIt(link);
  }
}

async function copyIt(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied.");
  } catch {
    toast("Couldn't copy — long-press the field to copy.", "err");
  }
}

export function initServiceAccessView() {
  $("service-access-back")?.addEventListener("click", async () => {
    if (currentService) {
      const { enterServiceDetail } = await import("./service-detail.js");
      await enterServiceDetail(currentService.serviceId);
    } else {
      show("view-home");
    }
  });
  $("service-access-refresh")?.addEventListener("click", () => {
    if (currentService) renderServiceAccess(currentService).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}
