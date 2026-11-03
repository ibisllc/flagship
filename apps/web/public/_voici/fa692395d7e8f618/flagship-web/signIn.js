// Sign in with Flagship (docs/voici-and-messages.md §6): a website gets a delegation from the visitor's Flagship app
// for a browser key B it made itself, over the existing `/qr-pipe` relay, so every later request is signed by B and
// checkable by anyone against public keys, with the visitor's app offline.
//
// The pipe (apps/com/src/buildRelay.ts) is one-way: the browser listens, the app sends exactly one sealed frame. So
// the browser's half of the request (B's public key and a nonce) rides in the link the app opens, next to the
// browser's ephemeral X25519 key, and the app's sealed answer must name both (`C:` note in the spec, §6.5):
//
//   https://<control apex>/voici-sign-in#s=<sid>&k=<browser X25519, b64url>&p=<pageId>&u=<username>
//                                        &d=<B, SEC1 hex>&n=<nonce hex>
//
// The fragment never reaches a server (it names a person, AGENTS "App links are https"). Both screens show the same
// 6-digit code (HKDF of the X25519 secret, the remote-ticket construction); the answer is AES-GCM under the key
// derived the same way, so the relay sees neither.
//
//   signInLink(o) / parseSignInLink(url)          the link (and its reader, for apps and tests)
//   pipeMaterial(sk, peerPkB64u) -> {sas, key}    X25519 + HKDF("flagship/qr/v1") → AES key + 6-digit code
//   startVoiciSignIn(o) -> {done, cancel}         the whole browser side; resolves the stored session
//   loadVoiciSession(store, pageId, o?)           a stored sign-in, or null (expired or damaged ones are dropped)
//   signOut(store, pageId)                        forget B, T and the delegation in this browser
//   listVoiciSessions(store)                      pageIds signed in here

import {
  checkVoiciSignInAnswer,
  checkWebDelegation,
  gcmOpen,
  hexToBytes,
  hkdfSha256,
  isLowerHex,
  x25519PublicKey,
  x25519Shared,
} from "./pipeCrypto.js";
import { createBrowserKey, randomHex } from "./envelope.js";

export const SIGN_IN_PATH = "/voici-sign-in";
export const SIGN_IN_REQUEST_KIND = "flagship/voici-sign-in-request/v1";
export const SIGN_IN_DEADLINE_MS = 10 * 60_000;
const SESSION_PREFIX = "voici-session:";
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const enc = (s) => new TextEncoder().encode(s);

