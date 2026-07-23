// Client-side draft composer for a new server. The webapp signs the recipe
// locally, downloads it, and the user opens that file in Flagship Studio.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { getSession, ensureUsername } from "../lib/state.js";
import { bytesToHex, signWithIrk, deriveSwkFromSeed } from "../keystore.js";
import { ensureAdminRoot, sensitiveSigner } from "../lib/adminRoot.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import {
  canonicalInstallBlob,
  deleteDraft,
  getDraft,
  listDrafts,
  saveDraft,
} from "../lib/buildDraft.js";
import { releaseServerName, serverDomainOf } from "../lib/releaseServer.js";
import { controlApex, serverFqdn } from "../lib/apex.js";
import { buildPairingOrder } from "../lib/bootApproval.js";
import { markSwkDepositPending, clearSwkDeposit } from "../lib/swkDeposit.js";
import { markPairingDepositPending, clearPairingDeposit } from "../lib/pairingDeposit.js";
import { setSessionToken } from "../lib/api.js";

registerView("view-create-server");

// Server (pod) names are a standard RFC-1123 DNS label — lowercase
// letters/digits with interior hyphens allowed (no leading/trailing
// hyphen), 1–63 chars. LOOSER than the username field on purpose: a
// server name is never composed with an app-name the way a username is,
// so `media-server` is fine here. Mirror of
// packages/control-plane/src/labels.ts validateServerLabel (the
// authoritative server-side check). A small server-specific reserved
// list mirrors RESERVED_SERVER_LABELS there.
const SERVER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SERVER_LABELS = new Set([
  "www", "api", "admin", "flagship", "flagshipserver", "services",
  "ns1", "ns2", "mail", "tunnel", "control", "status",
]);
/** True iff `name` is a syntactically valid, non-reserved server name. */
function isValidServerName(name) {
  return typeof name === "string"
    && SERVER_NAME_RE.test(name)
    && !RESERVED_SERVER_LABELS.has(name);
}
const TAG_CLAIM = "flagship/claim-username/v1";
const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_RCK_REGISTER = "flagship/rck-register/v1";

let activeDraftId = null;
let _refreshGen = 0;

function genSerial() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

async function genEd25519() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { keypair: kp, publicKey: pub };
}

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

