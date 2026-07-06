#!/usr/bin/env -S npx tsx
/**
 * TRANSPORT-LEVEL probe for the cross-device device-add relay, against the REAL
 * deployed gym QrRelay DO (wss://gym.flagshipserver.com/qr-pipe/<sid>).
 *
 * It reproduces, byte-for-byte, the crypto + framing of the webapp's
 * lib/pairingRelay.js (WebCrypto X25519 + HKDF salt "flagship/qr/v1" + the
 * enc/sas info strings + AES-GCM), so what it observes IS what the deployed
 * webapp's add-device flow does.
 *
 * It checks three things and prints a verdict:
 *   1. SAS PARITY — admin (role=browser) + incoming (role=phone) on ONE sid both
 *      derive the SAME 6-digit SAS from the ECDH shared secret. (The security
 *      check the human performs.)
 *   2. THE BUG — the admin's bundle seal as lib/pairingRelay.js writes it today
 *      (ws.send {kind:"deliver"} on the BROWSER socket) is REJECTED by the DO
 *      ("browser sends nothing"), and the DO consumes+tears down leg-1 after the
 *      incoming device's FIRST deliver — so the sealed bundle can NEVER reach the
 *      incoming device. (Why full device-add silently hangs.)
 *   3. THE FIX — a two-leg choreography (the one pairingRelay's own header
 *      comment describes but never implemented): leg-1 carries the incoming
 *      device pubkey + a return sid_B + return eph pub (sealed under the
 *      SAS-verified key); leg-2 (sid_B, roles swapped) carries the sealed bundle
 *      admin→incoming. Round-trips a real bundle over the real relay.
 *
 * Run:  set -a; source .gym-secrets.env; set +a
 *       npx tsx tools/live-e2e/device-add-relay-probe.ts
 */
import { webcrypto as wc } from "node:crypto";
import { WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RELAY_HOST = process.env.GYM_LIVE_CONTROL_APEX ?? "gym.flagshipserver.com";
const SHOT_DIR = join("gym-results", "device-add-e2e");
mkdirSync(SHOT_DIR, { recursive: true });

const subtle = wc.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

/* ── base64url + crypto helpers — identical to lib/pairingRelay.js ── */
function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return Buffer.from(s, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(b64u: string): Uint8Array {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}
async function freshKeypair() {
  const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pkRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { sk: kp.privateKey, pkB64u: b64urlEncode(pkRaw) };
}
async function deriveMaterial(mySk: CryptoKey, peerPkB64u: string) {
  const peerPkBytes = b64urlDecode(peerPkB64u);
  if (peerPkBytes.length !== 32) throw new Error("peerPk must be 32 bytes");
  const peerPk = await subtle.importKey("raw", peerPkBytes, { name: "X25519" }, false, []);
  const sharedBits = await subtle.deriveBits({ name: "X25519", public: peerPk }, mySk, 256);
  const base = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const expand = async (infoStr: string, bits: number) =>
    new Uint8Array(await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: te.encode("flagship/qr/v1"), info: te.encode(infoStr) },
      base, bits,
    ));
  const kEncBytes = await expand("flagship/qr/enc/v1", 256);
  const sasBytes = await expand("flagship/qr/sas/v1", 32);
  const u32 = ((sasBytes[0]! << 24) | (sasBytes[1]! << 16) | (sasBytes[2]! << 8) | sasBytes[3]!) >>> 0;
  const sas = (u32 % 1_000_000).toString().padStart(6, "0");
  const kEncEncrypt = await subtle.importKey("raw", kEncBytes, "AES-GCM", false, ["encrypt"]);
  const kEncDecrypt = await subtle.importKey("raw", kEncBytes, "AES-GCM", false, ["decrypt"]);
  return { sas, kEncEncrypt, kEncDecrypt };
}
async function aeadSeal(kEnc: CryptoKey, plaintext: Uint8Array) {
  const nonce = wc.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, kEnc, plaintext));
  return { ciphertext: b64urlEncode(ct), nonce: b64urlEncode(nonce) };
}
async function aeadOpen(kEnc: CryptoKey, ctB64u: string, nonceB64u: string) {
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(nonceB64u) }, kEnc, b64urlDecode(ctB64u));
  return new Uint8Array(plain);
}
function freshSid(): string {
  return b64urlEncode(wc.getRandomValues(new Uint8Array(16)));
}
function wsUrl(sid: string, role: "browser" | "phone"): string {
  return `wss://${RELAY_HOST}/qr-pipe/${encodeURIComponent(sid)}?role=${role}`;
}
function nextMsg(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 12000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", on); reject(new Error("timeout waiting for relay frame")); }, timeoutMs);
    function on(data: any) {
      let m: any; try { m = JSON.parse(String(data)); } catch { return; }
      if (pred(m)) { clearTimeout(timer); ws.off("message", on); resolve(m); }
    }
    ws.on("message", on);
  });
}
function log(s: string) { process.stdout.write(s + "\n"); }