export function b64uEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s) {
  if (typeof s !== "string" || !B64U.test(s)) throw new Error("bad base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function signInLink(o) {
  const q = new URLSearchParams({ s: o.sid, k: o.pkB64u, p: o.pageId, u: o.username, d: o.delegatePub, n: o.nonce });
  return `https://${o.apex}${SIGN_IN_PATH}#${q.toString()}`;
}

/** The app side's reader of a sign-in link: the request it must answer, or null. */
export function parseSignInLink(url, origin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.pathname !== SIGN_IN_PATH) return null;
  const q = new URLSearchParams(u.hash.replace(/^#/, ""));
  const sid = q.get("s") ?? "";
  const pk = q.get("k") ?? "";
  const pageId = q.get("p") ?? "";
  const username = q.get("u") ?? "";
  const delegatePub = q.get("d") ?? "";
  const nonce = q.get("n") ?? "";
  if (!B64U.test(sid) || sid.length > 64 || !B64U.test(pk) || !PAGE_ID.test(pageId) || !USERNAME.test(username)) return null;
  if (!isLowerHex(delegatePub, 65) || !delegatePub.startsWith("04") || !isLowerHex(nonce, 16)) return null;
  try {
    if (b64uDecode(pk).length !== 32) return null;
  } catch {
    return null;
  }
  return { sid, pkB64u: pk, request: { kind: SIGN_IN_REQUEST_KIND, origin, pageId, username, delegatePub, nonce } };
}

/** The pipe's shared material (same as the webapp's pairingRelay.js deriveMaterial). */
export function pipeMaterial(sk, peerPkB64u) {
  const peer = b64uDecode(peerPkB64u);
  if (peer.length !== 32) throw new Error("peer key must be 32 bytes");
  const shared = x25519Shared(sk, peer);
  const salt = enc("flagship/qr/v1");
  const key = hkdfSha256(shared, salt, enc("flagship/qr/enc/v1"), 32);
  const s = hkdfSha256(shared, salt, enc("flagship/qr/sas/v1"), 4);
  const u32 = ((s[0] << 24) | (s[1] << 16) | (s[2] << 8) | s[3]) >>> 0;
  return { key, sas: (u32 % 1_000_000).toString().padStart(6, "0") };
}

function codeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The browser side of the sign-in. o = {pageId, username, origin ("https://voi.ci"), apex (control apex), store,
 * caKeys? (authorized CA keys for the attestation; without them the attestation is checked against its own
 * signer, `.com` checks the CA chain on every send), WebSocketImpl?, secure? (default true), now?, onLink(link),
 * onCode(code), onWaiting()?, deadlineMs? (10 min)}. Each expiry of the relay session (5 min) starts a new one with a
 * new link (onLink again) until the deadline. B and the nonce stay the same across links.
 * `done` resolves the stored session; it rejects with an Error whose `code` is expired | cancelled | unreachable |
 * relay | malformed | bad-attestation | bad-delegation | bad-thread.
 */
export function startVoiciSignIn(o) {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  const now = o.now ?? (() => Date.now());
  const deadline = now() + (o.deadlineMs ?? SIGN_IN_DEADLINE_MS);
  let ws = null;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => {});
  const close = () => {
    try {
      ws?.close(1000, "done");
    } catch {
      /* ignore */
    }
    ws = null;
  };
  const finish = (ok, v) => {
    if (settled) return;
    settled = true;
    close();
    (ok ? resolveDone : rejectDone)(v);
  };

  (async () => {
    const b = await createBrowserKey();
    const nonce = randomHex(16);
    const request = { kind: SIGN_IN_REQUEST_KIND, origin: o.origin, pageId: o.pageId, username: o.username, delegatePub: b.delegatePub, nonce };

    const attempt = () => {
      if (settled) return;
      if (now() >= deadline) return finish(false, codeError("expired"));
      const sid = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
      const sk = crypto.getRandomValues(new Uint8Array(32));
      const pkB64u = b64uEncode(x25519PublicKey(sk));
      let key = null;
      let accepted = false;
      o.onLink?.(signInLink({ apex: o.apex, sid, pkB64u, pageId: o.pageId, username: o.username, delegatePub: b.delegatePub, nonce }));
      const socket = new WS(`${o.secure === false ? "ws" : "wss"}://${o.apex}/qr-pipe/${encodeURIComponent(sid)}?role=browser`);
      ws = socket;
      const restart = () => {
        if (ws !== socket || settled) return;
        close();
        attempt();
      };
      socket.addEventListener("message", async (ev) => {
        if (ws !== socket || typeof ev.data !== "string" || ev.data.length > 128 * 1024) return;
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!m || typeof m.kind !== "string") return;
        if (m.kind === "accepted") {
          accepted = true;
          o.onWaiting?.();
        } else if (m.kind === "peer-hello") {
          try {
            const mat = pipeMaterial(sk, m.phonePk);
            key = mat.key;
            o.onCode?.(mat.sas);
          } catch {
            /* a malformed hello: keep waiting for a real app */
          }
        } else if (m.kind === "peer-deliver") {
          if (!key) return;
          let answer;
          try {
            const pt = gcmOpen(key, b64uDecode(m.nonce), b64uDecode(m.ciphertext));
            answer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
          } catch {
            return finish(false, codeError("malformed"));
          }
          const caKeys = o.caKeys ?? (typeof answer?.attestation?.signedBy === "string" ? [answer.attestation.signedBy] : []);
          const r = checkVoiciSignInAnswer(answer, { request, caKeys, now: now() });
          if (!r.ok) return finish(false, codeError(r.code));
          const session = {
            v: 1,
            pageId: o.pageId,
            username: o.username,
            origin: o.origin,
            privateKey: b.privateKey,
            delegatePub: b.delegatePub,
            pseudonymPub: r.answer.pseudonymPub,
            attestation: r.answer.attestation,
            delegation: r.answer.delegation,
            delegationSig: r.answer.delegationSig,
            threadStmt: r.answer.threadStmt,
            threadSig: r.answer.threadSig,
            threadSeed: r.answer.threadSeed,
            savedAt: now(),
          };
          try {
            await o.store.put(SESSION_PREFIX + o.pageId, session);
          } catch {
            /* kept for this tab only */
          }
          finish(true, session);
        } else if (m.kind === "rebind" || m.kind === "expired") {
          restart();
        } else if (m.kind === "error") {
          finish(false, codeError("relay"));
        }
      });
      socket.addEventListener("close", () => {
        if (ws !== socket || settled) return;
        if (accepted) restart();
        else finish(false, codeError("unreachable"));
      });
    };
    attempt();
  })().catch(() => finish(false, codeError("unreachable")));

  return { done, cancel: () => finish(false, codeError("cancelled")) };
}

function sessionShapeOk(s) {
  return (
    s &&
    typeof s === "object" &&
    s.v === 1 &&
    PAGE_ID.test(s.pageId) &&
    USERNAME.test(s.username) &&
    typeof s.origin === "string" &&
    s.privateKey &&
    isLowerHex(s.delegatePub, 65) &&
    isLowerHex(s.pseudonymPub, 32) &&
    isLowerHex(s.threadSeed, 32) &&
    s.threadStmt &&
    isLowerHex(s.threadStmt.threadPub ?? "")
  );
}

/** A usable stored sign-in for this page: shape, B still matches the delegation, the delegation still valid. */
export async function loadVoiciSession(store, pageId, o = {}) {
  const now = o.now ?? Date.now();
  let s = null;
  try {
    s = await store.get(SESSION_PREFIX + pageId);
  } catch {
    return null;
  }
  if (!s) return null;
  const ok =
    sessionShapeOk(s) &&
    s.pageId === pageId &&
    s.delegation?.delegatePub === s.delegatePub &&
    checkWebDelegation(s.delegation, s.delegationSig, {
      scope: "voici-messages",
      origin: o.origin ?? s.origin,
      audience: pageId,
      principalPub: s.pseudonymPub,
      now,
    }).ok;
  if (!ok) {
    await signOut(store, pageId);
    return null;
  }
  return s;
}

export async function signOut(store, pageId) {
  try {
    await store.delete(SESSION_PREFIX + pageId);
  } catch {
    /* nothing kept */
  }
}

export async function listVoiciSessions(store) {
  return (await store.keys(SESSION_PREFIX)).map((k) => k.slice(SESSION_PREFIX.length));
}

export const threadSeedOf = (session) => hexToBytes(session.threadSeed);
