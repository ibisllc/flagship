// Phone-simulator: signs the install flow on behalf of a fake phone.
// In production this all happens inside the iOS / Android app where the
// IRK lives in Secure Enclave / StrongBox.

const TAG_CLAIM = "flagship/claim-username/v1";
const TAG_AUTH_CODE = "flagship/auth-code/v1";
const TAG_INSTALL_BLOB = "flagship/install-blob/v1";
const TAG_RCK_REGISTER = "flagship/rck-register/v1";

const $ = (id) => document.getElementById(id);

const log = (msg, data) => {
  const el = $("log");
  const ts = new Date().toISOString().slice(11, 23);
  const line = data === undefined ? `[${ts}] ${msg}` : `[${ts}] ${msg} ${JSON.stringify(data)}`;
  el.textContent = el.textContent === "—" ? line : el.textContent + "\n" + line;
};

const setStep = (id, state, detail) => {
  const el = $(id);
  el.classList.remove("pending", "active", "done", "error");
  el.classList.add(state);
  if (detail !== undefined) {
    const p = el.querySelector("p");
    if (p) p.textContent = detail;
  }
};

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function gen() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { keypair: kp, publicKey: pub };
}
async function sign(privateKey, msg) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, msg);
  return new Uint8Array(sig);
}

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function genSerial() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

let lastIssued = null;

$("goBtn").addEventListener("click", async () => {
  $("goBtn").disabled = true;
  try {
    await runFlow();
  } catch (e) {
    log("FATAL", { error: String(e && e.message || e) });
    $("goBtn").disabled = false;
  }
});

