// Client-side draft composer for a new server. The webapp signs the recipe
// locally, downloads it, and the user opens that file in Flagship Studio.

import { $, registerView, show } from "../lib/router.js";
import { boxErrorText, humanError } from "../lib/humanError.js";
import { getSession, ensureUsername } from "../lib/state.js";
import {
  bytesToHex,
  hexToBytes,
  signWithIrk,
  deriveSwkFromSeed,
  adminRootPubHex as ksAdminRootPubHex,
  signWithAdminRoot as ksSignWithAdminRoot,
} from "../keystore.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { DEBUG_ACCESS_MAX_MS, buildDebugAccessGrant, normalizeSshPublicKey } from "../lib/debugAccess.js";
import { canAddServers, recipeAdminRootPin, refuseAddServer, throwIfAddServerRefused } from "../lib/addServerGate.js";
import { getActiveProfile } from "../lib/profiles.js";
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
import { clearPendingRck, reuseOrRecordRck } from "../lib/pendingRck.js";
import { markPairingDepositPending, clearPairingDeposit } from "../lib/pairingDeposit.js";
import { setSessionToken, setSessionTokenForPod } from "../lib/api.js";
import { attachRestoreOrder } from "../lib/serverBackupFormat.js";
import { DEFAULT_WEB_RESERVE_GB, attachBackupPolicy, policyFromDraft } from "../lib/backupPolicy.js";
import { throwIfRateLimited } from "../lib/rateLimited.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { enterPendingServer, rememberPendingOrder } from "./pending-server.js";

import { tr } from "../lib/i18n.js";
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
  // Gossip fan-out reserved names — kept in sync with the authoritative
  // control-plane list (packages/control-plane/src/labels.ts). These were
  // missing here, so a box could shadow broadcast--<user> routing.
  "broadcast", "servers", "all",
]);
/** True iff `name` is a syntactically valid, non-reserved server name. */
export function isValidServerName(name) {
  return typeof name === "string"
    && SERVER_NAME_RE.test(name)
    && !RESERVED_SERVER_LABELS.has(name);
}
const TAG_CLAIM = "flagship/claim-username/v1";
const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_AUTH_CODE_ADMIN = "flagship/auth-code-admin/v1";
const TAG_RCK_REGISTER = "flagship/rck-register/v1";

// The browser's words for each backup policy (the wire values stay).
const BACKUP_POLICY_LABELS = Object.freeze({
  "phone-only": tr("On my devices"),
  none: tr("No backup"),
  peer: tr("On other servers"),
});

let activeDraftId = null;
let _refreshGen = 0;
let creating = false;

function genSerial() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

