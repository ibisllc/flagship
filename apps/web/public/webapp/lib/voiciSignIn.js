// "Sign in with Flagship" from the webapp: this browser as the visitor's approving device
// (docs/voici-and-messages.md §6, §9.5 slow tier, §11.4). A voi.ci tab shows
// `https://<control apex>/voici-sign-in#s=<sid>&k=<browser X25519>&p=<pageId>&u=<username>&d=<browser key B>&n=<nonce>`
// (the "C:" link of §6.5, read the same way as flagship-web's parseSignInLink); the visitor opens it here (or pastes
// it). The request comes from the link itself; this device joins the voi.ci tab's `/qr-pipe` as `phone`, both sides
// show the same 6-digit code, and on Approve it derives the page's pseudonym P and thread key T, gets `.com`'s
// attestation for P (the webapp has no App Attest or Play Integrity, so `deviceCheckRef` is "none": the slow tier),
// signs the delegation to B and the thread statement, and seals its one answer back on the pipe.

import {
  canonicalMessagesKeyAttestationRequest,
  checkMessagesKeyAttestation,
  deriveMessagesPseudonymKey,
  deriveMessagesSecret,
  deriveMessagesThreadKey,
  ed25519SignHex,
  hex,
  messagesAttestationHash,
  parseMessagesKeyAttestation,
  signVoiciThreadStatement,
  signWebDelegation,
  signWebDelegationRevoke,
  TAG_VOICI_SIGN_IN,
  TAG_VOICI_SIGN_IN_REQUEST,
} from "./voiciProtocol.js";
import { appLinkParams, controlHost, isAppLink } from "./apex.js";
import { deriveMaterial, freshKeypair } from "./pairingRelay.js";
import { caKeysNow, deviceHeaders, fetchAccountKeys, verifyPublishedIndex, updateMessagesState, voiciWebOrigin, VoiciError } from "./voiciOwner.js";
import { getSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { controlApex } from "./apex.js";
import { deriveAccountDeviceSeedFromSeed } from "../keystore.js";

export const VOICI_SIGN_IN_PATH = "/voici-sign-in";
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const PK = /^[A-Za-z0-9_-]{43}$/;
const RENEW_MARGIN_MS = 86_400_000;
const RENEW_GRACE_MS = 7 * 86_400_000;

/**
 * The sign-in link's fields and the request they make, or null when `text` isn't one (a pasted link, or this tab's
 * own address). Parameters ride in the fragment (the query is read too, for a link an older page handed over).
 */
export function parseVoiciSignInLink(text, host = controlHost(), origin = voiciWebOrigin(host)) {
  let url;
  try {
    url = new URL(String(text ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)(:|$)/.test(url.host))) return null;
  const own = url.pathname.replace(/\/+$/, "") === VOICI_SIGN_IN_PATH && (url.host === host || url.host.endsWith(`.${host}`));
  if (!own && !isAppLink(url, VOICI_SIGN_IN_PATH)) return null;
  const q = url.hash.length > 1 ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
  const link = {
    sid: q.get("s") ?? "",
    browserPk: q.get("k") ?? "",
    pageId: q.get("p") ?? "",
    username: q.get("u") ?? "",
    delegatePub: q.get("d") ?? "",
    nonce: q.get("n") ?? "",
  };
  if (!SID.test(link.sid) || !PK.test(link.browserPk) || !PAGE_ID.test(link.pageId) || !USERNAME.test(link.username)) return null;
  if (!/^04[0-9a-f]{128}$/.test(link.delegatePub) || !/^[0-9a-f]{32}$/.test(link.nonce)) return null;
  link.request = { kind: TAG_VOICI_SIGN_IN_REQUEST, origin, pageId: link.pageId, username: link.username, delegatePub: link.delegatePub, nonce: link.nonce };
  return link;
}

/** The page the visitor is signing in to, verified like voi.ci does (index signature, then the profile piece). */
export async function loadSignInPage(link, deps = {}) {
  const f = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const apex = deps.apex ?? controlApex();
  const r = await f(`${apex}/api/voici/pages/${encodeURIComponent(link.username)}`, { cache: "no-store" });
  if (!r.ok) throw new VoiciError(r.status === 404 ? "no-page" : "page-unverified");
  const body = await r.json();
  const keys = await fetchAccountKeys(link.username, deps);
  const page = await verifyPublishedIndex(link.username, body?.index, { ...deps, accountKeys: keys });
  if (page.index.pageId !== link.pageId) throw new VoiciError("page-unverified");
  if (!page.acceptsMessages) throw new VoiciError("not-accepting");
  return page;
}

// ── the pipe (phone role) ─────────────────────────────────────────────────

function wsProto() {
  return typeof location !== "undefined" && location.protocol === "http:" ? "ws" : "wss";
}

async function aeadSeal(kEnc, bytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, kEnc, bytes));
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { ciphertext: b64u(ct), nonce: b64u(nonce) };
}

