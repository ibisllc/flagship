// Pairing with the owner's phone (docs/browser-extension.md "As built"): the Remote ceremony's /qr-pipe relay
// (apps/web/public/webapp/lib/companionDockStart.js), with its own link and payload.
//
//   1. The extension opens a relay session as `browser` and shows https://<control apex>/pair-extension?s=&k=.
//   2. The phone scans it, joins as `phone`; both screens show the same 6-digit code.
//   3. The owner picks a server and approves (biometric). The phone mints a single-use EXTENSION ticket on that
//      server and seals {kind: flagship/extension-pair/v1, ticket, server, the server key the PHONE pinned} to the
//      extension under the code-checked key.
//   4. The extension redeems the ticket on that server for its session, which reads only the box's signed
//      certificate fingerprint. Nothing it keeps can sign anything as the owner.
//
// The state machine is pure (`next`), so tests drive it without a socket.

import { CONTROL_APEX, DATA_APEX } from "./config.js";

export const PAIR_PATH = "/pair-extension";
export const EXTENSION_PAIR_KIND = "flagship/extension-pair/v1";

/** The link the QR carries. sid and the key name only a relay session: no account, no server. */
export function pairingUrl({ sid, pkB64u }, controlApex = CONTROL_APEX) {
  return `https://${controlApex}${PAIR_PATH}?${new URLSearchParams({ s: sid, k: pkB64u })}`;
}

/**
 * The phone's sealed payload, validated, or an error code. The server must be a box name under the data apex
 * and the payload must name it twice the same way, so a replayed QR can't point the extension anywhere else.
 * A Remote ticket (`flagship/remote-ticket/v1`) is refused: it would open a full Remote session.
 */
export function parsePairPayload(text, { dataApex = DATA_APEX } = {}) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: "unreadable" }; }
  if (!obj || typeof obj !== "object") return { ok: false, error: "unreadable" };
  if (obj.kind !== EXTENSION_PAIR_KIND) return { ok: false, error: obj.kind === "flagship/remote-ticket/v1" ? "remote-ticket" : "unreadable" };
  const ticketId = String(obj.ticketId ?? "");
  const ticketSecret = String(obj.ticketSecret ?? "");
  const username = String(obj.username ?? "");
  const serverDomain = String(obj.serverDomain ?? "");
  const stkPubHex = String(obj.stkPubHex ?? "");
  if (!/^[0-9a-f]{32}$/.test(ticketId) || !/^[0-9a-f]{64}$/.test(ticketSecret)) return { ok: false, error: "bad-ticket" };
  if (!/^[a-z0-9](?:-?[a-z0-9]){0,31}$/.test(username)) return { ok: false, error: "bad-account" };
  if (!/^[0-9a-f]{64}$/.test(stkPubHex)) return { ok: false, error: "bad-key" };
  let url;
  try { url = new URL(String(obj.podBaseUrl ?? "")); } catch { url = null; }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const boxName = new RegExp(`^${label}\\.${username.replace(/-/g, "\\-")}\\.${dataApex.replace(/\./g, "\\.")}$`);
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.port || url.username
      || url.hostname !== serverDomain || !boxName.test(serverDomain)) {
    return { ok: false, error: "bad-server" };
  }
  return { ok: true, payload: { ticketId, ticketSecret, username, serverDomain, stkPubHex, podBaseUrl: `https://${serverDomain}` } };
}

/**
 * The pairing state machine. States:
 *   idle → connecting → waiting (QR shown) → matching (code shown) → redeeming → paired
 * and failed (with a reason the page shows) or expired (show a fresh QR) from any live state.
 */
export function initialState() {
  return { phase: "idle" };
}

export function next(state, event) {
  switch (event.type) {
    case "start":
      return { phase: "connecting" };
    case "opened":
      return state.phase === "connecting" ? { phase: "waiting", url: event.url } : state;
    case "peer-hello":
      // A second phone may join after the first; each gets its own code, as in Remote.
      return state.phase === "waiting" || state.phase === "matching" ? { phase: "matching", url: state.url, code: event.code } : state;
    case "delivered":
      if (state.phase !== "matching") return state;
      return event.ok ? { phase: "redeeming", server: event.payload.serverDomain } : { phase: "failed", reason: event.error };
    case "redeemed":
      if (state.phase !== "redeeming") return state;
      return event.ok ? { phase: "paired", server: state.server } : { phase: "failed", reason: event.error };
    case "expired":
      return live(state) ? { phase: "expired" } : state;
    case "closed":
      return live(state) && state.phase !== "redeeming" ? { phase: "failed", reason: event.accepted ? "relay-closed" : "unreachable" } : state;
    case "cancel":
      return { phase: "idle" };
    default:
      return state;
  }
}

function live(state) {
  return state.phase === "connecting" || state.phase === "waiting" || state.phase === "matching" || state.phase === "redeeming";
}

/**
 * The box's answer to the ticket. Only an extension session is kept: a reply without `scope: "extension"`
 * would be some other kind of session, and the extension drops it unused.
 */
export function parseRedeemReply(body, payload, now) {
  if (!body || typeof body !== "object") return { ok: false, error: "redeem-failed" };
  if (body.scope !== "extension") return { ok: false, error: "not-extension-session" };
  const token = String(body.companionSessionToken ?? "");
  if (!/^[0-9a-f]{64}$/.test(token)) return { ok: false, error: "redeem-failed" };
  const expiresAt = Number(body.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, error: "redeem-failed" };
  return {
    ok: true,
    box: {
      serverDomain: payload.serverDomain,
      username: payload.username,
      stkPubHex: payload.stkPubHex,
      token,
      tokenExpiresAt: expiresAt,
      pairedAt: now,
      session: "active",
      evidence: null,
    },
  };
}

// ── relay crypto: the same derivation as the webapp's lib/pairingRelay.js and the phones' QrRelay ──

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(b64u) {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function freshSid(cryptoImpl = globalThis.crypto) {
  return b64urlEncode(cryptoImpl.getRandomValues(new Uint8Array(16)));
}

export async function freshKeypair(cryptoImpl = globalThis.crypto) {
  const kp = await cryptoImpl.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pkRaw = new Uint8Array(await cryptoImpl.subtle.exportKey("raw", kp.publicKey));
  return { sk: kp.privateKey, pkB64u: b64urlEncode(pkRaw) };
}

/** The 6-digit code and the decryption key, from this side's key and the phone's. */
export async function deriveMaterial(mySk, peerPkB64u, subtle = globalThis.crypto.subtle) {
  const peer = b64urlDecode(peerPkB64u);
  if (peer.length !== 32) throw new Error("peer key must be 32 bytes");
  const peerKey = await subtle.importKey("raw", peer, { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: peerKey }, mySk, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const expand = async (info, bits) =>
    new Uint8Array(await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("flagship/qr/v1"), info: new TextEncoder().encode(info) },
      base,
      bits,
    ));
  const kEnc = await expand("flagship/qr/enc/v1", 256);
  const sasBytes = await expand("flagship/qr/sas/v1", 32);
  const u32 = ((sasBytes[0] << 24) | (sasBytes[1] << 16) | (sasBytes[2] << 8) | sasBytes[3]) >>> 0;
  const code = (u32 % 1_000_000).toString().padStart(6, "0");
  const key = await subtle.importKey("raw", kEnc, "AES-GCM", false, ["decrypt"]);
  return { code, key };
}

export async function aeadOpen(key, ciphertextB64u, nonceB64u, subtle = globalThis.crypto.subtle) {
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(nonceB64u) }, key, b64urlDecode(ciphertextB64u));
  return new TextDecoder().decode(plain);
}
