// Which key signs a knock authorization (docs/app-apis.md §5;
// docs/service-access-gating.md "Who is signing in").
//
// The box classifies the signing key itself:
//  - on one of this account's own servers: this device's account device key
//    (the box's device book says admin or not, and the rank follows);
//  - on a server shared with this account: that share's member key;
//  - on a box we redeemed an invite on: our id for THAT app,
//    `deriveAppAccountId(UMK, serviceRef)` (the knock link's `ref=`).
// Any other box is refused rather than shown any key. The device key and a
// share key are never presented to anyone else's box: they would link us
// across owners. We remember which boxes we redeemed invites on (and their
// owner's AID, from the link's `a=`).
//
// The record holds only public keys + box names: plain localStorage, like the
// secured-sessions handles.

import {
  deriveAccountDeviceKeyFromSeed,
  deriveAccountIdFromSeed,
  deriveAppAccountIdFromSeed,
  signWithAccountDeviceKey,
  signWithAppAccountId,
} from "../keystore.js";
import { deriveShareMemberKey, signWithShareMemberKey } from "./serverShare.js";
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

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Shown (and nothing is signed or sent) for a box that is neither ours nor
 *  one we redeemed an invite for on this device. */
export const NOT_YOUR_SERVER =
  "This isn't one of your servers. Open its invite link on this device first, then try again.";

/** Shown when one of our own servers asks and this device has no account device id. */
export const NO_DEVICE_KEY =
  "This device isn't set up on your account yet. Sign in to your account on it again, then try again.";

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
const SHARE_ID_RE = /^[0-9a-f]{32}$/;

/** The "Shared with me" entry whose server is `host` (or `host` is one of its app hosts). */
function shareFor(host, shared) {
  for (const e of shared ?? []) {
    const d = normHost(e?.serverDomain);
    if (!d || !SHARE_ID_RE.test(String(e?.shareId ?? ""))) continue;
    if (host === d || host.endsWith(`.${d}`)) return { shareId: e.shareId, serverDomain: d };
  }
  return null;
}

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
 * The identity to sign a knock on `serverId`'s app `serviceRef` with, or null to refuse:
 *  - one of our own servers (`ownServers`) → this device's account device key
 *    (`device`: the profile's `{accountId, deviceId}`; without one it throws
 *    code "no-device" rather than fall back to a shared account key);
 *  - a server shared with us (`sharedServers`: `{serverDomain, shareId}`) →
 *    that share's member key;
 *  - a box we redeemed an invite on → our id for that app (a record naming our
 *    own AID is ignored: only `ownServers` makes a box ours);
 *  - anything else → null.
 *
 * @param {Uint8Array} umk
 * @param {string} serverId
 * @param {{ storage?: Storage, ownServers?: Iterable<string>, serviceRef?: string,
 *   device?: {accountId:string, deviceId:string}|null,
 *   sharedServers?: Iterable<{serverDomain:string, shareId:string}> }} [opts]
 * @returns {Promise<null|{kind:"device"|"share"|"app", visitorAID:Uint8Array,
 *   sign:(umk:Uint8Array, bytes:Uint8Array)=>Promise<Uint8Array>}>}
 */
export async function knockIdentity(umk, serverId, opts = {}) {
  const storage = opts.storage ?? defaultStorage();
  const host = normHost(serverId);
  if (!host) return null;
  const own = new Set([...(opts.ownServers ?? [])].map(normHost));
  if (own.has(host)) {
    const accountId = opts.device?.accountId;
    const deviceId = opts.device?.deviceId;
    if (typeof accountId !== "string" || !accountId || typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      const e = new Error(NO_DEVICE_KEY);
      e.code = "no-device";
      throw e;
    }
    const key = await deriveAccountDeviceKeyFromSeed(umk, accountId, deviceId);
    return {
      kind: "device",
      visitorAID: key.publicKey,
      sign: (u, bytes) => signWithAccountDeviceKey(u, accountId, deviceId, bytes),
    };
  }
  const share = shareFor(host, opts.sharedServers);
  if (share) {
    const key = await deriveShareMemberKey(umk, share.shareId);
    return {
      kind: "share",
      visitorAID: key.publicKey,
      sign: (u, bytes) => signWithShareMemberKey(u, share.shareId, bytes),
    };
  }
  const global = await deriveAccountIdFromSeed(umk);
  const ownerHex = inviteOwnerFor(host, storage);
  // `a=` is written by whoever made the invite link: a record naming our own
  // AID must never unlock the global AID (a hostile owner could plant it).
  if (!ownerHex || ownerHex === bytesToHex(global.publicKey)) return null;
  const ref = opts.serviceRef;
  if (typeof ref !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(ref)) return null;
  const app = await deriveAppAccountIdFromSeed(umk, ref);
  return {
    kind: "app",
    visitorAID: app.publicKey,
    sign: (u, bytes) => signWithAppAccountId(u, ref, bytes),
  };
}

/**
 * Pick the identity for a parsed `flagship://access` link and authorize the
 * knock with it. Refuses (code "not-own", nothing signed or sent) when
 * {@link knockIdentity} has no identity for the box.
 *
 * @param {{serverId:string, serviceRef:string, pageId:string, svc?:string}} link
 * @param {Uint8Array} umk
 * @param {{ storage?: Storage, ownServers?: Iterable<string>, device?: {accountId:string, deviceId:string}|null,
 *   sharedServers?: Iterable<{serverDomain:string, shareId:string}>, fetch?: typeof fetch, now?: () => number }} [opts]
 */
export async function authorizeKnockFor(link, umk, opts = {}) {
  const ident = await knockIdentity(umk, link?.serverId, { ...opts, serviceRef: link?.serviceRef });
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
