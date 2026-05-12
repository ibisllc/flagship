// Flagship browser-side ISO personalizer (#59 — relay edition).
//
// Drives the build flow end-to-end:
//   1. Generate an ephemeral X25519 keypair in this tab. The private
//      half NEVER leaves the page; the public half is the "address"
//      the phone will encrypt the InstallBlob to.
//   2. POST /api/build-relay/sessions to mint a Durable-Object-backed
//      relay session on flagshipserver.com.
//   3. Open a WebSocket as role=browser, send a `browser-hello`
//      carrying the ephemeral pubkey.
//   4. The relay returns a 6-digit `matched` code derived from
//      (sessionId, browserPk). Show it; the phone derives the same
//      digits independently and the user visually compares.
//   5. Wait for the relay to forward a `blob` frame from the phone.
//      Its `ciphertext` is opaque base64 to .com — we decode + decrypt
//      it with our ephemeral X25519 private key.
//   6. Decode the canonical InstallBlob JSON + signature, build the
//      magic-header-prefixed trailer (same format as before — see
//      packages/iso-personalizer for the spec).
//   7. Stream the base ISO, append the trailer, download.
//
// No keys are generated for the user here. No username is claimed
// here. All authority came from the phone. This page is a pure
// assembler with one extra responsibility: a 32-byte ephemeral X25519
// keypair that exists only for the duration of this one transfer.

const MAGIC_HEADER = new TextEncoder().encode("FLAGSHIP-BOOT\0\0\0");
const MAGIC_FOOTER = new TextEncoder().encode("\0\0\0FLAGSHIP-END\0");
const FORMAT_VERSION = 0x01;
const SIG_LEN = 64;
const MAX_TRAILER_BYTES = 65_536;

const $ = (id) => document.getElementById(id);

const log = (msg, data) => {
  const el = $("log");
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = data === undefined ? `[${ts}] ${msg}` : `[${ts}] ${msg} ${JSON.stringify(data)}`;
  el.textContent = el.textContent === "—" ? line : el.textContent + "\n" + line;
};

const setStep = (id, state, detail) => {
  const el = $(id);
  if (!el) return;
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
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function buildTrailerBytes(blobJson, blobSignatureHex) {
  const json = new TextEncoder().encode(JSON.stringify(blobJson));
  const signature = hexToBytes(blobSignatureHex);
  if (signature.length !== SIG_LEN) throw new Error(`bad signature length ${signature.length}`);
  const total = MAGIC_HEADER.length + 1 + 4 + json.length + SIG_LEN + MAGIC_FOOTER.length + 4;
  if (total > MAX_TRAILER_BYTES) throw new Error(`trailer too large: ${total}`);
  return concat([
    MAGIC_HEADER,
    Uint8Array.of(FORMAT_VERSION),
    u32le(json.length),
    json,
    signature,
    MAGIC_FOOTER,
    u32le(total),
  ]);
}

// ---- Ephemeral X25519 keypair (browser-held) ----
//
// crypto.subtle X25519 is in Chrome 130+, Safari 17+, Firefox 130+.
// Older browsers will throw during `generateKey`; we surface that as a
// fatal-but-actionable error to the user rather than a generic crash.

async function generateBrowserKeypair() {
  const kp = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { keypair: kp, publicKey: rawPub };
}

/**
 * Open a sealed blob produced by `sealForRecipient` (see
 * packages/protocol/src/encryption.ts). Wire layout:
 *
 *   [eph_pub: 32 B][nonce: 12 B][ciphertext + GCM tag: var]
 *
 * HKDF-SHA256(shared, salt=eph_pub, info="flagship.seal.v1", L=32).
 */
async function openSealed(blob, browserPrivKey) {
  if (blob.length < 44) throw new Error("sealed blob too short");
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 44);
  const ct = blob.slice(44);
  const ephPubKey = await crypto.subtle.importKey("raw", ephPub, "X25519", false, []);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: ephPubKey },
    browserPrivKey,
    256,
  );
  const sharedKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const symBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephPub,
      info: new TextEncoder().encode("flagship.seal.v1"),
    },
    sharedKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(symBits),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    ct,
  );
  return new Uint8Array(pt);
}

