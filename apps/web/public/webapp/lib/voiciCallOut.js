// Calling from the webapp (docs/voici-calls.md "Calling from the app"): this account calls a page it knows (one it
// signed in to as a visitor) with the browser's own WebRTC, in a voi.ci tab the webapp hands the call to. The webapp
// signs a short-lived voi.ci session for that page (its pseudonym there, a delegation to a P-256 key made for this
// one call), opens `https://voi.ci/<callee>#call=<sid>.<k>` and delivers the session over /qr-pipe, sealed under the
// pipe key (lib/voiciCallHandoff.js). The call history is this browser's own record (never synced, no server log)
// plus the page's missed calls.
//
//   startHandoffCall(page {pageId, username}, media, deps?)   opens the tab and delivers; records the call
//   callHistory(missedCalls, deps?)                           newest first: missed (incoming) and placed (outgoing)
//   recordCall(entry, deps?) / clearCallHistory(account, storage?)
//   callVisitor(conv)                                         the owner calling a pseudonymous visitor: a hook only,
//                                                             pending the owner's decision (ring by opt-in, or a
//                                                             "tried to call you" note the visitor dials back from)

import { p256 } from "../vendor/noble-post-quantum/pq-seal.js";
import { hex } from "./voiciCore.js";
import { signVoiciThreadStatement, signWebDelegation, TAG_VOICI_SIGN_IN } from "./voiciProtocol.js";
import { sealVoiciCallHandoff, TAG_VOICI_CALL_HANDOFF, VOICI_CALL_HANDOFF_SESSION_MS, voiciCallHandoffLink } from "./voiciCallHandoff.js";
import { getAttestation, pagePseudonym } from "./voiciSignIn.js";
import { voiciWebOrigin, VoiciError } from "./voiciOwner.js";
import { controlHost } from "./apex.js";
import { getSession } from "./state.js";

const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const HISTORY_MAX = 200;
const historyKey = (account) => `flagship.voici.calls.v1.${account}`;
const accountOf = (deps) => String((deps.session ?? getSession())?.username ?? "").toLowerCase();

const b64u = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function readHistory(account, storage) {
  try {
    const list = JSON.parse(storage?.getItem(historyKey(account)) ?? "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string" && Number.isSafeInteger(r.at) && r.peer?.kind === "page" && PAGE_ID.test(r.peer.pageId ?? "") && USERNAME.test(r.peer.username ?? "")) : [];
  } catch {
    return [];
  }
}

/** Adds one placed call to this browser's history (kept per account, newest 200). */
export function recordCall(entry, deps = {}) {
  const storage = deps.storage ?? globalThis.localStorage;
  const account = accountOf(deps);
  if (!account) return;
  const list = [entry, ...readHistory(account, storage).filter((r) => r.id !== entry.id)].slice(0, HISTORY_MAX);
  try {
    storage?.setItem(historyKey(account), JSON.stringify(list));
  } catch {
    /* the history is a courtesy */
  }
}

export function clearCallHistory(account, storage = globalThis.localStorage) {
  try {
    storage?.removeItem(historyKey(String(account ?? "").toLowerCase()));
  } catch {
    /* nothing kept */
  }
}

/**
 * The call history: this browser's placed calls and the page's missed calls (from the world's missed-call fetch),
 * newest first. Rows: {id, at, direction "in"|"out", outcome "missed"|"browser", video, peer {kind:"page", username,
 * pageId} | {kind:"visitor", conv, pseudonymPub}}. Only page peers can be called from here.
 */
