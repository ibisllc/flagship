// The browser side of the remote ceremony.
//
// The page shows a QR straight away: https://<apex>/remote?s=<sid>&k=<pk>, where
// sid names a QR-relay session and pk is this browser's ephemeral X25519 key.
// The phone scans it, joins the relay as the phone, and both screens show the
// same 6-digit code. When the owner approves, the phone mints a single-use
// companion ticket on the server they picked and seals it to this browser;
// the browser redeems it on that server. The browser never names an account,
// and the relay never sees the account, the server or the ticket.

import { appLinkUrl, controlHost, dataApex } from "./apex.js";
import { redeemCompanionAndPersist, serverOriginOnApex } from "./companionReceiver.js";
import { aeadOpen, deriveMaterial, freshKeypair, freshSid } from "./pairingRelay.js";

import { tr } from "./i18n.js";
export const REMOTE_TICKET_KIND = "flagship/remote-ticket/v1";

export function buildRemoteApprovalUrl({ sid, pkB64u }) {
  return appLinkUrl("/remote", { s: sid, k: pkB64u });
}

/** Validate the phone's sealed payload. The server must be on the data apex,
 *  so a scanned-and-replayed QR can't point this browser anywhere else. */
export function parseRemoteTicket(text, { apex = dataApex() } = {}) {
  let obj;
  try { obj = JSON.parse(text); } catch { obj = null; }
  if (!obj || obj.kind !== REMOTE_TICKET_KIND) throw new Error(tr("The phone sent something this page can't read"));
  const ticketId = String(obj.ticketId ?? "").toLowerCase();
  const ticketSecret = String(obj.ticketSecret ?? "").toLowerCase();
  const username = String(obj.username ?? "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(ticketId) || !/^[0-9a-f]{64}$/.test(ticketSecret)) {
    throw new Error(tr("The phone sent an invalid ticket"));
  }
  if (!/^[a-z0-9](?:-?[a-z0-9]){0,31}$/.test(username)) throw new Error(tr("The phone sent an invalid account"));
  const podBaseUrl = serverOriginOnApex(obj.podBaseUrl, apex);
  if (!podBaseUrl) throw new Error(tr("The phone named a server this page won't connect to"));
  return { ticketId, ticketSecret, podBaseUrl, username };
}

/** How long the page waits for the person to say the codes match. */
export const REMOTE_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Open a relay session and wait for the phone.
 *   onCode(code) fires each time a phone joins (the code to compare).
 * The relay gives the phone slot to whoever connects first, so the code is the
 * only thing that tells the real phone from someone else holding the QR. A
 * ticket is opened only after confirmCode(): one that arrives earlier is held,
 * and rejectCode() or REMOTE_CONFIRM_TIMEOUT_MS without an answer drops it.
 * Resolves `delivered` with the validated ticket; rejects with
 * `{ restart: true }` when the session simply ran out, so the caller can show
 * a fresh QR without an error (`declined` / `unconfirmed` say why).
 */
export async function openRemoteRequest({
  onCode,
  WebSocketImpl = globalThis.WebSocket,
  relayHost = controlHost(),
  secure = globalThis.location?.protocol !== "http:",
  apex,
  confirmTimeoutMs = REMOTE_CONFIRM_TIMEOUT_MS,
} = {}) {
  const sid = freshSid();
  const { sk, pkB64u } = await freshKeypair();
  const ws = new WebSocketImpl(`${secure ? "wss" : "ws"}://${relayHost}/qr-pipe/${encodeURIComponent(sid)}?role=browser`);
  let key = null;
  let phonePk = null;
  let confirmed = false;
  let held = null;
  let confirmTimer = null;
  let accepted = false;
  let settled = false;
  let resolveDelivered;
  let rejectDelivered;
  const delivered = new Promise((res, rej) => { resolveDelivered = res; rejectDelivered = rej; });
  delivered.catch(() => {});
  const stopTimer = () => {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
  };
  const finish = (fn, arg) => {
    if (settled) return;
    settled = true;
    stopTimer();
    held = null;
    try { ws.close(1000, "done"); } catch { /* ignore */ }
    fn(arg);
  };
  const restart = (message, extra = {}) => Object.assign(new Error(message), { restart: true }, extra);
  const openTicket = async (frame) => {
    try {
      const plain = await aeadOpen(frame.key, frame.ciphertext, frame.nonce);
      finish(resolveDelivered, parseRemoteTicket(new TextDecoder().decode(plain), apex ? { apex } : {}));
    } catch (error) {
      finish(rejectDelivered, error instanceof Error ? error : new Error(String(error)));
    }
  };
  ws.addEventListener("message", async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.kind !== "string" || settled) return;
    if (m.kind === "accepted") {
      accepted = true;
    } else if (m.kind === "peer-hello") {
      if (phonePk !== null && m.phonePk === phonePk) return;
      try {
        const mat = await deriveMaterial(sk, m.phonePk);
        if (settled) return;
        // A new phone key means a new code: anything said about the old one no longer counts.
        phonePk = m.phonePk;
        key = mat.kEncDecrypt;
        confirmed = false;
        held = null;
        stopTimer();
        confirmTimer = setTimeout(() => finish(rejectDelivered, restart(tr("The code wasn't confirmed in time"), { unconfirmed: true })), confirmTimeoutMs);
        onCode?.(mat.sas);
      } catch { /* a malformed hello; wait for a real phone */ }
    } else if (m.kind === "peer-deliver") {
      if (!key) return;
      const frame = { key, ciphertext: m.ciphertext, nonce: m.nonce };
      if (confirmed) await openTicket(frame);
      else held = frame;
    } else if (m.kind === "rebind" || m.kind === "expired") {
      finish(rejectDelivered, restart(tr("This code expired")));
    } else if (m.kind === "error") {
      finish(rejectDelivered, new Error(tr("Relay: {0}", m.reason ?? "error")));
    }
  });
  ws.addEventListener("close", () => finish(rejectDelivered, accepted
    ? restart(tr("Connection to the relay closed"))
    : new Error(tr("Couldn't reach Flagship. Check your connection and start again."))));
  return {
    approvalUrl: buildRemoteApprovalUrl({ sid, pkB64u }),
    delivered,
    /** The person says the phone shows the same code. */
    confirmCode: async () => {
      if (settled || !key || confirmed) return;
      confirmed = true;
      stopTimer();
      const frame = held;
      held = null;
      if (frame) await openTicket(frame);
    },
    /** The person says the codes differ: drop anything the phone sent and end the session. */
    rejectCode: () => finish(rejectDelivered, restart(tr("The codes didn't match"), { declined: true })),
    close: () => finish(rejectDelivered, restart("closed")),
  };
}

/** The server page a just-approved remote opens: the one the phone connected it to. */
export function remoteLandingFqdn(persisted) {
  try {
    return new URL(String(persisted?.podBaseUrl ?? "")).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Redeem the ticket on its server and store the keyless remote profile. */
export async function redeemRemoteTicket(ticket, deps) {
  const result = await redeemCompanionAndPersist(ticket, deps);
  if (result.error) throw new Error(result.error);
  return result;
}
