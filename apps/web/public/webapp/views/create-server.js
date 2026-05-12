// Phone-side draft composer for a new server (task #60).
//
// The user fills in a serverName + backup-policy + LLM provider
// preferences, signs an InstallBlob with the device IRK, and either
// saves the draft for later or pushes it through the build-relay to a
// browser at /build/ that is waiting to assemble the personalized
// ISO.
//
// Note: only the webapp peer's composer is in scope here. iOS and
// Android composers will mirror the same canonical-bytes shape.
//
// Sequencing of a "Deliver now":
//   1. Read user inputs + the per-device IRK from the unlock session.
//   2. POST /api/username/claim (idempotent on the same username/IRK).
//   3. POST /api/auth-code/issue with a freshly-minted delegated
//      keypair + serial.
//   4. POST /api/routing/register-rck for the new subdomain.
//   5. Construct the canonical InstallBlob, sign it.
//   6. Open a relay WebSocket as role=sender. The browser arrived
//      first and has already deposited its X25519 pubkey; the relay
//      pushes us a `browser-key` frame on connect. We derive the
//      match-code independently and surface it for the user to
//      compare with the /build/ tab.
//   7. crypto_box_seal-encrypt { blob, blobSignature } for the
//      browser's pubkey and send as `{ kind: "blob", ciphertext }`.
//   8. Wait for `delivered` ACK. Mark the draft `delivered`.

import { $, registerView, show } from "../lib/router.js";
import { getSession, ensureUsername } from "../lib/state.js";
import { bytesToHex, signWithIrk } from "../keystore.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import {
  canonicalInstallBlob,
  deleteDraft,
  deriveMatchCode,
  getDraft,
  listDrafts,
  saveDraft,
  sealForBrowserKey,
} from "../lib/buildDraft.js";

registerView("view-create-server");

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TAG_CLAIM = "flagship/claim-username/v1";
const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_RCK_REGISTER = "flagship/rck-register/v1";

let activeDraftId = null;
let activeRelay = null; // { ws, sessionId, abort() }

function genSerial() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

