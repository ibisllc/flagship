// Service access gating — admin UI (docs/service-access-gating.md).
//
// Per-service open ⇄ restricted toggle + (when restricted) an allow-list
// manager: ADD a person/group via a capability invite (one of THREE tiers —
// personal auto-approve, personal manual-approve, or group/multi-use), the list
// of added people/groups (decrypted from the household-key-sealed bundle .com
// stores as ciphertext), and remove (revoke on .com AND prune the bound AID on
// the box — the .com revoke alone doesn't reach the box, whose allow-list is
// add-only, so the box prune is what enforces).
//
// Identity model (v2 box-as-authority): create/revoke/list are now AID-signed —
// the box verifies them against the owner's STABLE AID (the IRK rotates). The
// access-mode change + the per-AID prune stay OWNER-IRK-signed to the box's
// pinned pipe. The bound principal is the friend's per-author CONTACT AID. See
// lib/serviceInvite.js for the wire + canonical bytes.
//
// THREE invite tiers (the create-time picker):
//   - personal auto-approve  — first-bind (the casual-share default).
//   - personal manual-approve — the friend's redeem is held {pending}; the
//     friend replies an acceptance the AUTHOR finalizes here ("Finalize an
//     acceptance"). Closes the link-theft race without learning the friend's id.
//   - group / multi-use — one link, maxN (0=unlimited) + optional expiry,
//     auto-approve, LOWER-TRUST. The guest list shows ONE "<label> — k/N" entry
//     with a one-tap group-revoke (per-member removal kept as a bonus).
//
// The consumer's USERNAME is never disclosed to the author in ANY tier — the
// author sees only the private label they themselves assigned (personal) or the
// group label (group).

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { getPodBaseUrl } from "../lib/api.js";
import { controlApex } from "../lib/apex.js";
import {
  deriveAccountIdFromSeed,
  deriveHouseholdKeyFromSeed,
  signWithIrk,
  signWithAccountId,
} from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import {
  createInvite,
  listInvites,
  removeServiceAllow,
  revokeInvite,
  setServiceAccessMode,
  submitAccept,
  parseAcceptReply,
} from "../lib/serviceInvite.js";
import { toast } from "../lib/toast.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml, skeletonCards } from "../lib/util.js";

registerView("view-service-access");

let currentService = null;

