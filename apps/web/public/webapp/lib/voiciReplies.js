// "You have a reply on voi.ci/<x>" (owner decision, docs/voici-and-messages.md §11.1 "F:"): the visitor side of
// Messages in the webapp. When this browser approves a voi.ci sign-in it remembers the page; each time the Messages
// tab opens (no push, no background polling) it fetches its own thread with each remembered page and, when the page's
// owner replied after the last reply seen here, shows one row that opens https://voi.ci/<x>. The conversation itself
// stays on voi.ci: nothing of it is shown in the app.
//
// The thread fetch is the browser's (§8.3): `POST /api/voici/web/thread` with
// `flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt>` signed by a P-256 key the pseudonym P delegated to. The
// app holds P, so it makes a short-lived key of its own and signs that delegation itself, with the attestation it
// already has for P (renewed when it lapsed). A reply counts only once it checks under the page's ownerSignPub and
// opens with this account's thread key T.

import {
  b64Decode,
  checkVoiciPageIndex,
  checkVoiciReply,
  hex,
  openVoiciBody,
  p256SignHex,
  signVoiciThreadStatement,
  signWebDelegation,
  voiciConv,
} from "./voiciProtocol.js";
import { p256 } from "../vendor/noble-post-quantum/pq-seal.js";
import { controlApex } from "./apex.js";
import { getSession } from "./state.js";
import { fetchAccountKeys, voiciWebOrigin } from "./voiciOwner.js";
import { getAttestation, pagePseudonym } from "./voiciSignIn.js";

export const TAG_VOICI_THREAD_FETCH = "flagship/voici-thread-fetch/v1";
const DELEGATION_TTL_MS = 10 * 60_000;
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt> (§8.3). */
export function canonicalVoiciThreadFetch(f) {
  if (!/^[0-9a-f]{64}$/.test(f.conv) || typeof f.since !== "string" || !/^[A-Za-z0-9_-]{0,64}$/.test(f.since) || !Number.isSafeInteger(f.issuedAt) || f.issuedAt < 0) {
    throw new Error(`${TAG_VOICI_THREAD_FETCH}: bad field`);
  }
  return new TextEncoder().encode([TAG_VOICI_THREAD_FETCH, f.conv, f.since, String(f.issuedAt)].join("|"));
}

// ── the pages this account signed in to, per device ───────────────────────
// F: the synced state blob's signedInSites has no username (its schema is strict and shared by every client), so the
// page's name and the last reply seen live on this device.

const storeKey = (account) => `flagship.voici.visited.v1.${account}`;

export function visitedPages(account = String(getSession()?.username ?? "").toLowerCase(), storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(storeKey(account)) ?? "[]");
    return Array.isArray(list) ? list.filter((p) => PAGE_ID.test(p?.pageId ?? "") && USERNAME.test(p?.username ?? "")) : [];
  } catch {
    return [];
  }
}

function saveVisited(account, list, storage = globalThis.localStorage) {
  try {
    storage?.setItem(storeKey(account), JSON.stringify(list));
  } catch {
    /* the reminder is a courtesy */
  }
}

/** Called when this browser approves a sign-in to `username`'s page. */
export function rememberVisitedPage(pageId, username, deps = {}) {
  const account = String((deps.session ?? getSession())?.username ?? "").toLowerCase();
  if (!account || !PAGE_ID.test(pageId) || !USERNAME.test(username)) return;
  const list = visitedPages(account, deps.storage);
  const cur = list.find((p) => p.pageId === pageId);
  if (cur) cur.username = username;
  else list.push({ pageId, username, seenReplyAt: 0 });
  saveVisited(account, list, deps.storage);
}