type Grade = "A" | "B" | "C" | "FAIL";
const findings: { step: string; grade: Grade; detail: string }[] = [];
function rec(step: string, grade: Grade, detail: string) {
  findings.push({ step, grade, detail });
  log(`[relay-probe] [${grade}] ${step}: ${detail}`);
}

async function main() {
  log(`\nDEVICE-ADD RELAY PROBE — real DO at wss://${RELAY_HOST}/qr-pipe/\n`);

  // ── leg-1: admin=browser, incoming=phone, ONE sid (the QR sid) ────────────
  const sidA = freshSid();
  const adminEph = await freshKeypair();         // admin's QR ephemeral
  const adminWs = new WebSocket(wsUrl(sidA, "browser"));
  await new Promise<void>((res, rej) => { adminWs.once("open", () => res()); adminWs.once("error", rej); });
  const accepted = await nextMsg(adminWs, (m) => m.kind === "accepted" || m.kind === "rebind");
  rec("admin (browser) opens leg-1 sid_A", accepted.kind === "accepted" ? "A" : "FAIL",
    `relay → ${accepted.kind} (sid_A=${sidA.slice(0, 10)}…)`);
  if (accepted.kind !== "accepted") throw new Error("relay rebind on a fresh sid — unexpected");

  // incoming connects as phone, mints its own eph, sends hello
  const incEph = await freshKeypair();
  const incWs = new WebSocket(wsUrl(sidA, "phone"));
  await new Promise<void>((res, rej) => { incWs.once("open", () => res()); incWs.once("error", rej); });

  // admin derives material once it sees peer-hello; incoming derives on its side.
  const adminPeerHello = nextMsg(adminWs, (m) => m.kind === "peer-hello");
  incWs.send(JSON.stringify({ kind: "hello", phonePk: incEph.pkB64u }));
  const incAck = await nextMsg(incWs, (m) => m.kind === "ack" || m.kind === "peer-missing");
  const ph = await adminPeerHello;

  const adminMat = await deriveMaterial(adminEph.sk, ph.phonePk);
  const incMat = await deriveMaterial(incEph.sk, adminEph.pkB64u);
  const sasMatch = adminMat.sas === incMat.sas && adminMat.sas.length === 6;
  rec("SAS PARITY (the human security check)", sasMatch ? "A" : "FAIL",
    sasMatch ? `MATCH — both sides derive ${adminMat.sas} from ECDH(admin_eph, incoming_eph) over the real relay`
             : `MISMATCH admin=${adminMat.sas} incoming=${incMat.sas} (ack=${incAck.kind})`);

  // ── 2. THE BUG: admin's bundle seal as written today (deliver on browser) ──
  // lib/pairingRelay.js makeAdminRelay.seal() does exactly this.
  const bugSeal = await aeadSeal(adminMat.kEncEncrypt, te.encode(JSON.stringify({ bundle: "demo" })));
  adminWs.send(JSON.stringify({ kind: "deliver", ...bugSeal }));
  let bugReject: any = null;
  try { bugReject = await nextMsg(adminWs, (m) => m.kind === "error", 5000); } catch { /* no error frame */ }
  rec("CURRENT seal() (deliver on the browser socket) is REJECTED by the DO",
    bugReject?.kind === "error" ? "A" : "C",
    bugReject?.kind === "error"
      ? `DO → error "${bugReject.reason}" — the admin→incoming seal can NEVER be delivered as coded today`
      : "no explicit error frame (DO silently drops browser-role inbound frames either way)");

  // ── leg-1 payload (the FIX): incoming sends {devicePub, returnSid, returnPk}
  //    sealed under the SAS-verified key. This is its single allowed deliver. ──
  const incDevicePubHex = "11".repeat(32); // stand-in fresh device IRK pub (hex)
  const sidB = freshSid();
  const incReturnEph = await freshKeypair();   // incoming's leg-2 (browser) eph
  const leg1Payload = te.encode(JSON.stringify({
    devicePubHex: incDevicePubHex, returnSid: sidB, returnPkB64u: incReturnEph.pkB64u,
  }));
  const leg1Sealed = await aeadSeal(incMat.kEncEncrypt, leg1Payload);

  // Open leg-2 as the incoming BROWSER (listener) BEFORE sending leg-1, so the
  // admin can connect leg-2 as phone the instant it reads sid_B.
  const incReturnWs = new WebSocket(wsUrl(sidB, "browser"));
  await new Promise<void>((res, rej) => { incReturnWs.once("open", () => res()); incReturnWs.once("error", rej); });
  const legBAccepted = await nextMsg(incReturnWs, (m) => m.kind === "accepted" || m.kind === "rebind");

  // admin awaits the incoming's leg-1 deliver (carrying the return coords)
  const adminLeg1 = nextMsg(adminWs, (m) => m.kind === "peer-deliver");
  incWs.send(JSON.stringify({ kind: "deliver", ...leg1Sealed }));
  const adminGotLeg1 = await adminLeg1;
  const leg1Plain = JSON.parse(td.decode(await aeadOpen(adminMat.kEncDecrypt, adminGotLeg1.ciphertext, adminGotLeg1.nonce)));
  rec("FIX leg-1: incoming → admin device pub + return-leg coords (sealed)",
    leg1Plain.devicePubHex === incDevicePubHex && leg1Plain.returnSid === sidB && legBAccepted.kind === "accepted" ? "A" : "FAIL",
    `admin decrypted devicePub=${String(leg1Plain.devicePubHex).slice(0, 12)}… returnSid=${String(leg1Plain.returnSid).slice(0, 10)}… (leg-2 browser ${legBAccepted.kind})`);

  // ── leg-2: admin=phone on sid_B, sends the sealed bundle to incoming=browser ─
  // The bundle is sealed under the SAME SAS-verified leg-1 key (incMat==adminMat
  // shared secret). Admin opens sid_B as phone, hello (its return eph), deliver.
  const adminLeg2Eph = await freshKeypair();
  const adminLeg2Ws = new WebSocket(wsUrl(leg1Plain.returnSid, "phone"));
  await new Promise<void>((res, rej) => { adminLeg2Ws.once("open", () => res()); adminLeg2Ws.once("error", rej); });
  adminLeg2Ws.send(JSON.stringify({ kind: "hello", phonePk: adminLeg2Eph.pkB64u }));
  await nextMsg(adminLeg2Ws, (m) => m.kind === "ack" || m.kind === "peer-missing");

  const realBundle = JSON.stringify({ umkSeedHex: "ab".repeat(32), admit: { username: "demo", newDevicePubHex: incDevicePubHex, issuedAt: Date.now() }, admitSig: "cd".repeat(64) });
  const bundleSealed = await aeadSeal(adminMat.kEncEncrypt, te.encode(realBundle)); // SAS-verified leg-1 key
  const incGetsBundle = nextMsg(incReturnWs, (m) => m.kind === "peer-deliver", 12000);
  adminLeg2Ws.send(JSON.stringify({ kind: "deliver", ...bundleSealed }));
  const incBundleFrame = await incGetsBundle;
  const incBundlePlain = td.decode(await aeadOpen(incMat.kEncDecrypt, incBundleFrame.ciphertext, incBundleFrame.nonce));
  const roundTripped = incBundlePlain === realBundle;
  rec("FIX leg-2: admin → incoming SEALED BUNDLE over the real relay (round-trip)",
    roundTripped ? "A" : "FAIL",
    roundTripped
      ? `incoming decrypted the EXACT bundle the admin sealed (${incBundlePlain.length} bytes) — full device-add CAN complete with the two-leg fix`
      : `bundle mismatch — sent ${realBundle.length}B, got "${incBundlePlain.slice(0, 60)}…"`);

  for (const ws of [adminWs, incWs, incReturnWs, adminLeg2Ws]) { try { ws.close(); } catch { /* */ } }

  const allA = findings.filter((f) => ["SAS PARITY", "FIX leg-1", "FIX leg-2"].some((s) => f.step.startsWith(s))).every((f) => f.grade === "A");
  writeFileSync(join(SHOT_DIR, "relay-probe-findings.json"), JSON.stringify({
    relayHost: RELAY_HOST, sasMatch, bugConfirmed: bugReject?.kind === "error", twoLegFixWorks: roundTripped, findings,
  }, null, 2));
  log(`\n[relay-probe] DONE — SAS parity=${sasMatch}; current-seal rejected=${bugReject?.kind === "error"}; two-leg fix round-trips=${roundTripped}`);
  process.exit(allA ? 0 : 1);
}

main().catch((e) => { log("relay-probe crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e))); process.exit(2); });