async function genEd25519() {
  const kp = await crypto.subtle.generateKey({ name: tr("Ed25519") }, true, ["sign", "verify"]);
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
    list.innerHTML = `<p class="note">${tr("no saved drafts yet")}</p>`;
    return;
  }
  list.innerHTML = drafts.map((d) => {
    // A "delivered" draft is a server whose recipe is out but which may
    // never have phoned home (a failed/abandoned install). Offer "Cancel
    // server", which frees the name so it can be re-used — see
    // cancelServer().
    const delivered = d.status === "delivered";
    const cancelBtn = delivered
      ? `<button class="secondary danger" data-action="cancel-server" data-id="${escapeHtml(d.id)}">${tr("Cancel server (free the name)")}</button>`
      : "";
    return `
    <div class="card">
      <div class="row">
        <span class="value"><strong>${escapeHtml(d.serverName || "(unnamed)")}</strong></span>
        <span class="pill ${delivered ? "ok" : ""}">${escapeHtml(d.status)}</span>
      </div>
      <div class="row">
        <span class="label">${tr("backup")}</span>
        <span class="value">${escapeHtml(BACKUP_POLICY_LABELS[d.backupPolicy] ?? d.backupPolicy ?? tr("not chosen yet"))}</span>
      </div>
      <div class="row">
        <span class="label">${tr("updated")}</span>
        <span class="value">${escapeHtml(formatWhen(d.updatedAt))}</span>
      </div>
      <div class="row-2 mt-2">
        <button class="secondary" data-action="resume" data-id="${escapeHtml(d.id)}">${tr("Resume")}</button>
        <button class="secondary" data-action="delete" data-id="${escapeHtml(d.id)}">${tr("Delete")}</button>
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
            title: tr("Delete this draft?"),
            okLabel: tr("Delete"),
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
  if (!d) return toast(tr("Draft not found"), "err");
  const session = getSession();
  // P14 Phase 2 — companion profiles route the cancel through the
  // owner; they don't need an unlocked session to QUEUE the request.
  // The companion-aware branch below detects {pending:true} and
  // surfaces the "Forwarded to owner" sheet.
  const { isCompanionProfile } = await import("../lib/companionGuard.js");
  const asCompanion = isCompanionProfile();
  if (!asCompanion && (!session.umk || !session.irk)) {
    return toast(tr("Unlock the webapp first"), "err");
  }
  const username = session.username
    || (await ensureUsername().catch(() => null));
  if (!username) return toast(tr("No account on this device"), "err");

  const { inlineConfirm } = await import("../lib/modal.js");
  const confirmed = await inlineConfirm({
    title: tr("Cancel server \"{0}\"?", d.serverName),
    message: asCompanion
      ? tr("Companion sessions can't sign on their own — this will queue the request for the account owner to approve from their owner app.")
      : tr("Frees the name so you can use it again. Any pending install recipe is voided; a box that boots later is rejected. If this server is already running, it will be released — do this only if you mean to give the name up."),
    okLabel: asCompanion ? tr("Forward to owner") : tr("Cancel server"),
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
        clearPendingRck(serverDomain);
        toast(tr("Server \"{0}\" cancelled — the name is free again", d.serverName), "ok");
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
    clearPendingRck(serverDomain);
    toast(tr("Server \"{0}\" cancelled — the name is free again", d.serverName), "ok");
    await refreshDrafts();
  } catch (e) {
    // The name stays reserved and the draft stays, so the button still retries.
    console.error("cancel server failed", e);
    toast(tr("Couldn't cancel — the name is still reserved. {0}", boxErrorText(e)), "err");
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
  if (!d) return toast(tr("Draft not found"), "err");
  activeDraftId = id;
  $("cs-server-name").value = d.serverName || "";
  setBackupPolicyChoice(d.backupPolicy);
  if (d.reserveGb) $("cs-reserve-gb").value = String(d.reserveGb);
  restoreDiskEncryption(d.diskEncryption);
  toast(tr("Resumed {0}", d.serverName));
}

function readInputs({ draft = false } = {}) {
  const serverName = $("cs-server-name").value.trim().toLowerCase();
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error("server name must be a DNS label: 1–63 lowercase letters or digits, hyphens allowed between characters (not at the start or end)");
  }
  if (RESERVED_SERVER_LABELS.has(serverName)) {
    throw new Error(`server name "${serverName}" is reserved`);
  }
  const backupPolicy = readBackupPolicyChoice();
  if (!backupPolicy && !draft) throw new Error(tr("Choose where this server's backups go."));
  const reserveGb = readReserveGb();
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
  // admin-root `flagship/debug-access/v2` grant for the pasted SSH key (7 days)
  // and embeds it as the recipe's unsigned `debugGrant` sibling; the box lets
  // that key in as `debug` only after verifying it. Default OFF ⇒ no grant ⇒ a
  // production image. A missing or unusable key is refused here, before
  // anything is minted.
  const debugFriendly = readDebugFriendly();
  const debugSshKey = debugFriendly ? readDebugSshKey() : "";
  return { serverName, backupPolicy, reserveGb, recipeTtlMs, bootUnlockMode, diskEncryption, embedSecrets, debugFriendly, debugSshKey };
}

// The pasted SSH public key for a debug-friendly server, normalized; throws
// the sentence to show when it's missing or isn't one. Exported for the test.
export function readDebugSshKey() {
  const raw = String($("cs-debug-ssh-key")?.value ?? "").trim();
  if (!raw) throw new Error(tr("Debug access needs an SSH public key."));
  const key = normalizeSshPublicKey(raw);
  if (!key) throw new Error(tr("That isn't an SSH public key this server can use."));
  return key;
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

// Build the recipe's unsigned `debugGrant` sibling: a `flagship/debug-access/v2`
// grant for one SSH key, ending 7 days after it is signed (the box reads it at
// first boot and lets the key in until then). Signed with the sensitive-order
// key (the admin root; the IRK only on an account without one). Returns the
// carrier JSON STRING `{grant,signatureHex}`, the same shape iOS/Android mint
// and the box consumes. `sign`/`umk` are injectable for the unit test.
export async function buildDebugGrant({
  serverDomain,
  sshPublicKey,
  issuedAt = Date.now(),
  sign = sensitiveSigner(),
  umk,
}) {
  const carrier = await buildDebugAccessGrant(
    { serverDomain, sshPublicKey, durationMs: DEBUG_ACCESS_MAX_MS },
    { now: () => issuedAt, sign, umk },
  );
  return JSON.stringify(carrier);
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

// The backup policy radios (draft values "phone-only" | "peer" | "none") and
// the phone reserve shown only for phone-side backups.
// Nothing is preselected: the owner picks, and creating stays off until then.
function readBackupPolicyChoice() {
  const checked = document.querySelector('input[name="cs-backup-policy"]:checked');
  return checked ? checked.value : null;
}
function setBackupPolicyChoice(v) {
  // A saved "peer" draft is dropped: backups on other servers aren't offered yet (lib/backupPolicy.js).
  const want = v === "none" || v === "phone-only" ? v : null;
  for (const el of document.querySelectorAll('input[name="cs-backup-policy"]')) el.checked = el.value === want;
  syncReserveVisibility();
}
function syncReserveVisibility() {
  const choice = readBackupPolicyChoice();
  $("cs-reserve-row")?.classList.toggle("hidden", choice !== "phone-only");
  syncCreateEnabled();
}
function syncCreateEnabled() {
  const btn = $("cs-download-recipe");
  if (btn && !creating) btn.disabled = readBackupPolicyChoice() === null;
}
function readReserveGb() {
  const n = Math.round(Number($("cs-reserve-gb")?.value));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_WEB_RESERVE_GB;
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
export function downloadRecipe(blobBundle) {
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
    const inputs = readInputs({ draft: true });
    const saved = await saveDraft({
      id: activeDraftId,
      ...inputs,
      status: "draft",
    });
    activeDraftId = saved.id;
    toast(tr("Draft saved"));
    await refreshDrafts();
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

async function handleRecipeDownload() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    return toast(tr("Unlock the webapp first"), "err");
  }
  let inputs;
  try { inputs = readInputs(); }
  catch (e) { console.error(e); return toast(humanError(e), "err"); }
  // A debug grant takes one fresh unlock, like the server page's Turn on.
  if (inputs.debugFriendly) {
    const unlocked = await confirmFreshUnlock({
      title: tr("Make a debug-friendly server?"),
      message: tr("Anyone with this key can read everything on this server while it's on. It turns off by itself 7 days from now."),
      okLabel: tr("Create recipe"),
    });
    if (!unlocked.ok) return unlocked.cancelled ? undefined : toast(unlocked.error, "err");
  }

  // Phase 2: the account is now opened FIRST (standalone username claim
  // + device bind), so by the time the user reaches "Add a server" the
  // username is already bound to this device's IRK. If the session
  // already carries a username, the claim has happened — skip it. Only a
  // legacy direct-to-create-server entry (no open-account step) still
  // claims here, and even that stays 409-tolerant (idempotent).
  const alreadyOpened = !!session.username;
  const username = await ensureUsername();

  const btn = $("cs-download-recipe");
  creating = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr("Creating recipe…");
  }
  setStatus("active", tr("creating signed recipe…"));
  let blobBundle;
  try {
    blobBundle = await mintInstallBlobBundle(session, username, inputs, { skipClaim: alreadyOpened });
  } catch (e) {
    setStatus("error", String(e.message || e));
    creating = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("Create and download recipe");
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
    setStatus("done", tr("Recipe downloaded — open it in Flagship Studio."));
    followSetupOf({ serial: blobBundle.blob.authCode.serial, fqdn: blobBundle.blob.serverDomain, name: inputs.serverName });
  } catch (e) {
    setStatus("error", String(e.message || e));
  } finally {
    creating = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("Create and download recipe");
    }
  }
}

/** The recipe is out: keep its serial for the pending view and offer to
 *  follow the new server's setup there. */
let followOrder = null;
function followSetupOf(order) {
  rememberPendingOrder(order);
  followOrder = order;
  $("cs-follow-setup")?.classList.remove("hidden");
}

function hideFollowSetup() {
  followOrder = null;
  $("cs-follow-setup")?.classList.add("hidden");
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

/** The AuthCode's canonical bytes (byte-identical to @flagship/protocol
 *  canonicalAuthCode; `ar=<root>` appended when the code pins one). */
export function authCodeCanonicalBytes(code, adminRootPubHex) {
  const parts = [
    TAG_AUTH_CODE, code.version, code.serial, code.username, code.serverName,
    code.serverDomain, bytesToHex(code.delegatedPubKey), bytesToHex(code.userPubKey),
    code.issuedAt, code.expiresAt,
  ];
  if (adminRootPubHex) parts.push(`ar=${adminRootPubHex}`);
  return canonical(parts);
}

/** What the admin root signs to approve a new server:
 *  `flagship/auth-code-admin/v1|<the AuthCode's canonical bytes>`, which
 *  commit to the root the box will pin. A code with no root has no admin
 *  form. Pinned by packages/protocol/test-vectors/add-server/vectors.json. */
export function authCodeAdminCanonicalBytes(code, adminRootPubHex) {
  if (!/^[0-9a-f]{64}$/.test(String(adminRootPubHex ?? ""))) {
    throw new Error("auth-code admin approval needs the AuthCode's admin root");
  }
  const inner = new TextDecoder().decode(authCodeCanonicalBytes(code, adminRootPubHex));
  return new TextEncoder().encode(`${TAG_AUTH_CODE_ADMIN}|${inner}`);
}

export async function mintInstallBlobBundle(session, username, inputs, opts = {}) {
  const { serverName, recipeTtlMs } = inputs;
  // §7a.1: only "approve" is carried on the wire; "auto" is the absent-field
  // default so legacy recipes stay byte-identical (see canonicalInstallBlob).
  const bootUnlockMode = inputs.bootUnlockMode === "approve" ? "approve" : "auto";
  const ttlMs = clampRecipeTtlMs(recipeTtlMs);
  const irkPubHex = bytesToHex(session.irk.publicKey);

  // Slice D (docs/device-admin-tier-spec.md §1.3 / §8.1) — pin the account's
  // admin master root INSIDE the recipe AuthCode so the fresh box anchors it.
  // Only an admin device adds servers, and only opening the account mints an
  // admin root (lib/openAccount.js): a device without one is refused here,
  // before any `.com` call, never handed a stray root the account's admins
  // don't hold. A demo account pins none.
  const adminRootPubHex = await recipeAdminRootPin(session, {
    isDemo: opts.isDemo ?? !!getActiveProfile()?.demoServer,
    pubHexOf: opts.adminRootPubHexOf ?? ksAdminRootPubHex,
  });

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
      await throwIfRateLimited(claimResp);
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
  const acMsg = authCodeCanonicalBytes(code, adminRootPubHex);
  const acSig = await signWithIrk(session.umk, acMsg);
  // Adding a server is admin-only, and `.com` checks it: the admin root
  // approves this AuthCode. A demo account pins none and signs nothing.
  const acAdminSig = adminRootPubHex
    ? await (opts.signWithAdminRoot ?? ksSignWithAdminRoot)(
      session.adminRootSeed,
      authCodeAdminCanonicalBytes(code, adminRootPubHex),
    )
    : null;
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
      ...(acAdminSig ? { adminSignature: bytesToHex(acAdminSig) } : {}),
    }),
  });
  if (!issueResp.ok) {
    await throwIfAddServerRefused(issueResp);
    await throwIfRateLimited(issueResp);
    throw new Error(`auth-code/issue failed (${issueResp.status})`);
  }

  // The browser keeps no RCK secret, only the public key `.com` pins. A pending
  // order for this name keeps its key, so a retry registers the same claim
  // instead of a second one `.com` refuses.
  const rckPubHex = reuseOrRecordRck(code.serverDomain, bytesToHex((await genEd25519()).publicKey));
  const rckRegIssuedAt = Date.now();
  const rckRegMsg = canonical([
    TAG_RCK_REGISTER, username, code.serverDomain, rckPubHex, rckRegIssuedAt,
  ]);
  const rckRegSig = await sensitiveSigner()(session.umk, rckRegMsg);
  // Absolute control-plane URL — same reason as the auth-code/issue call above:
  // a relative POST hits the GET/HEAD-only webapp origin and 405s.
  const rckResp = await fetch(`${controlApex()}/api/routing/register-rck`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, subdomain: code.serverDomain, rckPubKey: rckPubHex, issuedAt: rckRegIssuedAt },
      signature: bytesToHex(rckRegSig),
    }),
  });
  if (!rckResp.ok) {
    await throwIfAddServerRefused(rckResp);
    throw new Error(tr("RCK register failed ({0})", rckResp.status));
  }

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
    rckPubKey: hexToBytes(rckPubHex),
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
    setSessionTokenForPod(blob.serverDomain, pairing.token);
    pairingOrderJson = pairing.pairingOrderJson;
  } catch (e) {
    if (inputs.restore) throw e;
    console.warn("create-time pairing order build failed (non-fatal):", e);
  }
  // A server made to restore a backup (docs/server-backup-and-clone.md): the
  // owner-signed restore order rides beside the pairing order, so the box
  // waits for exactly that backup from the moment it is paired.
  if (inputs.restore && pairingOrderJson) {
    pairingOrderJson = await attachRestoreOrder(pairingOrderJson, {
      serverDomain: blob.serverDomain,
      archiveId: inputs.restore.archiveId,
      bytes: inputs.restore.bytes,
      sha256: inputs.restore.sha256,
      // An admin-pinned box takes a restore order only from the admin root.
      sign: (bytes) => sensitiveSigner()(session.umk, bytes),
    });
  }

  // The backup policy the owner picked rides beside the pairing order, signed
  // (docs/server-backup-and-clone.md, "Backup policy"): the box takes it when
  // the pairing order verifies and enforces its size limit from then on.
  if (pairingOrderJson) {
    try {
      pairingOrderJson = await attachBackupPolicy(pairingOrderJson, {
        serverDomain: blob.serverDomain,
        policy: policyFromDraft(inputs.backupPolicy),
        reserveGb: inputs.reserveGb,
        sign: (bytes) => sensitiveSigner()(session.umk, bytes),
      });
    } catch (e) {
      console.warn("backup policy not attached (the server page will ask):", e);
    }
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
  // Debug-friendly server (Advanced opt-in): sign + embed the admin-root
  // debug-access grant for the pasted key as the recipe's unsigned `debugGrant`
  // sibling. Absent (the production default) ⇒ the recipe carries no grant ⇒
  // the box stays a production image. Consent-as-crypto: the box lets the key
  // in only if this verifies under its pinned admin root.
  if (inputs.debugFriendly) {
    bundle.debugGrant = await buildDebugGrant({
      serverDomain: blob.serverDomain,
      sshPublicKey: inputs.debugSshKey,
      umk: session.umk,
    });
  }
  return bundle;
}