/**
 * Joins the voi.ci tab's pipe as `phone`. Resolves `{sas, answer(obj): Promise<void>, close()}`: the code is known at
 * once (from this side's key and the link's `k`); `answer` seals the one frame and waits for `delivered`.
 * `deps.WebSocket` and `deps.host` are seams.
 */
export async function joinSignInPipe(link, deps = {}) {
  const WS = deps.WebSocket ?? globalThis.WebSocket;
  const host = deps.host ?? controlHost();
  const { sk, pkB64u } = await freshKeypair();
  const mat = await deriveMaterial(sk, link.browserPk);
  const ws = new WS(`${wsProto()}://${host}/qr-pipe/${encodeURIComponent(link.sid)}?role=phone`);
  let readyResolve;
  let failWith = null;
  const ready = new Promise((res) => (readyResolve = res));
  let deliveredResolve;
  let deliveredReject;
  const delivered = new Promise((res, rej) => {
    deliveredResolve = res;
    deliveredReject = rej;
  });
  delivered.catch(() => {});
  const fail = (code) => {
    failWith = new VoiciError(code);
    deliveredReject(failWith);
    readyResolve();
  };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ kind: "hello", phonePk: pkB64u })));
  ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || typeof m.kind !== "string") return;
    if (m.kind === "ack") readyResolve();
    else if (m.kind === "delivered") deliveredResolve();
    else if (m.kind === "peer-missing") fail("peer-missing");
    else if (m.kind === "expired") fail("expired");
    else if (m.kind === "error") fail("pipe-error");
  });
  ws.addEventListener("error", () => fail("pipe-error"));
  return {
    sas: mat.sas,
    async answer(obj) {
      await ready;
      if (failWith) throw failWith;
      const sealed = await aeadSeal(mat.kEncEncrypt, new TextEncoder().encode(JSON.stringify(obj)));
      ws.send(JSON.stringify({ kind: "deliver", ...sealed }));
      await Promise.race([delivered, new Promise((_, rej) => setTimeout(() => rej(new VoiciError("pipe-timeout")), 20_000))]);
    },
    close() {
      try {
        ws.close(1000, "done");
      } catch {
        /* already closed */
      }
    },
  };
}

// ── the answer ────────────────────────────────────────────────────────────

const ATT_CACHE = (u, pageId) => `flagship.voici.att.${u}.${pageId}`;

