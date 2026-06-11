// Phone-side draft composer for a new server — v2 relay protocol.
//
// Replaces v1's POST-mint + sealed-box flow with the new client-derived
// sid + X25519 ECDH + SAS protocol described in:
//   memory/project_qr_relay_protocol_v2.md
//
// Two-step delivery:
//   1. The user pastes (or scans) the QR URL shown on the homepage:
//        https://flagshipserver.com/qr?s=<sid>&k=<browserPk-base64url>
//      We parse out (sid, pk_b).
//   2. The webapp signs the canonical InstallBlob with the device IRK,
//      generates an ephemeral X25519 keypair, derives the shared secret
//      and the 6-digit match code locally, and opens a WS as role=phone.
//   3. We send {kind:"hello", phonePk} → relay forwards to the browser,
//      which derives the same match code and displays it. The user
//      glances between the two screens. **A 600 ms gate** delays the
//      Confirm button so reflexive double-taps don't bypass the check.
//   4. On Confirm, we AEAD-encrypt {blob, blobSignature} with kEnc and
//      send {kind:"deliver", ciphertext, nonce}. On {kind:"delivered"}
//      we mark the draft and tear down.

import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername } from "../lib/state.js";
import { bytesToHex, signWithIrk } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  canonicalInstallBlob,
  deleteDraft,
  getDraft,
  listDrafts,
  saveDraft,
} from "../lib/buildDraft.js";
import { releaseServerName, serverDomainOf } from "../lib/releaseServer.js";

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

const CONFIRM_GATE_MS = 600;

let activeDraftId = null;
let activeRelay = null;
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