// ── Drafts UI ───────────────────────────────────────────────────────
function renderDraftList(drafts) {
  const list = $("cs-drafts");
  if (!list) return;
  if (drafts.length === 0) {
    list.innerHTML = '<p class="note">no saved drafts yet</p>';
    return;
  }
  list.innerHTML = drafts.map((d) => {
    // A "delivered" draft is a server whose recipe is out but which may
    // never have phoned home (a failed/abandoned install). Offer "Cancel
    // server", which frees the name so it can be re-used — see
    // cancelServer().
    const delivered = d.status === "delivered";
    const cancelBtn = delivered
      ? `<button class="secondary danger" data-action="cancel-server" data-id="${escapeHtml(d.id)}">Cancel server (free the name)</button>`
      : "";
    return `
    <div class="card">
      <div class="row">
        <span class="value"><strong>${escapeHtml(d.serverName || "(unnamed)")}</strong></span>
        <span class="pill ${delivered ? "ok" : ""}">${escapeHtml(d.status)}</span>
      </div>
      <div class="row">
        <span class="label">backup</span>
        <span class="value">${escapeHtml(d.backupPolicy)}</span>
      </div>
      <div class="row">
        <span class="label">updated</span>
        <span class="value">${escapeHtml(formatWhen(d.updatedAt))}</span>
      </div>
      <div class="row-2 mt-2">
        <button class="secondary" data-action="resume" data-id="${escapeHtml(d.id)}">Resume</button>
        <button class="secondary" data-action="delete" data-id="${escapeHtml(d.id)}">Delete</button>
      </div>
      ${cancelBtn ? `<div class="mt-2">${cancelBtn}</div>` : ""}
    </div>
  `;
  }).join("");
  list.querySelectorAll("button[data-action]").forEach((b) => {
    b.addEventListener("click", (e) => {
      const action = e.currentTarget.getAttribute("data-action");
      const id = e.currentTarget.getAttribute("data-id");
      if (action === "resume") resumeDraft(id).catch((err) => { console.error(err); toast(humanError(err), "err"); });
      else if (action === "cancel-server") {
        cancelServer(id).catch((err) => { console.error(err); toast(humanError(err), "err"); });
      } else if (action === "delete") {
        (async () => {
          const { inlineConfirm } = await import("../lib/modal.js");
          const ok = await inlineConfirm({
            title: "Delete this draft?",
            okLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
          deleteDraft(id).then(refreshDrafts).catch((err) => { console.error(err); toast(humanError(err), "err"); });
        })();
      }
    });
  });
}

/**
 * "Cancel the server" — release the name so it can be claimed again.
 *
 * Today an abandoned/failed install leaves the server name reserved: the
 * RCK routing record pins it and a retry hits "subdomain already
 * controlled by a different RCK". This IRK-signs a release envelope and
 * POSTs `/api/server/release`, which the Worker uses to drop the routing
 * record + revoke any active auth-codes + revoke the server record. Then
 * we revoke the install auth-code (belt-and-braces, in case the box is
 * mid-boot) and delete the local draft. Auth = the IRK signature (only
 * the owner can produce it).
 */
async function cancelServer(id) {
  const d = await getDraft(id);
  if (!d) return toast("Draft not found", "err");
  const session = getSession();
  // P14 Phase 2 — companion profiles route the cancel through the
  // owner; they don't need an unlocked session to QUEUE the request.
  // The companion-aware branch below detects {pending:true} and
  // surfaces the "Forwarded to owner" sheet.
  const { isCompanionProfile } = await import("../lib/companionGuard.js");
  const asCompanion = isCompanionProfile();
  if (!asCompanion && (!session.umk || !session.irk)) {
    return toast("Unlock the webapp first", "err");
  }
  const username = session.username
    || (await ensureUsername().catch(() => null));
  if (!username) return toast("No account on this device", "err");

  const { inlineConfirm } = await import("../lib/modal.js");
  const confirmed = await inlineConfirm({
    title: `Cancel server "${d.serverName}"?`,
    message: asCompanion
      ? "Companion sessions can't sign on their own — this will queue the request for the account owner to approve from their owner app."
      : "Frees the name so you can use it again. Any pending install recipe is voided; a box that boots later is rejected. If this server is already running, it will be released — do this only if you mean to give the name up.",
    okLabel: asCompanion ? "Forward to owner" : "Cancel server",
    danger: true,
  });
  if (!confirmed) return;

  const serverDomain = serverDomainOf(d.serverName, username);
  try {
    const out = await releaseServerName(
      // Slice D: release-server-name is a SENSITIVE order (admin root when present).
      { username, serverDomain, umk: session.umk, signWithIrk: sensitiveSigner() },
    );
    if (out && out.pending) {
      // Companion path — open the polling sheet until the owner resolves.
      const { showCompanionPendingSheet, outcomeToastCopy } = await import(
        "../lib/companionPendingSheet.js"
      );
      const result = await showCompanionPendingSheet(out);
      if (result.outcome === "approved") {
        if (d.code) await revokeAuthCodeBestEffort(d.code, username).catch(() => {});
        await deleteDraft(id);
        toast(`Server "${d.serverName}" cancelled — the name is free again`, "ok");
        await refreshDrafts();
        return;
      }
      const { text, kind } = outcomeToastCopy(result.outcome);
      toast(text, kind);
      return;
    }
    // Best-effort auth-code revoke too (the release already revokes
    // active codes server-side, but an in-flight serial we hold locally
    // is cheap to revoke explicitly). 404/403 == already gone.
    if (d.code) {
      await revokeAuthCodeBestEffort(d.code, username).catch(() => {});
    }
    await deleteDraft(id);
    toast(`Server "${d.serverName}" cancelled — the name is free again`, "ok");
    await refreshDrafts();
  } catch (e) {
    toast(`Cancel failed: ${e.message ?? e}`, "err");
  }
}

/** IRK-sign + POST an auth-code revoke. Tolerates 404/403 (already gone)
 *  so a double-cancel is safe. */
async function revokeAuthCodeBestEffort(serial, username) {
  const issuedAt = Date.now();
  const sig = await signWithIrk(
    getSession().umk,
    canonical(["flagship/auth-code-revoke/v1", serial, username, issuedAt]),
  );
  const resp = await fetch(
    `${controlApex()}/api/auth-code/${encodeURIComponent(serial)}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { serial, username, issuedAt },
        signature: bytesToHex(sig),
      }),
    },
  );
  if (!resp.ok && resp.status !== 404 && resp.status !== 403) {
    throw new Error(`HTTP ${resp.status}`);
  }
}

async function refreshDrafts() {
  const myGen = ++_refreshGen;
  try {
    const drafts = await listDrafts();
    if (myGen !== _refreshGen) return;
    renderDraftList(drafts);
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

async function resumeDraft(id) {
  const d = await getDraft(id);
  if (!d) return toast("Draft not found", "err");
  activeDraftId = id;
  $("cs-server-name").value = d.serverName || "";
  $("cs-backup-policy").value = d.backupPolicy || "phone-only";
  restoreDiskEncryption(d.diskEncryption);
  toast(`Resumed ${d.serverName}`);
}

function readInputs() {
  const serverName = $("cs-server-name").value.trim().toLowerCase();
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error("server name must be a DNS label: 1–63 lowercase letters or digits, hyphens allowed between characters (not at the start or end)");
  }
  if (RESERVED_SERVER_LABELS.has(serverName)) {
    throw new Error(`server name "${serverName}" is reserved`);
  }
  const backupPolicy = $("cs-backup-policy").value;
  // Recipe TTL in millis. Picker UI emits hours via #cs-ttl-hours;
  // absent input = default 6 hours.
  const ttlEl = $("cs-ttl-hours");
  const ttlHours = ttlEl ? parseFloat(ttlEl.value) : 6;
  const recipeTtlMs = clampRecipeTtlMs(Math.round(ttlHours * 60 * 60_000));
  // Boot-unlock mode (docs/security-phone-as-unlock-endpoint.md §7a.1).
  // A two-option choice carried in the SIGNED InstallBlob so a relay can't
  // downgrade an `approve` server to `auto`. Default `auto`.
  const bootUnlockMode = readBootUnlockMode();
  // Disk-encryption choice (auth.ts `de=` field). Carried in the SIGNED
  // InstallBlob so a relay can't downgrade an encrypted box to plaintext.
  // Default "luks" (encrypted); the user opts OUT explicitly.
  const diskEncryption = readDiskEncryption();
  // Secret-free recipe: embed-secrets is reachable ONLY under Advanced mode.
  // Default OFF ⇒ the recipe is secret-free of the SWK + the webapp deposits it
  // after the box registers. ON (advanced/offline) ⇒ embed `swkHex` in the recipe.
  const embedSecrets = readEmbedSecrets();
  // Debug-friendly server: an Advanced-only opt-in. When ON the minter signs an
  // owner-IRK `flagship/debug-access/v1` grant and embeds it as the recipe's
  // unsigned `debugGrant` sibling; the box-side gate verifies it under the
  // config-pinned owner IRK before enabling the console `debug` user. Default OFF
  // ⇒ no grant ⇒ a production image.
  const debugFriendly = readDebugFriendly();
  return { serverName, backupPolicy, recipeTtlMs, bootUnlockMode, diskEncryption, embedSecrets, debugFriendly };
}

// Read the embed-secrets choice. Only honored when Advanced mode is on; the
// checkbox lives inside the (hidden-by-default) advanced section. Absent control
// or Advanced off ⇒ false (the secret-free default). Exported for the unit test.
export function readEmbedSecrets() {
  const adv = $("cs-advanced");
  const embed = $("cs-embed-secrets");
  if (!adv || !adv.checked || !embed) return false;
  return !!embed.checked;
}

// Read the debug-friendly choice. Gated behind Advanced mode exactly like
// embed-secrets — absent control or Advanced off ⇒ false (production default).
// Exported for the unit test.
export function readDebugFriendly() {
  const adv = $("cs-advanced");
  const dbg = $("cs-debug-friendly");
  if (!adv || !adv.checked || !dbg) return false;
  return !!dbg.checked;
}

// Build the recipe's unsigned `debugGrant` sibling: an owner-IRK-signed
// `flagship/debug-access/v1` grant the box-side gate (server-daemon
// debugAccessGate.ts) verifies before enabling the console debug user. The
// signable scope is `serverDomain|sshAuthorizedKey|issuedAt` (sshAuthorizedKey
// "", issuedAt = now) — no box STK, so it's signable at mint time since the
// webapp already knows the box's FQDN. Returns the carrier JSON STRING
// `{grant,signatureHex}`, the SAME shape the iOS/Android minter + the box gate
// consume. `signWithIrk`/`umk` are injectable for the unit test (mirrors
// buildSwkDeliveryCarrier).
export async function buildDebugGrant({
  serverDomain,
  issuedAt = Date.now(),
  signWithIrk: signFn = signWithIrk,
  umk,
}) {
  const grant = { serverDomain, sshAuthorizedKey: "", issuedAt };
  const canonical = new TextEncoder().encode(
    ["flagship/debug-access/v1", grant.serverDomain, grant.sshAuthorizedKey, String(grant.issuedAt)].join("|"),
  );
  const sig = await signFn(umk, canonical);
  return JSON.stringify({ grant, signatureHex: bytesToHex(sig) });
}

// Read the disk-encryption choice from the "Encrypt disk" checkbox. The box
// is CHECKED (encrypted, "luks") by default; unchecked ⇒ "none". When the
// control is absent we fail safe to "luks". Exported for the unit test.
export function readDiskEncryption() {
  const el = $("cs-encrypt-disk");
  // A checkbox: `checked` true ⇒ encrypted. Absent control ⇒ default encrypted.
  if (!el) return "luks";
  return el.checked ? "luks" : "none";
}

// Read the selected boot-unlock mode from the radio group. Defaults to
// `auto` when the control is absent or none is checked.
function readBootUnlockMode() {
  const checked = document.querySelector('input[name="cs-boot-unlock"]:checked');
  return checked && checked.value === "approve" ? "approve" : "auto";
}

// Restore the "Encrypt disk" checkbox from a saved draft's diskEncryption
// value. "none" ⇒ unchecked (don't encrypt); everything else (or absent) ⇒
// checked (encrypted, the default).
function restoreDiskEncryption(diskEncryption) {
  const el = $("cs-encrypt-disk");
  if (!el) return;
  el.checked = diskEncryption !== "none";
}

// Recipe TTL bounds — single user-facing knob. 5 min floor, 24 hour
// ceiling. Mirrors the iOS/Android pickers byte-for-byte semantics.
export const DEFAULT_RECIPE_TTL_MS = 6 * 60 * 60_000;
export const MIN_RECIPE_TTL_MS = 5 * 60_000;
export const MAX_RECIPE_TTL_MS = 24 * 60 * 60_000;
export function clampRecipeTtlMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RECIPE_TTL_MS;
  return Math.min(Math.max(n, MIN_RECIPE_TTL_MS), MAX_RECIPE_TTL_MS);
}

/**
 * Wire the "Download recipe" button to emit a JSON file the Builder
 * CLI can consume verbatim. Schema matches `flagship-builder`'s
 * `loadBlobFromFile()` exactly:
 *
 *   {
 *     version: 2,
 *     serverDomain, username, serverName,
 *     phoneDelegatedPubKey, registrationUrl,
 *     authCode: { ..., issuedAt, expiresAt, ... },
 *     authCodeUserSignature,
 *     installerGitRef, rckPubKey,
 *     blobSignatureHex,
 *   }
 *
 * The bundle the webapp already produces (`onWireBlob`) is identical
 * to that shape; we just splat the signature into `blobSignatureHex`.
 */
function downloadRecipe(blobBundle) {
  const recipe = { ...blobBundle.blob, blobSignatureHex: blobBundle.blobSignature };
  // Secret-free pairing (offline/embed): carry the unsigned plaintext
  // `pairingOrder` sibling (the owner-IRK-signed `add-paired-session` order) into
  // the downloaded recipe so the builder writes it to the box's install-blob.json
  // and the daemon adds the session locally with NO `.com` call. Absent (the
  // default online path) ⇒ recipe is byte-identical + carries ZERO pairing secret.
  if (blobBundle.pairingOrder) recipe.pairingOrder = blobBundle.pairingOrder;
  // SWK provisioning: carry the unsigned `swkHex` sibling into the downloaded
  // recipe so the builder writes it to the box's install-blob.json (the daemon
  // persists it at first boot). Absent ⇒ recipe is byte-identical.
  if (blobBundle.swkHex) recipe.swkHex = blobBundle.swkHex;
  // Debug-friendly server: carry the unsigned `debugGrant` carrier (a JSON
  // string `{grant,signatureHex}`) into the downloaded recipe so the builder
  // writes it to install-blob.json and the box-side gate can verify it. Absent
  // (the production default) ⇒ recipe is byte-identical + carries no grant.
  if (blobBundle.debugGrant) recipe.debugGrant = blobBundle.debugGrant;
  const json = JSON.stringify(recipe, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date(recipe.authCode.expiresAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  a.download = `flagship-recipe-${recipe.serverDomain}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

async function handleSaveDraft() {
  try {
    const inputs = readInputs();
    const saved = await saveDraft({
      id: activeDraftId,
      ...inputs,
      status: "draft",
    });
    activeDraftId = saved.id;
    toast("Draft saved");
    await refreshDrafts();
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

async function handleRecipeDownload() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    return toast("Unlock the webapp first", "err");
  }
  let inputs;
  try { inputs = readInputs(); }
  catch (e) { console.error(e); return toast(humanError(e), "err"); }

  // Phase 2: the account is now opened FIRST (standalone username claim
  // + device bind), so by the time the user reaches "Add a server" the
  // username is already bound to this device's IRK. If the session
  // already carries a username, the claim has happened — skip it. Only a
  // legacy direct-to-create-server entry (no open-account step) still
  // claims here, and even that stays 409-tolerant (idempotent).
  const alreadyOpened = !!session.username;
  const username = await ensureUsername();

  const btn = $("cs-download-recipe");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating recipe…";
  }
  setStatus("active", "creating signed recipe…");
  let blobBundle;
  try {
    blobBundle = await mintInstallBlobBundle(session, username, inputs, { skipClaim: alreadyOpened });
  } catch (e) {
    setStatus("error", String(e.message || e));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create and download recipe";
    }
    return;
  }

  try {
    downloadRecipe(blobBundle);
    const saved = await saveDraft({
      id: activeDraftId,
      ...inputs,
      status: "delivered",
      deliveredAt: Date.now(),
      code: blobBundle.blob.authCode.serial,
    });
    activeDraftId = saved.id;
    await refreshDrafts();
    setStatus("done", "Recipe downloaded — open it in Flagship Studio.");
  } catch (e) {
    setStatus("error", String(e.message || e));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create and download recipe";
    }
  }
}

function setStatus(kind, text) {
  const el = $("cs-status");
  if (!el) return;
  el.classList.remove("ok", "err", "warn");
  if (kind === "done") el.classList.add("ok");
  else if (kind === "error") el.classList.add("err");
  else if (kind === "active") el.classList.add("warn");
  el.textContent = text;
}

// Exported so the GYM-ONLY `window.__gymCreate` seam can drive the same
// compose-and-sign path as the download action.
export async function mintInstallBlobBundle(session, username, inputs, opts = {}) {
  const { serverName, recipeTtlMs } = inputs;
  // §7a.1: only "approve" is carried on the wire; "auto" is the absent-field
  // default so legacy recipes stay byte-identical (see canonicalInstallBlob).
  const bootUnlockMode = inputs.bootUnlockMode === "approve" ? "approve" : "auto";
  const ttlMs = clampRecipeTtlMs(recipeTtlMs);
  const irkPubHex = bytesToHex(session.irk.publicKey);

  // Slice D (docs/device-admin-tier-spec.md §1.3 / §8.1) — ensure this device
  // holds the account's admin master root (idempotent; mints one only if
  // absent, e.g. a legacy direct-entry create that skipped open-account). Its
  // pubkey is published with the claim AND pinned INSIDE the recipe AuthCode so
  // the fresh box pins it. Best-effort: a mint failure leaves adminRootPubHex
  // null → a legacy no-admin-root recipe (byte-identical to pre-D).
  let adminRootPubHex = null;
  try {
    adminRootPubHex = await ensureAdminRoot(session);
  } catch {
    adminRootPubHex = null;
  }

  // 1. Claim username (idempotent) — Phase 2: SKIPPED when the account
  // was already opened (the standalone claim ran at open-account time).
  // Account identity is decoupled from server provisioning: a server is
  // a separate, later, repeatable resource that re-uses the
  // already-claimed username. The fallback claim (legacy direct entry)
  // stays 409-tolerant.
  if (!opts.skipClaim) {
    const claimIssuedAt = Date.now();
    const claimMsg = canonical([TAG_CLAIM, username, irkPubHex, claimIssuedAt]);
    const claimSig = await signWithIrk(session.umk, claimMsg);
    // Absolute control-plane URL — a relative POST hits the webapp origin
    // (web.<apex>, GET/HEAD-only assets) and 405s. Matches the sibling
    // controlApex() calls in this file (auth-code revoke, registrationUrl).
    const claimResp = await fetch(`${controlApex()}/api/username/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { username, irkPub: irkPubHex, issuedAt: claimIssuedAt },
        signature: bytesToHex(claimSig),
        ...(adminRootPubHex ? { adminRootPub: adminRootPubHex } : {}),
      }),
    });
    if (!claimResp.ok && claimResp.status !== 409) {
      throw new Error(`claim failed (${claimResp.status}): ${await claimResp.text()}`);
    }
  }

  const delegated = await genEd25519();
  const acIssuedAt = Date.now();
  const acExpiresAt = acIssuedAt + ttlMs;
  const code = {
    version: 1,
    serial: genSerial(),
    username,
    serverName,
    serverDomain: serverFqdn(serverName, username),
    delegatedPubKey: delegated.publicKey,
    userPubKey: session.irk.publicKey,
    issuedAt: acIssuedAt,
    expiresAt: acExpiresAt,
  };
  // Slice D — pin the admin master root INSIDE the AuthCode (decision D-1). It
  // is appended as a signature-covered `ar=<hex>` field, byte-identical to
  // @flagship/protocol canonicalAuthCode: an AuthCode WITHOUT it canonicalises
  // exactly as before, so legacy (no-admin-root) recipes are unchanged. The IRK
  // still signs the AuthCode (membership); the admin root only RIDES it, so a
  // compromised network/.com cannot swap the box's admin anchor in transit.
  const acParts = [
    TAG_AUTH_CODE, code.version, code.serial, code.username, code.serverName,
    code.serverDomain, bytesToHex(code.delegatedPubKey), bytesToHex(code.userPubKey),
    code.issuedAt, code.expiresAt,
  ];
  if (adminRootPubHex) acParts.push(`ar=${adminRootPubHex}`);
  const acMsg = canonical(acParts);
  const acSig = await signWithIrk(session.umk, acMsg);
  // Absolute control-plane URL — a relative POST hits the webapp origin
  // (web.<apex>, GET/HEAD-only assets) and 405s. Matches the claim call above
  // and the sibling controlApex() calls in this file.
  const issueResp = await fetch(`${controlApex()}/api/auth-code/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: {
        version: code.version, serial: code.serial, username: code.username,
        serverName: code.serverName, serverDomain: code.serverDomain,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
        issuedAt: code.issuedAt, expiresAt: code.expiresAt,
        ...(adminRootPubHex ? { adminRootPubKey: adminRootPubHex } : {}),
      },
      signature: bytesToHex(acSig),
    }),
  });
  if (!issueResp.ok) throw new Error(`auth-code/issue failed (${issueResp.status})`);

  const rck = await genEd25519();
  const rckRegIssuedAt = Date.now();
  const rckRegMsg = canonical([
    TAG_RCK_REGISTER, username, code.serverDomain, bytesToHex(rck.publicKey), rckRegIssuedAt,
  ]);
  const rckRegSig = await sensitiveSigner()(session.umk, rckRegMsg);
  // Absolute control-plane URL — same reason as the auth-code/issue call above:
  // a relative POST hits the GET/HEAD-only webapp origin and 405s.
  const rckResp = await fetch(`${controlApex()}/api/routing/register-rck`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, subdomain: code.serverDomain, rckPubKey: bytesToHex(rck.publicKey), issuedAt: rckRegIssuedAt },
      signature: bytesToHex(rckRegSig),
    }),
  });
  if (!rckResp.ok) throw new Error(`RCK register failed (${rckResp.status})`);

  // v2: blob.issuedAt + blob.expiresAt dropped. The authCode's own
  // expiresAt is the sole TTL on the recipe (gated by .com at
  // /api/server/register).
  const blob = {
    version: 2,
    serverDomain: code.serverDomain,
    username,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: `${controlApex()}/api/server/register`,
    authCode: code,
    authCodeUserSignature: acSig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
  };
  // §7a.1: carry the field ONLY for "approve". "auto" is the absent-field
  // default, so an auto recipe signs/serialises byte-identically to a legacy
  // pre-bootUnlockMode recipe (and old verifiers keep accepting it).
  if (bootUnlockMode === "approve") blob.bootUnlockMode = "approve";
  // Disk-encryption: carry the field ONLY for "none". "luks" is the
  // absent-field default, so an encrypted recipe signs/serialises
  // byte-identically to a legacy pre-diskEncryption recipe (old verifiers
  // keep accepting it). Appended LAST in canonicalInstallBlob as `de=none`.
  if (inputs.diskEncryption === "none") blob.diskEncryption = "none";
  const blobBytes = canonicalInstallBlob(blob);
  const blobSig = await signWithIrk(session.umk, blobBytes);

  const onWireBlob = {
    version: blob.version,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: code.version, serial: code.serial, username: code.username,
      serverName: code.serverName, serverDomain: code.serverDomain,
      delegatedPubKey: bytesToHex(code.delegatedPubKey),
      userPubKey: bytesToHex(code.userPubKey),
      issuedAt: code.issuedAt, expiresAt: code.expiresAt,
      // Slice D — carry the pinned admin root in the downloaded recipe so the
      // builder writes it to the box's install-blob (box pins it as
      // ServerConfig.adminRootPub). Present iff the account has an admin root;
      // covered by authCodeUserSignature via the `ar=` canonical field above.
      ...(adminRootPubHex ? { adminRootPubKey: adminRootPubHex } : {}),
    },
    authCodeUserSignature: bytesToHex(acSig),
    installerGitRef: blob.installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
  };
  // Mirror the conditional from the canonical blob: present iff "approve",
  // so the downloaded recipe JSON carries exactly what was signed.
  if (blob.bootUnlockMode !== undefined) onWireBlob.bootUnlockMode = blob.bootUnlockMode;
  // Mirror the conditional from the canonical blob: present iff "none", so the
  // downloaded recipe JSON carries exactly what was signed (the builder round-
  // trips it and re-derives the same `de=none` token for box verification).
  if (blob.diskEncryption !== undefined) onWireBlob.diskEncryption = blob.diskEncryption;

  // Secret-free pairing: build the owner-IRK-signed `add-paired-session` order
  // at create time (the FIRST recipe carries ZERO pairing secret — no pairing
  // keypair, no `pairingKeyPrivHex`). Persist its token as this device's session
  // token so the BFF auths once the box claims the order. Best-effort: a failure
  // leaves the manual pairing path as the fallback and NEVER blocks creation.
  let pairingOrderJson;
  try {
    const pairing = await buildPairingOrder({ serverDomain: blob.serverDomain });
    setSessionToken(pairing.token);
    pairingOrderJson = pairing.pairingOrderJson;
  } catch (e) {
    console.warn("create-time pairing order build failed (non-fatal):", e);
  }

  const bundle = { blob: onWireBlob, blobSignature: bytesToHex(blobSig) };
  // SWK + pairing provisioning (secret-free recipe, docs/recipe-delivery-and-remote-install.md).
  //   embed-secrets ON (advanced/offline): bake BOTH the box's deterministic SWK
  //     and the plaintext `pairingOrder` into the recipe as UNSIGNED siblings;
  //     the box self-configures + self-pairs fully offline, NO `.com` deposit.
  //   embed-secrets OFF (the DEFAULT): the recipe stays secret-free; stash the
  //     SWK + the pairing order so the Home reconcile seals + deposits each once
  //     the box registers (one delivery then, not now).
  if (inputs.embedSecrets) {
    bundle.swkHex = await deriveSwkFromSeed(session.umk, blob.serverDomain);
    clearSwkDeposit(blob.serverDomain);
    if (pairingOrderJson) bundle.pairingOrder = pairingOrderJson;
    clearPairingDeposit(blob.serverDomain);
  } else {
    markSwkDepositPending(blob.serverDomain);
    if (pairingOrderJson) markPairingDepositPending(blob.serverDomain, pairingOrderJson);
  }
  // Debug-friendly server (Advanced opt-in): sign + embed the owner-IRK
  // debug-access grant as the recipe's unsigned `debugGrant` sibling. Absent
  // (the production default) ⇒ the recipe carries no grant ⇒ the box stays a
  // production image. The grant is consent-as-crypto: the box only enables the
  // console debug user if this verifies under its config-pinned owner IRK.
  if (inputs.debugFriendly) {
    bundle.debugGrant = await buildDebugGrant({
      serverDomain: blob.serverDomain,
      signWithIrk,
      umk: session.umk,
    });
  }
  return bundle;
}