// ---- Relay-driven flow ----

let state = {
  keypair: null,
  publicKey: null,
  sessionId: null,
  matchCode: null,
  ws: null,
};

$("startBtn")?.addEventListener("click", async () => {
  $("startBtn").disabled = true;
  try {
    await runFullFlow();
  } catch (e) {
    log("FATAL", { error: String((e && e.message) || e) });
    setStep("step-session", "error", String((e && e.message) || e));
    $("startBtn").disabled = false;
  }
});

async function runFullFlow() {
  setStep("step-session", "active");
  state.keypair = null;
  state.publicKey = null;
  try {
    const kp = await generateBrowserKeypair();
    state.keypair = kp.keypair;
    state.publicKey = kp.publicKey;
  } catch (e) {
    setStep(
      "step-session",
      "error",
      "Your browser doesn't support X25519. Use Chrome 130+, Firefox 130+, or Safari 17+.",
    );
    log("X25519 unsupported", { error: String(e && e.message || e) });
    return;
  }
  log("ephemeral keypair generated", {
    pub: bytesToHex(state.publicKey).slice(0, 16) + "…",
  });
  setStep("step-session", "done", "Ephemeral X25519 keypair generated.");

  setStep("step-pair", "active");
  const sessResp = await fetch("/api/build-relay/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "build-page" }),
  });
  if (!sessResp.ok) {
    setStep("step-pair", "error", `relay unavailable (HTTP ${sessResp.status})`);
    log("relay mint failed", { status: sessResp.status });
    return;
  }
  const session = await sessResp.json();
  state.sessionId = session.sessionId;
  $("pairUi").hidden = false;
  $("joinUrl").textContent = session.joinUrl;
  log("session opened", { sessionId: session.sessionId, joinUrl: session.joinUrl });

  // QR encoder lives in /heroQr.js — load lazily so the build page
  // pays the cost only when the user actually starts a flow.
  await renderQrInto($("qrHolder"), session.joinUrl);

  await connectAndDeliver(session);
}