// ── base64url helpers ────────────────────────────────────────────────
function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(b64u) {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── QR-URL parsing ───────────────────────────────────────────────────
/**
 * Accept either the canonical URL form (https://flagshipserver.com/qr?s=…&k=…)
 * or the deep-link form (flagship://qr?s=…&k=…) or a raw query string
 * fragment ("s=…&k=…"). Returns { sid, pkB }.
 */
function parseQrUrl(raw) {
  const text = (raw || "").trim();
  if (!text) throw new Error("paste the QR URL from the homepage");
  let s, k;
  try {
    if (text.includes("?")) {
      // URL or deep-link form
      const u = new URL(text.startsWith("flagship://") ? text.replace("flagship://", "https://_/") : text);
      s = u.searchParams.get("s");
      k = u.searchParams.get("k");
    } else if (text.includes("=")) {
      const sp = new URLSearchParams(text);
      s = sp.get("s");
      k = sp.get("k");
    }
  } catch (_) {
    throw new Error("could not parse the URL");
  }
  if (!s || !k) throw new Error("URL missing s= or k= parameter");
  return { sid: s, pkB: k };
}

// ── Crypto: derive shared secret + match code + AEAD key ────────────
async function deriveMaterial(phoneSk, browserPkB64u) {
  const browserPkBytes = b64urlDecode(browserPkB64u);
  if (browserPkBytes.length !== 32) throw new Error("browserPk must be 32 bytes");
  const browserPk = await crypto.subtle.importKey(
    "raw", browserPkBytes, { name: "X25519" }, false, []
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: browserPk }, phoneSk, 256,
  );
  const base = await crypto.subtle.importKey(
    "raw", sharedBits, "HKDF", false, ["deriveBits"]
  );
  async function expand(infoStr, bits) {
    return new Uint8Array(await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("flagship/qr/v1"),
        info: new TextEncoder().encode(infoStr),
      },
      base,
      bits,
    ));
  }
  const kEncBytes = await expand("flagship/qr/enc/v1", 256);
  const sasBytes  = await expand("flagship/qr/sas/v1", 32);
  const u32 = (sasBytes[0] << 24 | sasBytes[1] << 16 | sasBytes[2] << 8 | sasBytes[3]) >>> 0;
  const matchCode = (u32 % 1_000_000).toString().padStart(6, "0");
  const kEnc = await crypto.subtle.importKey(
    "raw", kEncBytes, "AES-GCM", false, ["encrypt"]
  );
  return { matchCode, kEnc };
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
        <span class="value">${escapeHtml(new Date(d.updatedAt).toLocaleString())}</span>
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
      if (action === "resume") resumeDraft(id).catch((err) => toast(String(err), "err"));
      else if (action === "cancel-server") {
        cancelServer(id).catch((err) => toast(String(err), "err"));
      } else if (action === "delete") {
        (async () => {
          const { inlineConfirm } = await import("../lib/modal.js");
          const ok = await inlineConfirm({
            title: "Delete this draft?",
            okLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
          deleteDraft(id).then(refreshDrafts).catch((err) => toast(String(err), "err"));
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
  if (!d) return toast("draft not found", "err");
  const session = getSession();
  // P14 Phase 2 — companion profiles route the cancel through the
  // owner; they don't need an unlocked session to QUEUE the request.
  // The companion-aware branch below detects {pending:true} and
  // surfaces the "Forwarded to owner" sheet.
  const { isCompanionProfile } = await import("../lib/companionGuard.js");
  const asCompanion = isCompanionProfile();
  if (!asCompanion && (!session.umk || !session.irk)) {
    return toast("unlock the webapp first", "err");
  }
  const username = session.username
    || (await ensureUsername().catch(() => null));
  if (!username) return toast("no account on this device", "err");

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
      { username, serverDomain, umk: session.umk, signWithIrk },
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
        toast(`server "${d.serverName}" cancelled — the name is free again`, "ok");
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
    toast(`server "${d.serverName}" cancelled — the name is free again`, "ok");
    await refreshDrafts();
  } catch (e) {
    toast(`cancel failed: ${e.message ?? e}`, "err");
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
    `https://flagshipserver.com/api/auth-code/${encodeURIComponent(serial)}/revoke`,
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
    toast(String(e), "err");
  }
}

async function resumeDraft(id) {
  const d = await getDraft(id);
  if (!d) return toast("draft not found", "err");
  activeDraftId = id;
  $("cs-server-name").value = d.serverName || "";
  $("cs-backup-policy").value = d.backupPolicy || "phone-only";
  restoreDiskEncryption(d.diskEncryption);
  toast(`resumed ${d.serverName}`);
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
  return { serverName, backupPolicy, recipeTtlMs, bootUnlockMode, diskEncryption };
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
 * Wire the "Download recipe" button to emit a JSON file the Burner
 * CLI can consume verbatim. Schema matches `flagship-burner`'s
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
function enableRecipeDownload(blobBundle) {
  const btn = $("cs-download-recipe");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = "Download recipe (.json)";
  const recipe = { ...blobBundle.blob, blobSignatureHex: blobBundle.blobSignature };
  btn.onclick = () => {
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
    URL.revokeObjectURL(url);
  };
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
    toast("draft saved");
    await refreshDrafts();
  } catch (e) {
    toast(String(e.message || e), "err");
  }
}

// ── The v2 deliver flow ──────────────────────────────────────────────
async function handleDeliverNow() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    return toast("unlock the webapp first", "err");
  }
  let inputs;
  try { inputs = readInputs(); }
  catch (e) { return toast(String(e.message || e), "err"); }

  // Phase 2: the account is now opened FIRST (standalone username claim
  // + device bind), so by the time the user reaches "Add a server" the
  // username is already bound to this device's IRK. If the session
  // already carries a username, the claim has happened — skip it. Only a
  // legacy direct-to-create-server entry (no open-account step) still
  // claims here, and even that stays 409-tolerant (idempotent).
  const alreadyOpened = !!session.username;
  const username = await ensureUsername();

  let qrUrl;
  try { qrUrl = parseQrUrl($("cs-relay-session").value); }
  catch (e) { return toast(String(e.message || e), "err"); }

  setStatus("active", "minting install blob…");
  let blobBundle;
  try {
    blobBundle = await mintInstallBlobBundle(session, username, inputs, { skipClaim: alreadyOpened });
  } catch (e) {
    setStatus("error", String(e.message || e));
    return;
  }

  // Enable the "Download recipe" button now that we have a freshly
  // signed bundle. The Burner CLI accepts this exact JSON via
  // `flagship-burn verify <file>` / `flagship-burn user-data <file>
  // out.yaml` / `flagship-burn prepare <file> <iso> out.iso`.
  enableRecipeDownload(blobBundle);

  setStatus("active", "connecting to relay…");
  try {
    await deliverThroughRelay(qrUrl, blobBundle);
    setStatus("done", "delivered. The browser is downloading the recipe — open it in the Flagship Assembler.");
    const saved = await saveDraft({
      id: activeDraftId,
      ...inputs,
      status: "delivered",
      deliveredAt: Date.now(),
      code: blobBundle.blob.authCode.serial,
    });
    activeDraftId = saved.id;
    await refreshDrafts();
  } catch (e) {
    setStatus("error", String(e.message || e));
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

async function mintInstallBlobBundle(session, username, inputs, opts = {}) {
  const { serverName, recipeTtlMs } = inputs;
  // §7a.1: only "approve" is carried on the wire; "auto" is the absent-field
  // default so legacy recipes stay byte-identical (see canonicalInstallBlob).
  const bootUnlockMode = inputs.bootUnlockMode === "approve" ? "approve" : "auto";
  const ttlMs = clampRecipeTtlMs(recipeTtlMs);
  const irkPubHex = bytesToHex(session.irk.publicKey);

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
    const claimResp = await fetch("/api/username/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { username, irkPub: irkPubHex, issuedAt: claimIssuedAt },
        signature: bytesToHex(claimSig),
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
    serverDomain: `${serverName}.${username}.flagship.services`,
    delegatedPubKey: delegated.publicKey,
    userPubKey: session.irk.publicKey,
    issuedAt: acIssuedAt,
    expiresAt: acExpiresAt,
  };
  const acMsg = canonical([
    TAG_AUTH_CODE, code.version, code.serial, code.username, code.serverName,
    code.serverDomain, bytesToHex(code.delegatedPubKey), bytesToHex(code.userPubKey),
    code.issuedAt, code.expiresAt,
  ]);
  const acSig = await signWithIrk(session.umk, acMsg);
  const issueResp = await fetch("/api/auth-code/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: {
        version: code.version, serial: code.serial, username: code.username,
        serverName: code.serverName, serverDomain: code.serverDomain,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
        issuedAt: code.issuedAt, expiresAt: code.expiresAt,
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
  const rckRegSig = await signWithIrk(session.umk, rckRegMsg);
  const rckResp = await fetch("/api/routing/register-rck", {
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
    registrationUrl: "https://flagshipserver.com/api/server/register",
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
    },
    authCodeUserSignature: bytesToHex(acSig),
    installerGitRef: blob.installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
  };
  // Mirror the conditional from the canonical blob: present iff "approve",
  // so the downloaded recipe JSON carries exactly what was signed.
  if (blob.bootUnlockMode !== undefined) onWireBlob.bootUnlockMode = blob.bootUnlockMode;
  // Mirror the conditional from the canonical blob: present iff "none", so the
  // downloaded recipe JSON carries exactly what was signed (the burner round-
  // trips it and re-derives the same `de=none` token for box verification).
  if (blob.diskEncryption !== undefined) onWireBlob.diskEncryption = blob.diskEncryption;
  return { blob: onWireBlob, blobSignature: bytesToHex(blobSig) };
}

async function deliverThroughRelay({ sid, pkB }, blobBundle) {
  // Generate our ephemeral X25519 keypair.
  const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const phonePkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const phonePkB64u = b64urlEncode(phonePkRaw);

  // Derive shared material locally — match code is computed without
  // server input. The server NEVER sees this value.
  const { matchCode, kEnc } = await deriveMaterial(kp.privateKey, pkB);

  // Open WS as phone. We always dial the apex — the webapp lives at
  // web.flagshipserver.com but the relay is on flagshipserver.com.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://flagshipserver.com/qr-pipe/${encodeURIComponent(sid)}?role=phone`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    activeRelay = { ws, sid, abort: () => ws.close(1000, "user cancel") };
    let confirmed = false;
    let helloSent = false;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ kind: "hello", phonePk: phonePkB64u }));
      helloSent = true;
    });

    ws.addEventListener("close", (e) => {
      if (!confirmed) reject(new Error(`relay closed (${e.code} ${e.reason || ""})`));
    });
    ws.addEventListener("error", () => {
      if (!confirmed) reject(new Error("relay socket error"));
    });
    ws.addEventListener("message", async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.kind !== "string") return;

      if (m.kind === "ack") {
        // Show match code + arm the Confirm gate.
        $("cs-match-code").textContent = `${matchCode.slice(0, 3)} ${matchCode.slice(3)}`;
        setStatus("active", `compare the code on both screens, then confirm`);
        try {
          await waitForConfirm();
        } catch (e) {
          ws.close(1000, "cancelled");
          return reject(e);
        }
        try {
          // AEAD-encrypt the bundle.
          const plain = new TextEncoder().encode(JSON.stringify(blobBundle));
          const nonce = crypto.getRandomValues(new Uint8Array(12));
          const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce }, kEnc, plain,
          ));
          ws.send(JSON.stringify({
            kind: "deliver",
            ciphertext: b64urlEncode(ct),
            nonce: b64urlEncode(nonce),
          }));
        } catch (e) {
          reject(e);
        }
      } else if (m.kind === "delivered") {
        confirmed = true;
        try { ws.close(1000, "delivered"); } catch (_e) {}
        resolve();
      } else if (m.kind === "peer-missing") {
        reject(new Error("the browser at the homepage isn't connected — reload it and retry"));
      } else if (m.kind === "expired") {
        reject(new Error("session expired — refresh the homepage and try again"));
      } else if (m.kind === "error") {
        reject(new Error(`relay: ${m.reason}`));
      }
    });
  });
}