export function callHistory(missedCalls = [], deps = {}) {
  const storage = deps.storage ?? globalThis.localStorage;
  const placed = readHistory(accountOf(deps), storage);
  const missed = (Array.isArray(missedCalls) ? missedCalls : []).map((m) => ({
    id: `missed:${m.callId}`,
    at: m.ringingAt,
    direction: "in",
    outcome: "missed",
    video: !!m.video,
    peer: { kind: "visitor", conv: m.conv, pseudonymPub: m.pseudonymPub },
  }));
  return [...placed, ...missed].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** The owner calling a pseudonymous visitor back: not built until the owner decides how (docs/voici-calls.md). */
export function callVisitor(_conv) {
  return { ok: false, code: "pending-owner-decision" };
}

function randomScalar() {
  const u = p256.utils;
  return (u.randomSecretKey ?? u.randomPrivateKey)();
}

/** The handoff for `page` (exported for tests): a session lasting at most 9 minutes, the handoff at most 4. */
export async function buildHandoff(page, media, deps = {}) {
  const session = deps.session ?? getSession();
  const now = (deps.now ?? Date.now)();
  const origin = deps.origin ?? voiciWebOrigin();
  const { p, t } = pagePseudonym(session.umk, page.pageId);
  const pseudonymPub = hex(p.publicKey);
  const attestation = await (deps.getAttestation ?? getAttestation)(page.pageId, pseudonymPub, deps);
  const delegatePriv = deps.delegatePriv ?? randomScalar();
  const delegation = {
    scope: "voici-messages",
    origin,
    audience: page.pageId,
    principalPub: pseudonymPub,
    delegateAlg: "p256",
    delegatePub: hex(p256.getPublicKey(delegatePriv, false)),
    issuedAt: now,
    expiresAt: Math.min(attestation.expiresAt, now + VOICI_CALL_HANDOFF_SESSION_MS - 60_000),
    nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
  };
  const threadStmt = { pageId: page.pageId, pseudonymPub, threadPub: hex(t.publicKey), issuedAt: now };
  const signIn = {
    kind: TAG_VOICI_SIGN_IN,
    pageId: page.pageId,
    pseudonymPub,
    attestation,
    delegation,
    delegationSig: signWebDelegation(delegation, p.seed),
    threadStmt,
    threadSig: signVoiciThreadStatement(threadStmt, p.seed),
    threadSeed: hex(t.seed),
  };
  return { kind: TAG_VOICI_CALL_HANDOFF, username: page.username, pageId: page.pageId, media, issuedAt: now, expiresAt: now + 4 * 60_000, delegatePriv: hex(delegatePriv), signIn };
}

/** Says hello on the pipe until the voi.ci tab listens, then delivers once. Resolves when the relay says delivered. */
export function deliverHandoff(sid, sealed, deps = {}) {
  const WS = deps.WebSocket ?? globalThis.WebSocket;
  const host = deps.host ?? controlHost();
  const proto = typeof location !== "undefined" && location.protocol === "http:" ? "ws" : "wss";
  const deadline = (deps.now ?? Date.now)() + (deps.timeoutMs ?? 60_000);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if ((deps.now ?? Date.now)() > deadline) return reject(new VoiciError("handoff-timeout"));
      const ws = new WS(`${proto}://${host}/qr-pipe/${encodeURIComponent(sid)}?role=phone`);
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {
          /* closed */
        }
        setTimeout(attempt, deps.retryMs ?? 500);
      };
      ws.addEventListener("open", () => ws.send(JSON.stringify({ kind: "hello", phonePk: sealed.phonePk })));
      ws.addEventListener("message", (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m?.kind === "peer-missing") retry();
        else if (m?.kind === "ack") ws.send(JSON.stringify({ kind: "deliver", nonce: sealed.nonce, ciphertext: sealed.ciphertext }));
        else if (m?.kind === "delivered") {
          done = true;
          ws.close();
          resolve();
        } else if (m?.kind === "error" || m?.kind === "expired") {
          done = true;
          ws.close();
          reject(new VoiciError("handoff-failed"));
        }
      });
      ws.addEventListener("error", retry);
    };
    attempt();
  });
}

/**
 * Calls `page` from a new voi.ci tab. Call it from the click itself: the tab is opened at once (a popup opened after
 * an await is blocked), then sent to the link once the session is signed.
 */
export async function startHandoffCall(page, media = "audio", deps = {}) {
  if (!PAGE_ID.test(page?.pageId ?? "") || !USERNAME.test(page?.username ?? "")) throw new VoiciError("bad-request");
  const win = (deps.open ?? ((u, n) => globalThis.open(u, n)))("", "_blank");
  if (!win) throw new VoiciError("popup-blocked");
  try {
    const handoff = await buildHandoff(page, media, deps);
    const browserSecret = crypto.getRandomValues(new Uint8Array(32));
    const sid = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const sealed = sealVoiciCallHandoff(handoff, crypto.getRandomValues(new Uint8Array(32)), browserSecret);
    const link = voiciCallHandoffLink({ host: new URL(deps.origin ?? voiciWebOrigin()).host, username: page.username, sid, browserSecret });
    try {
      win.opener = null;
    } catch {
      /* cross-origin already */
    }
    win.location.replace(link);
    browserSecret.fill(0);
    recordCall({ id: sid, at: handoff.issuedAt, direction: "out", outcome: "browser", video: media === "audio,video", peer: { kind: "page", username: page.username, pageId: page.pageId } }, deps);
    await deliverHandoff(sid, sealed, deps);
  } catch (e) {
    try {
      win.close();
    } catch {
      /* already gone */
    }
    throw e;
  }
}

export const isCallablePeer = (peer) => peer?.kind === "page" && PAGE_ID.test(peer.pageId ?? "") && USERNAME.test(peer.username ?? "");