async function connectAndDeliver(session) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/build-relay/${session.sessionId}?role=browser`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    let helloSent = false;

    ws.addEventListener("open", () => {
      log("ws open", { url: wsUrl });
    });

    ws.addEventListener("error", (e) => {
      log("ws error", { error: String(e.message || e) });
    });

    ws.addEventListener("close", (e) => {
      log("ws closed", { code: e.code, reason: e.reason });
      // If we already saw a blob, the close is expected; otherwise the
      // session ended without delivery and we surface a generic error.
      if (!state.received) {
        setStep("step-deliver", "error", "session closed before delivery");
      }
    });

    ws.addEventListener("message", async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        log("non-JSON frame", { data: String(ev.data).slice(0, 80) });
        return;
      }
      if (msg.kind === "hello" && !helloSent) {
        helloSent = true;
        ws.send(JSON.stringify({
          kind: "browser-hello",
          browserPk: bytesToHex(state.publicKey),
        }));
      } else if (msg.kind === "matched") {
        state.matchCode = msg.matchCode;
        const formatted = `${msg.matchCode.slice(0, 3)}  ${msg.matchCode.slice(3)}`;
        $("matchDigits").textContent = formatted;
        log("match code", { matchCode: msg.matchCode });
        setStep("step-pair", "done", `Match code: ${formatted}. Verify on your phone before approving.`);
        setStep("step-deliver", "active");
      } else if (msg.kind === "blob") {
        try {
          state.received = true;
          const ciphertext = base64ToBytes(msg.ciphertext);
          const plaintext = await openSealed(ciphertext, state.keypair.privateKey);
          const installEnvelope = JSON.parse(new TextDecoder().decode(plaintext));
          if (!installEnvelope.blob || !installEnvelope.blobSignature) {
            throw new Error("envelope missing blob / blobSignature fields");
          }
          setStep("step-deliver", "done", `Received InstallBlob for ${installEnvelope.blob.serverDomain}.`);
          log("blob decrypted", {
            serverDomain: installEnvelope.blob.serverDomain,
          });
          try { ws.close(1000, "delivered"); } catch (_e) {}
          await personalizeAndDownload(installEnvelope);
          resolve();
        } catch (e) {
          setStep("step-deliver", "error", `decrypt failed: ${String((e && e.message) || e)}`);
          log("decrypt failed", { error: String((e && e.message) || e) });
          try { ws.close(1011, "decrypt failed"); } catch (_e) {}
          reject(e);
        }
      } else if (msg.kind === "error") {
        setStep("step-deliver", "error", `relay error: ${msg.reason}`);
        log("relay error", { reason: msg.reason });
      }
    });
  });
}

async function personalizeAndDownload(envelope) {
  setStep("step-iso", "active");
  const isoInfoResp = await fetch("/api/build/iso-info");
  const isoInfo = await isoInfoResp.json();
  log("iso-info", isoInfo);
  if (isoInfo.placeholder) {
    setStep(
      "step-iso",
      "active",
      `Placeholder ISO. The trailer will be built (${envelope.blob.serverDomain}); host a real ISO at ${isoInfo.url} to produce a flashable image.`,
    );
  }

  let trailer;
  try {
    trailer = buildTrailerBytes(envelope.blob, envelope.blobSignature);
  } catch (e) {
    setStep("step-iso", "error", `trailer build failed: ${String(e.message || e)}`);
    return;
  }
  log("trailer built", { size: trailer.length });

  let baseStreamResp;
  try {
    baseStreamResp = await fetch(isoInfo.url);
  } catch (e) {
    setStep("step-iso", "error", `base ISO unreachable: ${String(e.message || e)}`);
    offerTrailerOnly(trailer, envelope.blob);
    return;
  }
  if (!baseStreamResp.ok || !baseStreamResp.body) {
    setStep(
      "step-iso",
      "error",
      `base ISO unavailable: HTTP ${baseStreamResp.status}. Trailer is built (size ${trailer.length} bytes); you can still download it below.`,
    );
    offerTrailerOnly(trailer, envelope.blob);
    return;
  }

  const totalLen = parseInt(baseStreamResp.headers.get("content-length") ?? "0", 10);
  const reader = baseStreamResp.body.getReader();
  const chunks = [];
  let downloaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (totalLen > 0) {
      $("isoProgress").style.width = `${Math.round((downloaded / totalLen) * 100)}%`;
    }
  }
  chunks.push(trailer);
  $("isoProgress").style.width = "100%";

  const fileName = `flagship-${envelope.blob.serverName}.${envelope.blob.username}.iso`;
  const finalBlob = new Blob(chunks, { type: "application/octet-stream" });
  triggerDownload(finalBlob, fileName);
  setStep("step-iso", "done", `Personalized ${fileName} (${formatBytes(finalBlob.size)}).`);
  setStep("step-done", "done");
}

function offerTrailerOnly(trailer, blob) {
  const fileName = `flagship-${blob.serverName}.${blob.username}.trailer.bin`;
  const blobObj = new Blob([trailer], { type: "application/octet-stream" });
  triggerDownload(blobObj, fileName);
  setStep("step-done", "done", `Trailer-only download: ${fileName}. Append it to the base ISO once available.`);
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function formatBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

// Tiny dependency: a lazily-imported QR renderer that ships in
// /heroQr.js as a side-effect-free export. The hero card on the
// landing page uses it for the same purpose; we re-use the encoder
// here so we don't double-vendor.
async function renderQrInto(host, text) {
  try {
    const m = await import("/qrEncoder.js");
    host.innerHTML = m.renderQrSvg(text, { size: 240, foreground: "#14130E", background: "transparent" });
  } catch (e) {
    log("qr renderer unavailable", { error: String(e.message || e) });
    host.innerHTML = `<code class="raw">${text}</code>`;
  }
}