// Confirm gate — Tor-style 600 ms enforced pause so the user can read
// the codes before tapping. Returns a promise that resolves on Confirm
// or rejects on Cancel.
function waitForConfirm() {
  return new Promise((resolve, reject) => {
    const btn = $("cs-deliver");
    if (!btn) return reject(new Error("confirm button missing"));
    btn.textContent = "Codes match — confirm";
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, CONFIRM_GATE_MS);
    const onClick = () => { cleanup(); resolve(); };
    const onBack = () => { cleanup(); reject(new Error("cancelled")); };
    function cleanup() {
      btn.removeEventListener("click", onClick);
      $("create-server-back")?.removeEventListener("click", onBack);
      btn.textContent = "Deliver to homepage";
      btn.disabled = false;
    }
    btn.addEventListener("click", onClick, { once: true });
    $("create-server-back")?.addEventListener("click", onBack, { once: true });
  });
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

export function initCreateServerView() {
  wireServerNameValidation();
  $("cs-save-draft")?.addEventListener("click", () => handleSaveDraft());
  $("cs-deliver")?.addEventListener("click", () => handleDeliverNow().catch((e) => toast(String(e), "err")));
  $("cs-open-build")?.addEventListener("click", () => {
    window.open("https://flagshipserver.com/", "_blank");
  });
  $("cs-new")?.addEventListener("click", () => {
    activeDraftId = null;
    $("cs-server-name").value = "";
    $("cs-backup-policy").value = "phone-only";
    $("cs-llm-pref").value = "";
    $("cs-relay-session").value = "";
    $("cs-match-code").textContent = "— — —";
    restoreDiskEncryption(null);
    setStatus("idle", "idle");
  });
  $("create-server-back")?.addEventListener("click", () => {
    if (activeRelay) try { activeRelay.abort(); } catch (_e) {}
    activeRelay = null;
    show("view-home");
  });
}

export async function enterCreateServer() {
  show("view-create-server");
  await refreshDrafts();
}