/**
 * Make a server from a backup's saved settings: the same signed recipe, the
 * same deliverable (the recipe file for Flagship Studio), plus the restore
 * order. Resolves to the new server's domain.
 */
export async function createServerForRestore({ serverName, bootUnlockMode, diskEncryption, restore }) {
  const session = getSession();
  if (!session.umk || !session.irk) throw new Error(tr("Unlock the webapp first"));
  if (!isValidServerName(serverName)) throw new Error(tr("That name can't be used for a server."));
  const username = await ensureUsername();
  const inputs = {
    serverName,
    backupPolicy: "phone-only",
    // Room for the restored apps under the phone-side limit, with space to grow.
    reserveGb: Math.max(DEFAULT_WEB_RESERVE_GB, Math.ceil(((restore?.bytes ?? 0) * 2) / 1024 ** 3)),
    recipeTtlMs: DEFAULT_RECIPE_TTL_MS,
    bootUnlockMode,
    diskEncryption,
    embedSecrets: false,
    debugFriendly: false,
    restore,
  };
  const bundle = await mintInstallBlobBundle(session, username, inputs, { skipClaim: !!session.username });
  downloadRecipe(bundle);
  const { restore: _restore, ...draft } = inputs;
  await saveDraft({ ...draft, status: "delivered", deliveredAt: Date.now(), code: bundle.blob.authCode.serial }).catch(() => {});
  rememberPendingOrder({ serial: bundle.blob.authCode.serial, fqdn: bundle.blob.serverDomain, name: serverName });
  return { serverDomain: bundle.blob.serverDomain, serial: bundle.blob.authCode.serial };
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
        msg = tr("lowercase letters, digits, and hyphens (not at the start or end)");
      } else if (RESERVED_SERVER_LABELS.has(v)) {
        msg = tr("\"{0}\" is reserved — pick another name", v);
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
  syncDebugKeyVisibility();
}

