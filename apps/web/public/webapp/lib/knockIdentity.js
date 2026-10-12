// Which account id signs a knock authorization (docs/app-apis.md §5).
//
// A box lets a browser into an app's private pages when the knock is signed by
// the box owner's AID or by an AID on that app's allow-list. Invites bind the
// friend's PER-AUTHOR contact AID, `deriveContactAccountId(UMK, ownerAID)`, not
// their global AID, so knocking on a friend's box has to sign with that same
// contact AID or the box answers 401. The knock link carries no owner AID (the
// knock page discloses nothing about the owner), so we remember the owner AID
// from the invite link's `a=` param when it is redeemed, keyed by the box.
// Our own servers sign with the global AID; any other box is refused rather
// than shown the global AID.
//
// The record holds only public keys + box names: plain localStorage, like the
// secured-sessions handles.

import {
  deriveAccountIdFromSeed,
  deriveContactAccountIdFromSeed,
  signWithAccountId,
  signWithContactAccountId,
} from "../keystore.js";
import { authorizeKnock } from "./serviceInvite.js";

const STORE_KEY = "flagship.inviteOwners.v1";
const HEX64 = /^[0-9a-f]{64}$/;

function defaultStorage() {
  return typeof globalThis !== "undefined" ? globalThis.localStorage : undefined;
}

function readAll(storage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normHost(serverId) {
  return typeof serverId === "string" ? serverId.trim().toLowerCase().replace(/\.$/, "") : "";
}

/**
 * Remember that `serverId`'s owner is `ownerAidHex` (from a v2 invite link's
 * `a=`). The latest redeem wins (a transferred box has a new owner).
 */
export function rememberInviteOwner({ serverId, ownerAidHex, serviceRef }, storage = defaultStorage()) {
  const host = normHost(serverId);
  const aid = typeof ownerAidHex === "string" ? ownerAidHex.toLowerCase() : "";
  if (!storage || !host || !HEX64.test(aid)) return false;
  const all = readAll(storage);
  const prev = all[host] && all[host].ownerAid === aid ? all[host] : null;
  const refs = new Set(Array.isArray(prev?.serviceRefs) ? prev.serviceRefs : []);
  if (typeof serviceRef === "string" && serviceRef) refs.add(serviceRef);
  all[host] = { ownerAid: aid, serviceRefs: [...refs], at: Date.now() };
  try {
    storage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    return false;
  }
  return true;
}

/**
 * The owner AID (hex) remembered for the box `serverId`, or null. An invite
 * opened on an app's own host (`<app>.<box>`) still counts for the box.
 */
export function inviteOwnerFor(serverId, storage = defaultStorage()) {
  const host = normHost(serverId);
  if (!host) return null;
  const all = readAll(storage);
  const hit = all[host] ?? Object.entries(all).find(([k]) => k.endsWith(`.${host}`))?.[1];
  const aid = hit && typeof hit.ownerAid === "string" ? hit.ownerAid.toLowerCase() : "";
  return HEX64.test(aid) ? aid : null;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Shown (and nothing is signed or sent) for a box that is neither ours nor
 *  one we redeemed an invite for on this device. */
export const NOT_YOUR_SERVER =
  "This isn't one of your servers. Open its invite link on this device first, then try again.";

/** Box hosts named by a `/pods` (or LiveSync) list: `serverDomain` / `fqdn`. */
export function hostsFromPods(pods) {
  const out = [];
  for (const p of Array.isArray(pods) ? pods : []) {
    for (const h of [p?.serverDomain, p?.fqdn]) {
      const host = normHost(h);
      if (host) out.push(host);
    }
  }
  return out;
}

/**
 * The identity to sign a knock on `serverId` with, or null to refuse:
 *  - one of our own servers (`ownServers`) → the global AID;
 *  - a box we redeemed a v2 invite for → the contact AID for its owner (a
 *    record naming our own AID is ignored: only `ownServers` makes a box ours);
 *  - anything else → null. The global AID is never offered to someone else's
 *    box: it would link us across owners, and it isn't on their list anyway.
 *
 * @param {Uint8Array} umk
 * @param {string} serverId
 * @param {{ storage?: Storage, ownServers?: Iterable<string> }} [opts]
 * @returns {Promise<null|{kind:"contact"|"account", visitorAID:Uint8Array,
 *   sign:(umk:Uint8Array, bytes:Uint8Array)=>Promise<Uint8Array>}>}
 */
export async function knockIdentity(umk, serverId, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  const host = normHost(serverId);
  if (!host) return null;
  const own = new Set([...(opts.ownServers ?? [])].map(normHost));
  const global = await deriveAccountIdFromSeed(umk);
  const asAccount = { kind: "account", visitorAID: global.publicKey, sign: signWithAccountId };
  if (own.has(host)) return asAccount;
  const ownerHex = inviteOwnerFor(host, storage);
  // `a=` is written by whoever made the invite link: a record naming our own
  // AID must never unlock the global AID (a hostile owner could plant it).
  if (!ownerHex || ownerHex === bytesToHex(global.publicKey)) return null;
  const ownerAid = hexToBytes(ownerHex);
  const contact = await deriveContactAccountIdFromSeed(umk, ownerAid);
  return {
    kind: "contact",
    visitorAID: contact.publicKey,
    sign: (u, bytes) => signWithContactAccountId(u, ownerAid, bytes),
  };
}

/**
 * Pick the identity for a parsed `flagship://access` link and authorize the
 * knock with it. Refuses (code "not-own", nothing signed or sent) when
 * {@link knockIdentity} has no identity for the box.
 *
 * @param {{serverId:string, serviceRef:string, pageId:string, svc?:string}} link
 * @param {Uint8Array} umk
 * @param {{ storage?: Storage, ownServers?: Iterable<string>, fetch?: typeof fetch, now?: () => number }} [opts]
 */
export async function authorizeKnockFor(link, umk, opts = {}) {
  const ident = await knockIdentity(umk, link?.serverId, opts);
  if (!ident) {
    const e = new Error(NOT_YOUR_SERVER);
    e.code = "not-own";
    throw e;
  }
  return authorizeKnock(
    {
      serverId: link.serverId,
      serviceRef: link.serviceRef,
      pageId: link.pageId,
      svc: link.svc,
      visitorAID: ident.visitorAID,
      umk,
      signWithAccountId: ident.sign,
    },
    { fetch: opts.fetch, now: opts.now },
  );
}