// localStorage key for the last-known access mode (the daemon has no GET).
const MODE_KEY_PREFIX = "flagship.serviceAccessMode.";

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
      <h2 class="mt-4">Add a person or group</h2>
      <div class="card">
        <p class="note">
          Names &amp; photos stay encrypted to your account — flagshipserver.com
          stores only ciphertext and never sees them. Their Flagship username is
          never shown to you. Send the link over a private channel.
        </p>

        <label class="mt-1">How they get access</label>
        <div id="sa-tier" class="mt-1">
          <label class="inline-check"><input type="radio" name="sa-tier" value="auto" checked /> Personal — anyone with the link gets in (fastest)</label>
          <label class="inline-check mt-1"><input type="radio" name="sa-tier" value="manual" /> Personal — you approve each one (sensitive)</label>
          <label class="inline-check mt-1"><input type="radio" name="sa-tier" value="group" /> Group link — one link, many people <span class="faint-sm">(lower trust)</span></label>
        </div>

        <label class="mt-2">Name / label <span class="faint-sm">(only you and your servers see it)</span></label>
        <input id="sa-name" type="text" placeholder="Alex" autocomplete="off" maxlength="120" />

        <div id="sa-group-opts" class="hidden mt-2">
          <label>Max uses <span class="faint-sm">(0 = unlimited)</span></label>
          <input id="sa-maxn" type="number" min="0" step="1" value="10" />
          <label class="mt-2">Expires in days <span class="faint-sm">(optional — a forever link is a liability)</span></label>
          <input id="sa-expiry-days" type="number" min="0" step="1" placeholder="30" />
        </div>

        <label class="mt-2">Photo <span class="faint-sm">(optional)</span></label>
        <input id="sa-photo" type="file" accept="image/*" />
        <div id="sa-photo-preview" class="mt-2"></div>
        <button id="sa-add-go" class="full-width mt-2">Create invite link</button>
        <div id="sa-add-status" class="mt-2 text-sm"></div>
        <div id="sa-add-result" class="mt-2 hidden">
          <label>Shareable link</label>
          <input id="sa-link" type="text" readonly class="mt-1" />
          <div id="sa-qr" class="mt-2" style="text-align:center;"></div>
          <div class="row-2 mt-2">
            <button id="sa-share" class="secondary">Share…</button>
            <button id="sa-copy" class="secondary">Copy link</button>
          </div>
          <p id="sa-manual-hint" class="note mt-2 hidden">
            This is approve-each. After they open the link, they'll send you back
            an acceptance code — paste it under &ldquo;Finalize an acceptance&rdquo;
            below to let them in.
          </p>
        </div>
      </div>

      <h2 class="mt-4">Finalize an acceptance</h2>
      <div class="card">
        <p class="note">
          For an <strong>approve-each</strong> invite: paste the acceptance code
          (or link) your friend sent back. It never reveals who they are — you're
          just confirming it really came from them.
        </p>
        <textarea id="sa-accept-input" rows="2" placeholder="flagship-accept:…" class="mt-1"></textarea>
        <button id="sa-accept-go" class="full-width mt-2">Finalize &amp; grant access</button>
        <div id="sa-accept-status" class="mt-2 text-sm"></div>
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
  // Tier radios: reveal/hide the group caps.
  for (const r of root.querySelectorAll('input[name="sa-tier"]')) {
    r.addEventListener("change", () => {
      $("sa-group-opts")?.classList.toggle("hidden", selectedTier() !== "group");
    });
  }
  $("sa-photo")?.addEventListener("change", onPhotoPicked);
  $("sa-add-go")?.addEventListener("click", () => {
    onAddPerson(serviceRef).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
  $("sa-accept-go")?.addEventListener("click", () => {
    onFinalizeAccept(serviceRef).catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });

  if (restricted) await renderPeople(serviceRef);
}

/** The currently-selected invite tier ("auto" | "manual" | "group"). */
function selectedTier() {
  const el = document.querySelector('input[name="sa-tier"]:checked');
  const v = el?.value;
  return v === "manual" || v === "group" ? v : "auto";
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

/** Render an inline QR of a link into `box` (in ADDITION to the link text). */
async function renderQrInto(box, link) {
  if (!box) return;
  try {
    const m = await import("/qrEncoder.js");
    box.innerHTML = m.renderQrSvg(link, { size: 200, foreground: "#0f172a", background: "#ffffff" });
  } catch {
    box.innerHTML = ""; // the link text is the reliable fallback
  }
}

/** Mint a capability invite (per the selected tier) and surface the share-link + QR. */
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
  const tier = selectedTier();
  // Group caps.
  let maxRedemptions;
  let expiresAt;
  if (tier === "group") {
    const maxN = Number($("sa-maxn")?.value);
    maxRedemptions = Number.isInteger(maxN) && maxN >= 0 ? maxN : 0;
    const days = Number($("sa-expiry-days")?.value);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = Date.now() + Math.round(days) * 86_400_000;
    }
  }
  const approvalMode = tier === "manual" ? "manual" : "auto";

  if (status) {
    status.className = "mt-2 text-sm";
    status.textContent = "creating…";
  }
  if (goBtn) {
    goBtn.disabled = true;
    goBtn.textContent = "Creating…";
  }
  try {
    const [aid, householdKey] = await Promise.all([
      deriveAccountIdFromSeed(session.umk),
      deriveHouseholdKeyFromSeed(session.umk),
    ]);
    const bundle = pickedPhotoDataUri ? { name, photo: pickedPhotoDataUri } : { name };
    const r = await createInvite({
      comBase: controlApex(),
      username: session.username,
      podBaseUrl: podBaseUrl(),
      authorAID: aid.publicKey,
      serviceRef,
      bundle,
      householdKey,
      approvalMode,
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      umk: session.umk,
      // Slice D (D-2): creating a service-collaborator invite is a SENSITIVE
      // (admin-only) op. Sign with the admin master root when present; else the
      // account AID (legacy — `.com` dual-accepts AID-or-IRK on the closed gate).
      signWithAccountId: sensitiveSigner(signWithAccountId),
    });
    // No local create cache: the author's box fetches the signed create from
    // .com at manual-finalize, so an invite can be finalized from ANY device.
    if (status) {
      status.className = "mt-2 text-sm ok-text";
      status.textContent = `Invite for ${name} created.`;
    }
    const result = $("sa-add-result");
    const linkEl = $("sa-link");
    if (result) result.classList.remove("hidden");
    if (linkEl) linkEl.value = r.link;
    $("sa-manual-hint")?.classList.toggle("hidden", tier !== "manual");
    await renderQrInto($("sa-qr"), r.link);
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

/**
 * MANUAL-approve finalize CORE — DOM-free + dependency-injected (mirrors
 * runRemovePerson). Parses the friend's acceptance reply and submits ONLY
 * `{accept, acceptSig}` to the AUTHOR's box; the box fetches the owner's signed
 * create from `.com` by inviteId (so finalize works from ANY device — no local
 * create cache). Throws a tagged error when the reply is junk (`bad-accept`).
 */
export async function runFinalizeAccept(
  { raw },
  { podBaseUrl, parseAcceptReply, submitAccept },
) {
  const parsed = parseAcceptReply(raw);
  if (!parsed) throw err("That doesn't look like an acceptance code. Paste the whole thing.", "bad-accept");
  const r = await submitAccept({
    baseUrl: podBaseUrl(),
    accept: parsed.accept,
    acceptSig: parsed.acceptSig,
  });
  return { ok: true, serviceRef: r.serviceRef, boundAID: r.boundAID };
}

async function onFinalizeAccept(serviceRef) {
  const status = $("sa-accept-status");
  const btn = $("sa-accept-go");
  if (btn?.disabled) return;
  const raw = ($("sa-accept-input")?.value || "").trim();
  if (!raw) {
    if (status) { status.className = "mt-2 text-sm err-text"; status.textContent = "Paste the acceptance code first."; }
    return;
  }
  if (status) { status.className = "mt-2 text-sm"; status.textContent = "finalizing…"; }
  if (btn) { btn.disabled = true; btn.textContent = "Finalizing…"; }
  try {
    await runFinalizeAccept({ raw }, { podBaseUrl, parseAcceptReply, submitAccept });
    if (status) { status.className = "mt-2 text-sm ok-text"; status.textContent = "Granted — they can open it now."; }
    if ($("sa-accept-input")) $("sa-accept-input").value = "";
    await renderPeople(serviceRef);
  } catch (e) {
    if (status) { status.className = "mt-2 text-sm err-text"; status.textContent = humanError(e); }
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Finalize & grant access"; }
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
      umk: session.umk,
      signWithAccountId,
    });
    const live = invites.filter((i) => !i.revokedAt);
    if (live.length === 0) {
      root.innerHTML = '<div class="card placeholder">No one added yet. Create an invite link above.</div>';
      return;
    }
    root.innerHTML = live.map((i) => peopleRowHtml(i)).join("");
    root.querySelectorAll('[data-action="sa-remove"]').forEach((b) => {
      b.addEventListener("click", () =>
        onRemovePerson(
          serviceRef,
          b.getAttribute("data-id"),
          b.getAttribute("data-name"),
          b.getAttribute("data-aid") || null,
          b.getAttribute("data-group") === "1",
        ).catch((e) => {
          console.error(e);
          toast(humanError(e), "err");
        }),
      );
    });
  } catch (e) {
    root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(humanError(e))}</p></div>`;
  }
}

/** One allow-list row — a person (single bind) OR a group ("<label> — k/N"). */
function peopleRowHtml(i) {
  const name = i.bundle?.name ?? "unknown";
  const photo = i.bundle?.photo;
  const isGroup = i.maxRedemptions !== null && i.maxRedemptions !== undefined;
  let statusText;
  if (isGroup) {
    const used = typeof i.redemptions === "number" ? i.redemptions : (Array.isArray(i.boundAIDs) ? i.boundAIDs.length : 0);
    const cap = i.maxRedemptions === 0 ? "∞" : i.maxRedemptions;
    statusText = `group — ${used}/${cap} joined`;
    if (i.expiresAt) {
      statusText += i.expiresAt <= Date.now() ? " · expired" : ` · expires ${new Date(i.expiresAt).toLocaleDateString()}`;
    }
  } else if (i.approvalMode === "manual" && !i.boundAID) {
    statusText = "approve-each — waiting for their acceptance";
  } else {
    statusText = i.boundAID ? "active" : "invite sent — not opened yet";
  }
  const avatar = photo
    ? `<img src="${escapeHtml(photo)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" />`
    : `<div class="avatar-mono" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--surface-2,#1f2937);">${escapeHtml((name[0] || (isGroup ? "#" : "?")).toUpperCase())}</div>`;
  const removeLabel = isGroup ? "Revoke group" : "Remove";
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
        <button class="danger small" data-action="sa-remove" data-id="${escapeHtml(i.inviteId)}" data-aid="${escapeHtml(i.boundAID ?? "")}" data-name="${escapeHtml(name)}" data-group="${isGroup ? "1" : "0"}">${removeLabel}</button>
      </div>
    </div>`;
}

/**
 * The two-leg remove CORE — DOM-free + dependency-injected, so it's testable
 * under Node (mirrors webappCompanionRequestsView's `runApprove`). Leg 1 records
 * the revocation on `.com` (AID-signed); leg 2 prunes the bound AID(s) on the BOX
 * (the leg that actually enforces). For a GROUP invite, leg 2 prunes EVERY bound
 * AID (the group is a labeled set). Returns `{ ok, prunedBox }`; an unredeemed
 * invite (no boundAID/boundAIDs) skips the box prune. A box-prune failure throws
 * a `box-prune-failed`-tagged error (the `.com` revoke already ran, so the admin
 * must know access may persist).
 */
export async function runRemovePerson(
  { serviceRef, inviteId, boundAID, boundAIDs, isGroup },
  { getSession, controlApex, podBaseUrl, signWithIrk, signWithAccountId, humanError, revokeInvite, removeServiceAllow },
) {
  const session = getSession();
  await revokeInvite({
    comBase: controlApex(),
    username: session.username,
    inviteId,
    umk: session.umk,
    // Slice D (D-2): revoking a service-collaborator invite is a SENSITIVE
    // (admin-only) op — admin master root when present, else the account AID.
    signWithAccountId: sensitiveSigner(signWithAccountId),
  });
  // The AIDs to prune on the box: the whole group set, else the single bound AID.
  const aids = isGroup && Array.isArray(boundAIDs) ? boundAIDs : boundAID ? [boundAID] : [];
  if (aids.length === 0) return { ok: true, prunedBox: false };
  for (const aid of aids) {
    try {
      await removeServiceAllow({
        baseUrl: podBaseUrl(),
        serviceRef,
        aid,
        umk: session.umk,
        signWithIrk,
      });
    } catch (e) {
      throw err(
        `Revoked on flagshipserver.com, but couldn't remove their access on your server (${humanError(e)}). They may still have access — try again.`,
        "box-prune-failed",
      );
    }
  }
  return { ok: true, prunedBox: true };
}