// The SSH key field shows only while "Debug-friendly server" is on.
function syncDebugKeyVisibility() {
  const row = $("cs-debug-key-row");
  if (!row) return;
  row.classList.toggle("hidden", !$("cs-debug-friendly")?.checked);
}

export function initCreateServerView() {
  wireServerNameValidation();
  $("cs-debug-friendly")?.addEventListener("change", syncDebugKeyVisibility);
  $("cs-advanced")?.addEventListener("change", syncAdvancedVisibility);
  syncAdvancedVisibility();
  for (const el of document.querySelectorAll('input[name="cs-backup-policy"]')) el.addEventListener("change", syncReserveVisibility);
  syncReserveVisibility();
  $("cs-save-draft")?.addEventListener("click", () => handleSaveDraft());
  $("cs-download-recipe")?.addEventListener("click", () => handleRecipeDownload().catch((e) => { console.error(e); toast(humanError(e), "err"); }));
  $("cs-follow-setup")?.addEventListener("click", () => {
    if (followOrder) enterPendingServer(followOrder);
  });
  $("cs-new")?.addEventListener("click", () => {
    hideFollowSetup();
    activeDraftId = null;
    $("cs-server-name").value = "";
    setBackupPolicyChoice(null);
    restoreDiskEncryption(null);
    setStatus("idle", "idle");
  });
  $("create-server-back")?.addEventListener("click", () => {
    show("view-home");
  });
}

export async function enterCreateServer() {
  if (!canAddServers()) return refuseAddServer();
  hideFollowSetup();
  show("view-create-server");
  await refreshDrafts();
}
