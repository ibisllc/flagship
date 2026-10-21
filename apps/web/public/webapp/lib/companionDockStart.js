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
import { redeemCompanionAndPersist } from "./companionReceiver.js";
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
  let url;
  try { url = new URL(String(obj.podBaseUrl ?? "")); } catch { url = null; }
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.port
      || !url.hostname.endsWith(`.${apex}`)) {
    throw new Error(tr("The phone named a server this page won't connect to"));
  }
  return { ticketId, ticketSecret, podBaseUrl: `https://${url.hostname}`, username };
}

/**
 * Open a relay session and wait for the phone.
 *   onCode(code) fires each time a phone joins (the code to compare).
 * Resolves `delivered` with the validated ticket; rejects with
 * `{ restart: true }` when the session simply ran out, so the caller can show
 * a fresh QR without an error.
 */
export async function openRemoteRequest({
  onCode,
  WebSocketImpl = globalThis.WebSocket,
  relayHost = controlHost(),
  secure = globalThis.location?.protocol !== "http:",
  apex,
} = {}) {
  const sid = freshSid();
  const { sk, pkB64u } = await freshKeypair();
  const ws = new WebSocketImpl(`${secure ? "wss" : "ws"}://${relayHost}/qr-pipe/${encodeURIComponent(sid)}?role=browser`);
  let key = null;
  let accepted = false;
  let settled = false;
  let resolveDelivered;
  let rejectDelivered;
  const delivered = new Promise((res, rej) => { resolveDelivered = res; rejectDelivered = rej; });
  delivered.catch(() => {});
  const finish = (fn, arg) => {
    if (settled) return;
    settled = true;
    try { ws.close(1000, "done"); } catch { /* ignore */ }
    fn(arg);
  };
  const restart = (message) => Object.assign(new Error(message), { restart: true });
  ws.addEventListener("message", async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.kind !== "string") return;
    if (m.kind === "accepted") {
      accepted = true;
    } else if (m.kind === "peer-hello") {
      try {
        const mat = await deriveMaterial(sk, m.phonePk);
        key = mat.kEncDecrypt;
        onCode?.(mat.sas);
      } catch { /* a malformed hello; wait for a real phone */ }
    } else if (m.kind === "peer-deliver") {
      if (!key) return;
      try {
        const plain = await aeadOpen(key, m.ciphertext, m.nonce);
        finish(resolveDelivered, parseRemoteTicket(new TextDecoder().decode(plain), apex ? { apex } : {}));
      } catch (error) {
        finish(rejectDelivered, error instanceof Error ? error : new Error(String(error)));
      }
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
    close: () => finish(rejectDelivered, restart("closed")),
  };
}

/** Redeem the ticket on its server and store the keyless remote profile. */
export async function redeemRemoteTicket(ticket, deps) {
  const result = await redeemCompanionAndPersist(ticket, deps);
  if (result.error) throw new Error(result.error);
  return result;
}