async function onRemovePerson(serviceRef, inviteId, name, boundAID, isGroup) {
  // For a group we don't carry boundAIDs in the click attrs (it can be many) —
  // re-fetch the row's bound set from the list so leg 2 prunes everyone.
  let boundAIDs = null;
  if (isGroup) {
    try {
      const session = getSession();
      const aid = await deriveAccountIdFromSeed(session.umk);
      const householdKey = await deriveHouseholdKeyFromSeed(session.umk);
      const invites = await listInvites({
        comBase: controlApex(),
        username: session.username,
        authorAID: aid.publicKey,
        householdKey,
        serviceRef,
        umk: session.umk,
        signWithAccountId,
      });
      const row = invites.find((i) => i.inviteId === inviteId);
      boundAIDs = row && Array.isArray(row.boundAIDs) ? row.boundAIDs : [];
    } catch {
      boundAIDs = [];
    }
  }
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: isGroup ? `Revoke the "${name}" group?` : `Remove ${name || "this person"}?`,
    message: isGroup
      ? "Everyone who joined through this link loses access the next time they try to open it."
      : "They'll lose access the next time they try to open it. You can re-add them later with a new link.",
    okLabel: isGroup ? "Revoke group" : "Remove",
    danger: true,
  });
  if (!ok) return;
  try {
    await runRemovePerson(
      { serviceRef, inviteId, boundAID, boundAIDs, isGroup },
      { getSession, controlApex, podBaseUrl, signWithIrk, signWithAccountId, humanError, revokeInvite, removeServiceAllow },
    );
  } catch (e) {
    await renderPeople(serviceRef);
    throw e;
  }
  toast(isGroup ? "Group revoked." : "Removed.");
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