async function runFlow() {
  const username = $("username").value.trim().toLowerCase();
  const serverName = $("serverName").value.trim().toLowerCase();
  if (!LABEL_RE.test(username) || !LABEL_RE.test(serverName)) {
    setStep("step-identity", "error", "username/serverName must be RFC 1035 labels");
    return;
  }
  setStep("step-identity", "done");
  setStep("step-server", "done");

  const irk = await gen();
  const delegated = await gen();
  log("identities generated", {
    irkPub: bytesToHex(irk.publicKey).slice(0, 16) + "…",
    delegatedPub: bytesToHex(delegated.publicKey).slice(0, 16) + "…",
  });

  setStep("step-claim", "active");
  const claimIssuedAt = Date.now();
  const claimMsg = canonical([TAG_CLAIM, username, bytesToHex(irk.publicKey), claimIssuedAt]);
  const claimSig = await sign(irk.keypair.privateKey, claimMsg);
  const claimResp = await fetch("/api/username/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, irkPub: bytesToHex(irk.publicKey), issuedAt: claimIssuedAt },
      signature: bytesToHex(claimSig),
    }),
  });
  if (!claimResp.ok) {
    setStep("step-claim", "error", `claim failed: ${claimResp.status}`);
    log("claim failed", { status: claimResp.status, body: await claimResp.text() });
    return;
  }
  setStep("step-claim", "done");

  setStep("step-issue", "active");
  const acIssuedAt = Date.now();
  const acExpiresAt = acIssuedAt + 60 * 60_000;
  const code = {
    version: 1,
    serial: genSerial(),
    username,
    serverName,
    serverDomain: `${serverName}.${username}.flagship.services`,
    delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: acIssuedAt,
    expiresAt: acExpiresAt,
  };
  const acMsg = canonical([
    TAG_AUTH_CODE, code.version, code.serial, code.username, code.serverName,
    code.serverDomain, bytesToHex(code.delegatedPubKey), bytesToHex(code.userPubKey),
    code.issuedAt, code.expiresAt,
  ]);
  const acSig = await sign(irk.keypair.privateKey, acMsg);
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
    setStep("step-issue", "error", `issue failed: ${issueResp.status}`);
    log("issue failed", { status: issueResp.status, body: await issueResp.text() });
    return;
  }
  setStep("step-issue", "done");

  setStep("step-ticket", "active");

  // Generate the routing-control-key for this subdomain. The phone holds
  // the private side; the public side is registered with .com (signed by
  // the user's IRK) and baked into the install trailer.
  const rck = await gen();
  const rckRegIssuedAt = Date.now();
  const rckRegMsg = canonical([
    TAG_RCK_REGISTER, username, code.serverDomain, bytesToHex(rck.publicKey), rckRegIssuedAt,
  ]);
  const rckRegSig = await sign(irk.keypair.privateKey, rckRegMsg);
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
    setStep("step-ticket", "error", `RCK register failed: ${rckResp.status}`);
    log("rck register failed", { status: rckResp.status, body: await rckResp.text() });
    return;
  }
  log("RCK registered", {
    subdomain: code.serverDomain,
    rckPub: bytesToHex(rck.publicKey).slice(0, 16) + "…",
  });

  const installerGitRef = "main";
  const blob = {
    version: 1,
    serverDomain: code.serverDomain,
    username,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode: code,
    authCodeUserSignature: acSig,
    issuedAt: acIssuedAt,
    expiresAt: acExpiresAt,
    installerGitRef,
    rckPubKey: rck.publicKey,
  };
  const blobMsg = canonical([
    TAG_INSTALL_BLOB, blob.version, blob.serverDomain, blob.username, blob.serverName,
    bytesToHex(blob.phoneDelegatedPubKey), blob.registrationUrl,
    blob.authCode.serial, bytesToHex(blob.authCode.userPubKey),
    bytesToHex(blob.authCodeUserSignature), blob.issuedAt, blob.expiresAt,
    installerGitRef, bytesToHex(blob.rckPubKey),
  ]);
  const blobSig = await sign(irk.keypair.privateKey, blobMsg);

  const ttlMs = parseInt($("ttlMs").value, 10);
  const ticketResp = await fetch("/api/build-tickets/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      blob: {
        version: 1,
        serverDomain: blob.serverDomain,
        username: blob.username,
        serverName: blob.serverName,
        phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
        registrationUrl: blob.registrationUrl,
        authCode: {
          version: 1, serial: code.serial, username: code.username,
          serverName: code.serverName, serverDomain: code.serverDomain,
          delegatedPubKey: bytesToHex(code.delegatedPubKey),
          userPubKey: bytesToHex(code.userPubKey),
          issuedAt: code.issuedAt, expiresAt: code.expiresAt,
        },
        authCodeUserSignature: bytesToHex(acSig),
        issuedAt: blob.issuedAt,
        expiresAt: blob.expiresAt,
        installerGitRef: installerGitRef,
        rckPubKey: bytesToHex(blob.rckPubKey),
      },
      signature: bytesToHex(blobSig),
      ttlMs,
    }),
  });
  if (!ticketResp.ok) {
    setStep("step-ticket", "error", `ticket failed: ${ticketResp.status}`);
    log("ticket failed", { status: ticketResp.status, body: await ticketResp.text() });
    return;
  }
  const ticket = await ticketResp.json();
  setStep("step-ticket", "done", `Code expires ${new Date(ticket.expiresAt).toLocaleTimeString()}.`);
  $("codeOut").hidden = false;
  $("codeOut").textContent = ticket.code;
  $("codeActions").hidden = false;
  lastIssued = ticket;
  log("ticket minted", { code: ticket.code, expiresAt: new Date(ticket.expiresAt).toISOString() });
}

$("copyBtn").addEventListener("click", () => {
  if (!lastIssued) return;
  navigator.clipboard.writeText(lastIssued.code);
  $("copyBtn").textContent = "Copied!";
  setTimeout(() => ($("copyBtn").textContent = "Copy code"), 1200);
});

$("openBuildBtn").addEventListener("click", () => {
  if (!lastIssued) return;
  window.open(`/build/?code=${encodeURIComponent(lastIssued.code)}`, "_blank");
});

$("refreshBtn").addEventListener("click", async () => {
  if (!lastIssued) return;
  const r = await fetch(`/api/build-tickets/${lastIssued.code}/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ttlMs: 60 * 60_000 }),
  });
  if (!r.ok) {
    log("refresh failed", { status: r.status });
    return;
  }
  const j = await r.json();
  lastIssued.expiresAt = j.expiresAt;
  log("refreshed", { expiresAt: new Date(j.expiresAt).toISOString() });
  setStep("step-ticket", "done", `Code expires ${new Date(j.expiresAt).toLocaleTimeString()}.`);
});