/** Marks a page's replies seen (its row goes away until a newer reply). */
export function markReplySeen(pageId, at, deps = {}) {
  const account = String((deps.session ?? getSession())?.username ?? "").toLowerCase();
  const list = visitedPages(account, deps.storage);
  const cur = list.find((p) => p.pageId === pageId);
  if (!cur) return;
  cur.seenReplyAt = Math.max(cur.seenReplyAt ?? 0, at);
  saveVisited(account, list, deps.storage);
}

// ── the check ─────────────────────────────────────────────────────────────

/** The body of POST /api/voici/web/thread for this account's thread with one page. */
export async function threadFetchBody(pageId, deps = {}) {
  const session = deps.session ?? getSession();
  const now = (deps.now ?? Date.now)();
  const { p, t } = pagePseudonym(session.umk, pageId);
  const pseudonymPub = hex(p.publicKey);
  const attestation = await getAttestation(pageId, pseudonymPub, deps);
  const sk = deps.p256Key ?? p256.utils.randomSecretKey();
  const delegation = {
    scope: "voici-messages",
    origin: deps.origin ?? voiciWebOrigin(),
    audience: pageId,
    principalPub: pseudonymPub,
    delegateAlg: "p256",
    delegatePub: hex(p256.getPublicKey(sk, false)),
    issuedAt: now,
    expiresAt: Math.min(attestation.expiresAt, now + DELEGATION_TTL_MS),
    nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
  };
  const threadStmt = { pageId, pseudonymPub, threadPub: hex(t.publicKey), issuedAt: now };
  const f = { conv: voiciConv(pageId, pseudonymPub), since: "", issuedAt: now };
  const sig = p256SignHex(canonicalVoiciThreadFetch(f), sk);
  return {
    body: {
      ...f,
      sig,
      cred: { attestation, delegation, delegationSig: signWebDelegation(delegation, p.seed), threadStmt, threadSig: signVoiciThreadStatement(threadStmt, p.seed) },
    },
    conv: f.conv,
    threadSeed: t.seed,
  };
}

/** The newest owner reply on one page that checks and opens here: its time, or 0. */
export async function newestReplyAt(page, deps = {}) {
  const f = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const apex = deps.apex ?? controlApex();
  const r = await f(`${apex}/api/voici/pages/${encodeURIComponent(page.username)}`, { cache: "no-store" });
  if (!r.ok) return 0;
  const keys = deps.accountKeys ?? (await fetchAccountKeys(page.username, deps));
  const idx = checkVoiciPageIndex((await r.json())?.index, { username: page.username, sensitiveKind: keys.kind, sensitivePub: keys.pub, pageId: page.pageId });
  if (!idx.ok) return 0;
  const { body, conv, threadSeed } = await threadFetchBody(page.pageId, deps);
  const res = await f(`${apex}/api/voici/web/thread`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) return 0;
  const j = await res.json();
  let newest = 0;
  for (const item of Array.isArray(j?.items) ? j.items : []) {
    const env = item?.envelope;
    if (env?.kind !== "voici-reply") continue;
    const ok = checkVoiciReply(env, { pageId: page.pageId, ownerSignPub: idx.index.ownerSignPub, conv });
    if (!ok.ok || !openVoiciBody(b64Decode(ok.envelope.bodyB64), { conv, msgId: ok.envelope.msgId }, threadSeed).ok) continue;
    newest = Math.max(newest, ok.envelope.sentAt);
  }
  return newest;
}

/** Every remembered page with a reply newer than the last one seen here: [{pageId, username, at}]. Each page fails alone. */
export async function checkReplies(deps = {}) {
  if (!((deps.session ?? getSession())?.umk instanceof Uint8Array)) return [];
  const pages = visitedPages(String((deps.session ?? getSession()).username ?? "").toLowerCase(), deps.storage);
  const out = [];
  for (const page of pages) {
    try {
      const at = await newestReplyAt(page, deps);
      if (at > (page.seenReplyAt ?? 0)) out.push({ pageId: page.pageId, username: page.username, at });
    } catch {
      /* this page stays quiet until the next open */
    }
  }
  return out;
}