/** This account's attestation for P, reused while it has a day left, else renewed (or asked for anew). */
export async function getAttestation(pageId, pseudonymPub, deps = {}) {
  const f = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = (deps.now ?? Date.now)();
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  const username = String(session.username ?? "").toLowerCase();
  const apex = deps.apex ?? controlApex();
  let cached = null;
  try {
    cached = parseMessagesKeyAttestation(JSON.parse(localStorage.getItem(ATT_CACHE(username, pageId)) ?? "null"));
  } catch {
    cached = null;
  }
  if (cached && cached.pseudonymPub === pseudonymPub && cached.expiresAt - now > RENEW_MARGIN_MS) return cached;
  const renewOfHash = cached && cached.pseudonymPub === pseudonymPub && now - cached.expiresAt <= RENEW_GRACE_MS ? messagesAttestationHash(cached) : "";
  if (!(deps.deviceSeed instanceof Uint8Array) && !/^[0-9a-f]{32}$/.test(profile?.deviceId ?? "")) throw new VoiciError("no-device-key");
  const deviceSeed = deps.deviceSeed ?? (await deriveAccountDeviceSeedFromSeed(session.umk, profile.accountId, profile.deviceId));
  const request = { username, pseudonymPub, renewOfHash, deviceCheckRef: "none", issuedAt: now };
  const signature = ed25519SignHex(canonicalMessagesKeyAttestationRequest(request), deviceSeed);
  const path = `/api/accounts/${username}/messages-attestation`;
  const c = { profile, session, now: () => now, deviceSeed };
  const r = await f(`${apex}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await deviceHeaders(c, "POST", path)) },
    // B2: a renewal carries the attestation it names (`.com` keeps nothing to look it up by); no `integrity` on the web.
    body: JSON.stringify(renewOfHash ? { request, signature, previous: cached } : { request, signature }),
  });
  if (!r.ok) {
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* none */
    }
    throw new VoiciError(typeof body?.code === "string" ? body.code : r.status === 429 ? "rate-limited" : "failed", { retryAfterSec: body?.retryAfterSec, limit: body?.limit });
  }
  const body = await r.json();
  const att = parseMessagesKeyAttestation(body?.attestation ?? body);
  if (!att || att.pseudonymPub !== pseudonymPub) throw new VoiciError("bad-attestation");
  const caKeys = deps.caKeys ?? caKeysNow();
  // `.com`'s clock issued it, maybe a moment ahead of this one: check it as of its own issue time, and that it lasts.
  if (caKeys.length && !checkMessagesKeyAttestation(att, { caKeys, now: Math.max(now, att.issuedAt), pseudonymPub }).ok) throw new VoiciError("bad-attestation");
  if (att.expiresAt <= now) throw new VoiciError("bad-attestation");
  try {
    localStorage.setItem(ATT_CACHE(username, pageId), JSON.stringify(att));
  } catch {
    /* the next sign-in just asks again */
  }
  return att;
}

/** The pseudonym this account uses toward a page (also what the approval screen names). */
export function pagePseudonym(umk, pageId) {
  const secret = deriveMessagesSecret({ seed: umk });
  return { p: deriveMessagesPseudonymKey(secret, pageId), t: deriveMessagesThreadKey(secret, pageId) };
}

/**
 * Builds the sealed-pipe answer for an approved request (`checkVoiciSignInAnswer` on the other side) and records the
 * signed-in site in the Messages state. Returns the answer.
 */
export async function approveSignIn(link, req, deps = {}) {
  if (req.pageId !== link.pageId || req.username !== link.username) throw new VoiciError("bad-request");
  if (req.origin !== (deps.origin ?? voiciWebOrigin())) throw new VoiciError("bad-request");
  const session = deps.session ?? getSession();
  const now = (deps.now ?? Date.now)();
  const { p, t } = pagePseudonym(session.umk, req.pageId);
  const pseudonymPub = hex(p.publicKey);
  const attestation = await getAttestation(req.pageId, pseudonymPub, deps);
  const delegation = {
    scope: "voici-messages",
    origin: req.origin,
    audience: req.pageId,
    principalPub: pseudonymPub,
    delegateAlg: "p256",
    delegatePub: req.delegatePub,
    issuedAt: now,
    expiresAt: attestation.expiresAt,
    nonce: req.nonce,
  };
  const threadStmt = { pageId: req.pageId, pseudonymPub, threadPub: hex(t.publicKey), issuedAt: now };
  const answer = {
    kind: TAG_VOICI_SIGN_IN,
    pageId: req.pageId,
    pseudonymPub,
    attestation,
    delegation,
    delegationSig: signWebDelegation(delegation, p.seed),
    threadStmt,
    threadSig: signVoiciThreadStatement(threadStmt, p.seed),
    threadSeed: hex(t.seed),
  };
  try {
    await (deps.updateState ?? updateMessagesState)((s) => ({
      ...s,
      signedInSites: [...s.signedInSites.filter((x) => x.delegatePub !== req.delegatePub), { pageId: req.pageId, delegatePub: req.delegatePub, at: now }],
    }), deps);
  } catch {
    /* the sign-in works without the list; Settings → Messages just won't show it until the next write */
  }
  return answer;
}

/** "Sign out" of one website: P signs the revoke, `.com` refuses that browser key from then on (§6.4). */
export async function revokeSignedInSite(site, deps = {}) {
  const f = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const session = deps.session ?? getSession();
  const now = (deps.now ?? Date.now)();
  const { p } = pagePseudonym(session.umk, site.pageId);
  const revoke = { delegatePub: site.delegatePub, issuedAt: now };
  const signature = signWebDelegationRevoke(revoke, p.seed);
  const r = await f(`${deps.apex ?? controlApex()}/api/voici/web/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revoke, principalPub: hex(p.publicKey), signature }),
  });
  if (!r.ok && r.status !== 404) throw new VoiciError("failed");
  await (deps.updateState ?? updateMessagesState)((s) => ({ ...s, signedInSites: s.signedInSites.filter((x) => x.delegatePub !== site.delegatePub) }), deps);
}