/** Live inline validation for the server-name field — mirrors the
 *  authoritative server-side rule (validateServerLabel). Shows the same
 *  message the throw in readInputs() would, so the user fixes it before
 *  delivering. */
function wireServerNameValidation() {
  const input = $("cs-server-name");
  const err = $("cs-server-name-error");
  if (!input || !err) return;
  const update = () => {
    const v = input.value.trim().toLowerCase();
    let msg = "";
    if (v.length > 0) {
      if (!SERVER_NAME_RE.test(v)) {
        msg = "lowercase letters, digits, and hyphens (not at the start or end)";
      } else if (RESERVED_SERVER_LABELS.has(v)) {
        msg = `"${v}" is reserved — pick another name`;
      }
    }
    err.textContent = msg;
    err.classList.toggle("hidden", msg === "");
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  };
  input.addEventListener("input", update);
  input.addEventListener("blur", update);
}

// Show/hide the Advanced-mode sub-options + reset embed-secrets when Advanced
// is turned off (so toggling it off can never leave a secret-embedding choice).
function syncAdvancedVisibility() {
  const adv = $("cs-advanced");
  const opts = $("cs-advanced-options");
  if (!adv || !opts) return;
  if (adv.checked) {
    opts.classList.remove("hidden");
  } else {
    opts.classList.add("hidden");
    const embed = $("cs-embed-secrets");
    if (embed) embed.checked = false;
    const dbg = $("cs-debug-friendly");
    if (dbg) dbg.checked = false;
  }
}

export function initCreateServerView() {
  wireServerNameValidation();
  $("cs-advanced")?.addEventListener("change", syncAdvancedVisibility);
  syncAdvancedVisibility();
  $("cs-save-draft")?.addEventListener("click", () => handleSaveDraft());
  $("cs-download-recipe")?.addEventListener("click", () => handleRecipeDownload().catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  $("cs-new")?.addEventListener("click", () => {
    activeDraftId = null;
    $("cs-server-name").value = "";
    $("cs-backup-policy").value = "phone-only";
    $("cs-llm-pref").value = "";
    restoreDiskEncryption(null);
    setStatus("idle", "idle");
  });
  $("create-server-back")?.addEventListener("click", () => {
    show("view-home");
  });
}

export async function enterCreateServer() {
  show("view-create-server");
  await refreshDrafts();
}
