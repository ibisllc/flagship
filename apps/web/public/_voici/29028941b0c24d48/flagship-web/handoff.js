// Calling from the Flagship app with this browser's WebRTC (docs/voici-calls.md "Calling from the app"): when the
// app has no media engine, it opens `https://voi.ci/<callee>#call=<sid>.<k>` and delivers a short-lived session for
// the callee's page over `/qr-pipe` (proto/lib/voiciCallHandoff.js holds the bytes). The page reads the fragment,
// drops it from the address bar at once, listens on the pipe as the browser, opens the delivery with k and checks it
// as a sign-in. The session lives in this tab only (never stored), for the one call.
//
//   takeVoiciCallHandoffFragment(win) -> hash | null    reads `#call=…` and removes it from the address bar
//   receiveVoiciCallHandoff(o) -> {done, cancel}         o = {hash, username, origin, apex, secure?, caKeys?,
//                                                        WebSocketImpl?, now?, timeoutMs? (60 s), subtle?}
//   `done` resolves {session, media}; it rejects with an Error whose `code` is malformed | used | expired |
//   unreachable | relay | cancelled | bad-key | wrong-page | bad-attestation | bad-delegation | bad-thread.

import { checkVoiciCallHandoff, openVoiciCallHandoff, parseVoiciCallHandoffFragment } from "./proto/lib/voiciCallHandoff.js";
import { hexToBytes } from "./proto/lib/voiciCore.js";

export { parseVoiciCallHandoffFragment };

const codeError = (code) => Object.assign(new Error(code), { code });

const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The handoff fragment of this page's address, removed from the address bar (and history) before anything else. */
export function takeVoiciCallHandoffFragment(win) {
  const hash = win?.location?.hash ?? "";
  if (!hash.startsWith("#call=")) return null;
  try {
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
  } catch {
    /* the fragment stays, the pipe session is one-use anyway */
  }
  return hash;
}

/** The delegate's private key as a non-extractable WebCrypto key (JWK from the scalar and its public point). */
async function importDelegate(delegatePriv, delegatePub, subtle) {
  const pub = hexToBytes(delegatePub);
  const jwk = { kty: "EC", crv: "P-256", d: b64u(hexToBytes(delegatePriv)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), ext: false };
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export function receiveVoiciCallHandoff(o) {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  const now = o.now ?? (() => Date.now());
  const subtle = o.subtle ?? globalThis.crypto.subtle;
  let ws = null;
  let settled = false;
  let timer = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => {});
  const finish = (ok, v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      ws?.close(1000, "done");
    } catch {
      /* ignore */
    }
    (ok ? resolveDone : rejectDone)(v);
  };
  const frag = parseVoiciCallHandoffFragment(o.hash ?? "");
  if (!frag) {
    finish(false, codeError("malformed"));
    return { done, cancel: () => {} };
  }
  timer = setTimeout(() => finish(false, codeError("expired")), o.timeoutMs ?? 60_000);
  let phonePk = null;
  try {
    ws = new WS(`${o.secure === false ? "ws" : "wss"}://${o.apex}/qr-pipe/${encodeURIComponent(frag.sid)}?role=browser`);
  } catch {
    finish(false, codeError("unreachable"));
    return { done, cancel: () => {} };
  }
  let accepted = false;
  ws.addEventListener("message", async (ev) => {
    if (settled || typeof ev.data !== "string" || ev.data.length > 128 * 1024) return;
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || typeof m.kind !== "string") return;
    if (m.kind === "accepted") accepted = true;
    else if (m.kind === "peer-hello") phonePk = typeof m.phonePk === "string" ? m.phonePk : null;
    else if (m.kind === "peer-deliver") {
      if (!phonePk) return finish(false, codeError("malformed"));
      const raw = openVoiciCallHandoff(frag.browserSecret, { phonePk, nonce: m.nonce, ciphertext: m.ciphertext });
      if (!raw) return finish(false, codeError("malformed"));
      const signer = raw?.signIn?.attestation?.signedBy;
      const caKeys = o.caKeys ?? (typeof signer === "string" ? [signer] : []);
      const r = checkVoiciCallHandoff(raw, { origin: o.origin, caKeys, now: now(), username: o.username });
      if (!r.ok) return finish(false, codeError(r.code));
      let privateKey;
      try {
        privateKey = await importDelegate(r.handoff.delegatePriv, r.delegatePub, subtle);
      } catch {
        return finish(false, codeError("bad-key"));
      }
      const a = r.handoff.signIn;
      finish(true, {
        media: r.handoff.media,
        session: {
          v: 1,
          pageId: r.handoff.pageId,
          username: r.handoff.username,
          origin: o.origin,
          privateKey,
          delegatePub: r.delegatePub,
          pseudonymPub: a.pseudonymPub,
          attestation: a.attestation,
          delegation: a.delegation,
          delegationSig: a.delegationSig,
          threadStmt: a.threadStmt,
          threadSig: a.threadSig,
          threadSeed: a.threadSeed,
          savedAt: now(),
          handoff: true,
        },
      });
    } else if (m.kind === "rebind") finish(false, codeError("used"));
    else if (m.kind === "expired") finish(false, codeError("expired"));
    else if (m.kind === "error") finish(false, codeError("relay"));
  });
  ws.addEventListener("close", () => finish(false, codeError(accepted ? "expired" : "unreachable")));
  return { done, cancel: () => finish(false, codeError("cancelled")) };
}