async function gen() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { keypair: kp, publicKey: pub };
}

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function renderDraftList(drafts) {
  const list = $("cs-drafts");
  if (!list) return;
  if (drafts.length === 0) {
    list.innerHTML = '<p class="note">no saved drafts yet</p>';
    return;
  }
  list.innerHTML = drafts.map((d) => `
    <div class="card">
      <div class="row">
        <span class="value"><strong>${escapeHtml(d.serverName || "(unnamed)")}</strong></span>
        <span class="pill ${d.status === "delivered" ? "ok" : ""}">${escapeHtml(d.status)}</span>
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
    </div>
  `).join("");
  list.querySelectorAll("button[data-action]").forEach((b) => {
    b.addEventListener("click", (e) => {
      const action = e.currentTarget.getAttribute("data-action");
      const id = e.currentTarget.getAttribute("data-id");
      if (action === "resume") resumeDraft(id).catch((err) => toast(String(err), "err"));
      else if (action === "delete") {
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

async function refreshDrafts() {
  try {
    const drafts = await listDrafts();
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
  $("cs-llm-pref").value = (d.llmPreferences || []).map((p) => `${p.providerId}:${p.modelName ?? ""}`).join("\n");
  toast(`resumed ${d.serverName}`);
}

function readInputs() {
  const serverName = $("cs-server-name").value.trim().toLowerCase();
  if (!LABEL_RE.test(serverName)) {
    throw new Error("serverName must be a DNS label (a-z, 0-9, -, ≤63 chars)");
  }
  const backupPolicy = $("cs-backup-policy").value;
  const llmRaw = $("cs-llm-pref").value.trim();
  const llmPreferences = llmRaw
    ? llmRaw.split(/\r?\n/).filter(Boolean).map((line) => {
        const [providerId, modelName] = line.split(":");
        return { providerId: (providerId || "").trim(), modelName: (modelName || "").trim() };
      })
    : [];
  return { serverName, backupPolicy, llmPreferences };
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

async function handleDeliverNow() {
  const session = getSession();
  if (!session.umk || !session.irk) {
    return toast("unlock the webapp first", "err");
  }
  let inputs;
  try {
    inputs = readInputs();
  } catch (e) {
    return toast(String(e.message || e), "err");
  }
  const username = await ensureUsername();

  const sessionId = $("cs-relay-session").value.trim();
  if (!sessionId) {
    return toast("paste the sessionId shown on /build/", "err");
  }

  setStatus("active", "claiming username + minting blob…");
  let blobBundle;
  try {
    blobBundle = await mintInstallBlobBundle(session, username, inputs);
  } catch (e) {
    setStatus("error", String(e.message || e));
    return;
  }

  setStatus("active", "joining relay as sender…");
  try {
    await deliverThroughRelay(sessionId, blobBundle);
    setStatus("done", "delivered. Switch to your /build/ tab to download the ISO.");
    // Persist the delivered draft so the user has a record.
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

async function mintInstallBlobBundle(session, username, inputs) {
  const { serverName } = inputs;
  const irkPubHex = bytesToHex(session.irk.publicKey);

  // 1. Claim username (idempotent — if already mine, server short-circuits OK).
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
    const txt = await claimResp.text();
    throw new Error(`claim failed (${claimResp.status}): ${txt}`);
  }

  // 2. Generate delegated phone keypair + auth code.
  const delegated = await gen();
  const acIssuedAt = Date.now();
  const acExpiresAt = acIssuedAt + 60 * 60_000;
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
  if (!issueResp.ok) {
    throw new Error(`auth-code/issue failed (${issueResp.status})`);
  }

  // 3. Generate RCK + register.
  const rck = await gen();
  const rckRegIssuedAt = Date.now();
  const rckRegMsg = canonical([
    TAG_RCK_REGISTER, username, code.serverDomain, bytesToHex(rck.publicKey), rckRegIssuedAt,
  ]);
  const rckRegSig = await signWithIrk(session.umk, rckRegMsg);
  const rckResp = await fetch("/api/routing/register-rck", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: {
        username,
        subdomain: code.serverDomain,
        rckPubKey: bytesToHex(rck.publicKey),
        issuedAt: rckRegIssuedAt,
      },
      signature: bytesToHex(rckRegSig),
    }),
  });
  if (!rckResp.ok) {
    throw new Error(`RCK register failed (${rckResp.status})`);
  }

  // 4. Compose the canonical InstallBlob + sign with IRK.
  const installerGitRef = "main";
  const blob = {
    version: 1,
    serverDomain: code.serverDomain,
    username,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: acSig,
    issuedAt: acIssuedAt,
    expiresAt: acExpiresAt,
    installerGitRef,
    rckPubKey: rck.publicKey,
  };
  const blobBytes = canonicalInstallBlob(blob);
  const blobSig = await signWithIrk(session.umk, blobBytes);

  // 5. Render the blob into the on-wire JSON shape the trailer code
  // expects (all bytes-fields hex-encoded). This is the same shape
  // the previous build-tickets/redeem endpoint returned.
  const onWireBlob = {
    version: blob.version,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: code.version,
      serial: code.serial,
      username: code.username,
      serverName: code.serverName,
      serverDomain: code.serverDomain,
      delegatedPubKey: bytesToHex(code.delegatedPubKey),
      userPubKey: bytesToHex(code.userPubKey),
      issuedAt: code.issuedAt,
      expiresAt: code.expiresAt,
    },
    authCodeUserSignature: bytesToHex(acSig),
    issuedAt: blob.issuedAt,
    expiresAt: blob.expiresAt,
    installerGitRef: blob.installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
  };
  return { blob: onWireBlob, blobSignature: bytesToHex(blobSig) };
}

async function deliverThroughRelay(sessionId, blobBundle) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${location.hostname}/build-relay/${sessionId}?role=sender`;
    // Open against flagshipserver.com — the webapp host is
    // web.flagshipserver.com so we must dial the apex explicitly.
    const apexUrl = wsUrl.replace("web.flagshipserver.com", "flagshipserver.com");
    const ws = new WebSocket(apexUrl);
    activeRelay = { ws, sessionId, abort: () => ws.close(1000, "user cancel") };

    let acked = false;

    ws.addEventListener("close", (e) => {
      if (!acked) reject(new Error(`relay closed (${e.code} ${e.reason})`));
    });
    ws.addEventListener("error", () => {
      if (!acked) reject(new Error("relay socket error"));
    });
    ws.addEventListener("message", async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.kind === "hello") {
        // Wait for the browser-key frame; we don't act on this hello.
        return;
      }
      if (msg.kind === "browser-key") {
        try {
          // Independent derivation of the match-code — the relay
          // sends its own value, but we re-derive client-side so the
          // user can compare both surfaces with the relay-supplied
          // value as a tie-breaker only if our derivation matches.
          const local = await deriveMatchCode(sessionId, msg.browserPk);
          if (local !== msg.matchCode) {
            throw new Error(`match-code mismatch (local=${local}, relay=${msg.matchCode}) — the relay may be tampered with; refusing to send`);
          }
          $("cs-match-code").textContent = `${local.slice(0, 3)} ${local.slice(3)}`;
          // Encrypt {blob, blobSignature} JSON for the browser.
          const plaintext = new TextEncoder().encode(
            JSON.stringify(blobBundle),
          );
          const sealed = await sealForBrowserKey(plaintext, msg.browserPk);
          let bin = "";
          for (const b of sealed) bin += String.fromCharCode(b);
          ws.send(JSON.stringify({ kind: "blob", ciphertext: btoa(bin) }));
        } catch (e) {
          reject(e);
        }
      } else if (msg.kind === "delivered") {
        acked = true;
        try { ws.close(1000, "delivered"); } catch (_e) {}
        resolve();
      } else if (msg.kind === "error") {
        reject(new Error(`relay: ${msg.reason}`));
      }
    });
  });
}

export function initCreateServerView() {
  $("cs-save-draft")?.addEventListener("click", () => handleSaveDraft());
  $("cs-deliver")?.addEventListener("click", () => handleDeliverNow().catch((e) => toast(String(e), "err")));
  $("cs-open-build")?.addEventListener("click", () => {
    window.open("https://flagshipserver.com/build/", "_blank");
  });
  $("cs-new")?.addEventListener("click", () => {
    activeDraftId = null;
    $("cs-server-name").value = "";
    $("cs-backup-policy").value = "phone-only";
    $("cs-llm-pref").value = "";
    $("cs-relay-session").value = "";
    $("cs-match-code").textContent = "— — —";
    setStatus("idle", "idle");
  });
  $("create-server-back")?.addEventListener("click", () => {
    if (activeRelay) try { activeRelay.abort(); } catch (_e) {}
    activeRelay = null;
    show("view-home");
  });
}

export function enterCreateServer() {
  show("view-create-server");
  refreshDrafts().catch((e) => toast(String(e), "err"));
}
