// Share this server: the webapp's client flows (docs/share-a-server.md §9).
// The owner (A) offers, confirms, changes and ends shares from the server's
// page; the other account (B) accepts a link, signs in to the box with its
// per-share key, approves start-ups and leaves. The envelopes and sealing
// live in serverShare.js; this file is the order of operations.
//
// Every flow takes an optional `deps` for tests: fetch, now, umk, username,
// apex, boot, sensitiveSign(bytes), accountSign(bytes), boxFetch(fqdn, path,
// init) (A's own session on the box) and openDiskKey(serverDomain).

import * as ss from "./serverShare.js";
import { controlApex, bootOrigin } from "./apex.js";
import { getSession } from "./state.js";
import { boxClient, ScreensError } from "./api.js";
import { sensitiveSigner } from "./adminRoot.js";
import { _internal as bootSeal } from "./bootApproval.js";
import { humanError } from "./humanError.js";
import { deriveHouseholdKeyFromSeed, signWithIrk, bytesToHex, hexToBytes } from "../keystore.js";

export const LEVEL_TEXT = Object.freeze({ view: "Can view", manage: "Can manage" });
export const LEVEL_LINE = Object.freeze({
  view: "See the server's status, monitoring and apps.",
  manage: "Also build apps with AI, accept app updates, update the server and change what apps can reach on the internet.",
});
export const UNLOCK_TITLE = "Can approve this server's start-up";
export const UNLOCK_LINE = "Their phone gets a copy of the disk key.";
export const UNLOCK_WARNING =
  "Only give this to someone you'd give a house key. Ending the share deletes their copy, but they could have kept one.";
export const NOTIFY_TITLE = "Notify this device when it needs to start";
export const NOTIFY_LINE =
  "Turning this on lets Flagship's service know this device helps with this server, so it can wake you. The notice itself names no server.";
export const NOTIFY_NOT_ALLOWED = "The owner hasn't let you approve this server's start-up.";
// A share makes its holder a co-manager, Manager in every app of the server
// (accessPrincipals.ts), so a members-only app still opens for them.
export const MEMBERS_ONLY_HINT = "Members only. You can open it: you co-manage this server.";
export const DATA_TITLE = "Can see app data";
export const DATA_LINE = "They can open each app's Database section.";

export class ShareError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ShareError";
    this.code = code;
    if (status != null) this.status = status;
  }
}

/** What to tell the person: our own messages as written, anything else plainly. */
export function shareErrorText(e) {
  return e instanceof ShareError ? e.message : humanError(e);
}

function ctx(deps = {}) {
  const session = getSession();
  const umk = deps.umk ?? session?.umk ?? null;
  return {
    fetch: deps.fetch ?? ((...a) => fetch(...a)),
    now: deps.now ?? (() => Date.now()),
    umk,
    username: deps.username ?? session?.username ?? "",
    apex: (deps.apex ?? controlApex()).replace(/\/+$/, ""),
    boot: (deps.boot ?? bootOrigin()).replace(/\/+$/, ""),
    sensitiveSign: deps.sensitiveSign ?? ((bytes) => sensitiveSigner()(umk, bytes)),
    accountSign: deps.accountSign ?? ((bytes) => signWithIrk(umk, bytes)),
    boxFetch: deps.boxFetch ?? ((fqdn, path, init) => boxClient(fqdn).fetch(path, init)),
    openDiskKey: deps.openDiskKey ?? null,
  };
}

function needUmk(d) {
  if (!(d.umk instanceof Uint8Array)) throw new ShareError("Unlock the webapp first", "locked");
}

async function call(d, url, init = {}) {
  const r = await d.fetch(url, init);
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: r.status, ok: r.ok, body };
}

/** Plain copy for a refusal; the server's own wording goes to the console. */
function errText(res, fallback) {
  const reason = res.body && typeof res.body === "object" && typeof res.body.error === "string" ? res.body.error : "";
  if (reason) console.warn(`[shares] ${res.status} ${reason}`);
  if (res.status === 403 && /stale/.test(reason)) return "This device's clock is off. Fix the clock and try again.";
  return fallback;
}

function postJson(d, url, body, headers = {}) {
  return call(d, url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const sigHex = async (p) => bytesToHex(await p);
const lower = (s) => String(s ?? "").trim().toLowerCase();

// ──────────────────────────────────────────────────────────────────────
// Owner (A)
// ──────────────────────────────────────────────────────────────────────

/** Mint a share, seal the offer and the owner record, sign #6 and post it. */
export async function createShareOffer(args, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  if (!d.username) throw new ShareError("Sign in first", "no-account");
  const label = ss.normalizeShareLabel(args.label);
  if (!label) throw new ShareError("Give them a name of up to 64 characters, without |.", "bad-label");
  if (args.level !== "view" && args.level !== "manage") throw new ShareError("Pick what they can do.", "bad-level");
  const stkPubHex = lower(args.stkPubHex);
  if (!/^[0-9a-f]{64}$/.test(stkPubHex)) throw new ShareError("This server hasn't published its key yet. Try again once it's online.", "no-stk");
  const serverDomain = lower(args.serverDomain);
  const unlockAtBoot = !!args.unlockAtBoot;
  const seeAppData = !!args.seeAppData;
  const now = d.now();
  const shareId = args.shareId ?? ss.randomShareId();
  const secret = args.secret ?? ss.randomShareSecret();
  const secretHex = bytesToHex(secret);
  const expiresAt = now + ss.SHARE_OFFER_TTL_MS;

  const offerHex = await ss.sealShareJson(await ss.shareLinkKey(secret), ss.shareAad(ss.AAD_SHARE_OFFER, shareId), {
    v: 1,
    serverDomain,
    serverName: String(args.serverName ?? serverDomain.split(".")[0] ?? ""),
    stkPubHex,
    level: args.level,
    unlockAtBoot,
    seeAppData,
    expiresAt,
  });
  const ownerHex = await ss.sealShareJson(await deriveHouseholdKeyFromSeed(d.umk), ss.shareAad(ss.AAD_SHARE_OWNER, shareId), {
    v: 1,
    secretHex,
    label,
    level: args.level,
    unlockAtBoot,
    seeAppData,
  });
  const offer = {
    username: d.username,
    serverDomain,
    shareId,
    tokenHash: await ss.shareTokenHash(await ss.shareTokenFromSecret(secret)),
    offerSha256: await ss.shareSha256Hex(offerHex),
    ownerSha256: await ss.shareSha256Hex(ownerHex),
    expiresAt,
    issuedAt: now,
  };
  const signature = await sigHex(ss.signServerShareOffer(offer, d.sensitiveSign));
  const res = await postJson(d, `${d.apex}/api/users/${encodeURIComponent(d.username)}/server-shares`, {
    offer,
    signature,
    offerHex,
    ownerHex,
  });
  if (!res.ok) throw new ShareError(errText(res, "Couldn't create the link. Try again."), "create-failed", res.status);
  return { shareId, secretHex, expiresAt, label, link: ss.buildShareLink(d.apex, shareId, secret) };
}

/** The share link for an offer row the owner can still hand out. */
export function ownerShareLink(row, deps = {}) {
  const d = ctx(deps);
  return ss.buildShareLink(d.apex, row.shareId, hexToBytes(row.secretHex));
}

async function listComShares(d) {
  const list = { username: d.username, issuedAt: d.now() };
  const signature = await sigHex(ss.signServerShareList(list, d.accountSign));
  const res = await postJson(d, `${d.apex}/api/users/${encodeURIComponent(d.username)}/server-shares/list`, { list, signature });
  if (!res.ok) throw new ShareError(errText(res, "Couldn't load your share links."), "list-failed", res.status);
  return Array.isArray(res.body?.shares) ? res.body.shares : [];
}

async function openAcceptance(row, record, serverDomain) {
  try {
    const payload = ss.parseShareAcceptancePayload(
      await ss.openShareJson(
        await ss.shareLinkKey(hexToBytes(record.secretHex)),
        ss.shareAad(ss.AAD_SHARE_ACCEPTANCE, row.shareId),
        row.acceptance,
      ),
    );
    if (!payload) return null;
    const a = payload.accept;
    if (a.serverDomain !== serverDomain || a.shareId !== row.shareId) return null;
    if (!(await ss.verifyServerShareAccept(a, payload.signature, a.memberPubHex))) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Everything the "Shared with" card shows for one server:
 *   active   — shares the box holds (the truth for who has access)
 *   awaiting — accepted links to confirm, each with the code B's phone shows
 *   offered  — links nobody has opened yet (or that expired)
 *   ended    — the box's recent ends
 *   unfinished — share ids the box ended whose `.com` row is still open
 *                (a revoke or leave that reached only the box)
 * `boxError` / `comError` say which side couldn't be read.
 */
export async function loadOwnerShares(serverDomain, deps = {}) {
  const d = ctx(deps);
  const domain = lower(serverDomain);
  const [boxSide, comSide] = await Promise.allSettled([
    d.boxFetch(domain, "/api/screens/shares"),
    d.umk && d.username ? listComShares(d) : Promise.reject(new ShareError("Unlock the webapp first", "locked")),
  ]);
  const boxShares = boxSide.status === "fulfilled" && Array.isArray(boxSide.value?.shares) ? boxSide.value.shares : [];
  const boxEnded = boxSide.status === "fulfilled" && Array.isArray(boxSide.value?.ended) ? boxSide.value.ended : [];
  const comRows = comSide.status === "fulfilled" ? comSide.value.filter((r) => lower(r.serverDomain) === domain) : [];

  const household = d.umk instanceof Uint8Array ? await deriveHouseholdKeyFromSeed(d.umk) : null;
  const records = new Map();
  for (const r of comRows) {
    if (!household || typeof r.owner !== "string") continue;
    try {
      const rec = ss.parseShareOwnerRecord(
        await ss.openShareJson(household, ss.shareAad(ss.AAD_SHARE_OWNER, r.shareId), r.owner),
      );
      if (rec) records.set(r.shareId, { row: r, rec });
    } catch {
      /* a row another account's key sealed, or a damaged one */
    }
  }

  const activeIds = new Set(boxShares.map((s) => s.shareId));
  const endedIds = new Set(boxEnded.map((e) => e.shareId));
  const active = boxShares
    .map((s) => {
      const c = records.get(s.shareId);
      return {
        shareId: s.shareId,
        label: s.label,
        level: s.level,
        unlockAtBoot: !!s.unlockAtBoot,
        seeAppData: !!s.seeAppData,
        memberPubHex: s.memberPubHex,
        issuedAt: s.issuedAt,
        lastSeenAt: s.lastSeenAt ?? null,
        unlockDeposited: c ? !!c.row.unlock : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const awaiting = [];
  const offered = [];
  const now = d.now();
  for (const { row, rec } of records.values()) {
    if (activeIds.has(row.shareId) || endedIds.has(row.shareId) || row.state === "ended") continue;
    const base = {
      shareId: row.shareId,
      label: rec.label,
      level: rec.level,
      unlockAtBoot: rec.unlockAtBoot,
      seeAppData: rec.seeAppData,
      secretHex: rec.secretHex,
      expiresAt: row.expiresAt,
    };
    if (row.state === "accepted" && typeof row.acceptance === "string") {
      const payload = await openAcceptance(row, rec, domain);
      if (!payload) {
        awaiting.push({ ...base, broken: true });
        continue;
      }
      awaiting.push({
        ...base,
        accept: payload.accept,
        acceptSignature: payload.signature,
        memberPubHex: payload.accept.memberPubHex,
        sas: await ss.shareSas(row.shareId, payload.accept.memberPubHex, hexToBytes(rec.secretHex)),
      });
    } else if (row.state === "offered") {
      offered.push({ ...base, expired: typeof row.expiresAt === "number" && row.expiresAt <= now });
    }
  }

  return {
    active,
    awaiting,
    offered,
    ended: boxEnded.slice(0, 3),
    unfinished: comRows.filter((r) => r.state !== "ended" && endedIds.has(r.shareId)).map((r) => r.shareId),
    boxError: boxSide.status === "rejected" ? boxSide.reason : null,
    comError: comSide.status === "rejected" ? comSide.reason : null,
  };
}

function grantOf(serverDomain, s, now) {
  return {
    serverDomain: lower(serverDomain),
    shareId: s.shareId,
    memberPubHex: s.memberPubHex,
    level: s.level,
    unlockAtBoot: !!s.unlockAtBoot,
    seeAppData: !!s.seeAppData,
    label: s.label,
    issuedAt: now,
  };
}

/** A's Confirm on a matching code: sign #1 with B's acceptance; then the boot copy. */
export async function confirmShare(serverDomain, awaiting, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  if (!awaiting?.accept) throw new ShareError("This acceptance didn't check out.", "bad-acceptance");
  const grant = grantOf(serverDomain, awaiting, d.now());
  const signature = await sigHex(ss.signServerShareGrant(grant, d.sensitiveSign));
  await d.boxFetch(lower(serverDomain), "/api/screens/shares", {
    method: "POST",
    body: JSON.stringify({ grant, signature, accept: awaiting.accept, acceptSignature: awaiting.acceptSignature }),
  });
  let unlockError = null;
  if (grant.unlockAtBoot) {
    try {
      await setUnlockDeposit(serverDomain, { shareId: grant.shareId, memberPubHex: grant.memberPubHex, on: true }, deps);
    } catch (e) {
      unlockError = e;
    }
  }
  return { grant, unlockError };
}

/** Re-sign an active share's grant with a new level or opt-ins. */
export async function changeShare(serverDomain, active, changes, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  const next = { ...active, ...changes };
  if (next.level !== "view" && next.level !== "manage") throw new ShareError("Pick what they can do.", "bad-level");
  const grant = grantOf(serverDomain, next, Math.max(d.now(), (active.issuedAt ?? 0) + 1));
  const signature = await sigHex(ss.signServerShareGrant(grant, d.sensitiveSign));
  await d.boxFetch(lower(serverDomain), "/api/screens/shares", { method: "POST", body: JSON.stringify({ grant, signature }) });
  if (!!active.unlockAtBoot !== grant.unlockAtBoot) {
    await setUnlockDeposit(serverDomain, { shareId: grant.shareId, memberPubHex: grant.memberPubHex, on: grant.unlockAtBoot }, deps);
  }
  return grant;
}

async function signedRevoke(d, serverDomain, shareId) {
  const revoke = { serverDomain: lower(serverDomain), shareId, issuedAt: d.now() };
  const signature = await sigHex(ss.signServerShareRevoke(revoke, d.sensitiveSign));
  return { revoke, signature };
}

async function comRevoke(d, body) {
  const res = await postJson(
    d,
    `${d.apex}/api/users/${encodeURIComponent(d.username)}/server-shares/${body.revoke.shareId}/revoke`,
    body,
  );
  if (res.ok || res.status === 404) return true;
  throw new ShareError(errText(res, "Couldn't end the share link."), "revoke-failed", res.status);
}

/** Remove: the box ends it now; `.com` ends the row so the box's poll agrees. */
export async function revokeShare(serverDomain, shareId, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  const body = await signedRevoke(d, serverDomain, shareId);
  const [boxSide, comSide] = await Promise.allSettled([
    d.boxFetch(lower(serverDomain), "/api/screens/shares/revoke", { method: "POST", body: JSON.stringify(body) }),
    comRevoke(d, body),
  ]);
  if (boxSide.status === "rejected" && comSide.status === "rejected") throw boxSide.reason;
  return { box: boxSide.status === "fulfilled", com: comSide.status === "fulfilled" };
}

/** Cancel a link nobody has confirmed: `.com` only (the box never knew it). */
export async function cancelShareOffer(serverDomain, shareId, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  return comRevoke(d, await signedRevoke(d, serverDomain, shareId));
}

async function defaultOpenDiskKey(d, serverDomain) {
  const res = await call(d, `${d.apex}/api/server/${encodeURIComponent(serverDomain)}/sealed-luks-key`);
  if (res.status === 404) throw new ShareError("This server has no disk key on file, so there's no start-up to approve.", "no-disk-key", 404);
  if (!res.ok || typeof res.body?.sealedKey !== "string") throw new ShareError("Couldn't read this server's disk key.", "disk-key", res.status);
  try {
    return await bootSeal.openSealedWithEd25519Seed(hexToBytes(res.body.sealedKey), await bootSeal.deriveIrkSeed(d.umk));
  } catch {
    throw new ShareError("This browser's account key can't open this server's disk key.", "disk-key");
  }
}

/** Put (or withdraw) B's sealed copy of the disk key: #8. */
export async function setUnlockDeposit(serverDomain, { shareId, memberPubHex, on }, deps = {}) {
  const d = ctx(deps);
  needUmk(d);
  const domain = lower(serverDomain);
  let sealedKey = null;
  if (on) {
    const diskKey = d.openDiskKey ? await d.openDiskKey(domain) : await defaultOpenDiskKey(d, domain);
    sealedKey = bytesToHex(await bootSeal.sealForBoxStk(diskKey, hexToBytes(memberPubHex)));
  }
  const unlock = {
    serverDomain: domain,
    shareId,
    memberPubHex,
    sealedSha256: sealedKey ? await ss.shareSha256Hex(sealedKey) : ss.SHARE_UNLOCK_OFF,
    issuedAt: d.now(),
  };
  const signature = await sigHex(ss.signServerShareUnlock(unlock, d.sensitiveSign));
  const res = await postJson(
    d,
    `${d.apex}/api/users/${encodeURIComponent(d.username)}/server-shares/${shareId}/unlock`,
    { unlock, signature, ...(sealedKey ? { sealedKey } : {}) },
  );
  if (!res.ok) throw new ShareError(errText(res, "Couldn't update start-up approval."), "unlock-failed", res.status);
  return { on: !!on };
}

const ACTION_TEXT = {
  "share.signed-in": () => "signed in",
  "share.granted": (t) => `shared this server with ${t || "someone"}`,
  "share.changed": (t) => `changed what ${t || "someone"} can do`,
  "share.revoked": (t) => `removed ${t || "someone"}`,
  "share.left": () => "left",
  "ai.start": () => "started building an app with AI",
  "ai.reply": () => "answered the AI",
  "app.access.edit": (t) => `changed ${t || "an app"}'s internet access`,
  "app.access.dismiss": (t) => `dismissed an internet request from ${t || "an app"}`,
  "app.update.accept": (t) => `accepted an update to ${t || "an app"}`,
  "db.write": (t) => `changed data in ${t || "an app"}`,
  "db.read": (t) => `read data in ${t || "an app"}`,
};

/** One activity entry as a line: "<label> · <what>" (A's own lines say "You"). */
export function activityLine(e) {
  const who = e?.actor?.kind === "share" ? String(e.actor.label || "Someone") : "You";
  const action = String(e?.action ?? "");
  const what = ACTION_TEXT[action]?.(e?.target) ?? (e?.target ? `${action} · ${e.target}` : action);
  return `${who} · ${what}${e?.ok === false ? " (refused)" : ""}`;
}

export async function fetchActivity(serverDomain, deps = {}, limit = 50) {
  const d = ctx(deps);
  const body = await d.boxFetch(lower(serverDomain), `/api/screens/activity?limit=${limit}`);
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  return entries.slice().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
}

// ──────────────────────────────────────────────────────────────────────
// The link (B)
// ──────────────────────────────────────────────────────────────────────

let pendingLink = null;

/** A `/share#s=…&k=…` landing, or null. */
export function shareLinkFromLocation(loc = globalThis.location) {
  if (!loc) return null;
  const path = String(loc.pathname ?? "");
  if (!/^\/share\/?$/.test(path)) return null;
  return ss.parseShareLink(String(loc.hash ?? "").replace(/^#/, ""));
}

/** Keep a landed link in memory until the account is unlocked, and drop the
 *  secret from the address bar and history. */
export function stashShareLinkFromLocation(loc = globalThis.location, hist = globalThis.history) {
  const link = shareLinkFromLocation(loc);
  if (!link) return null;
  pendingLink = link;
  try {
    hist?.replaceState?.({}, "", "/");
  } catch {
    /* an old browser keeps the fragment; the link still works once */
  }
  return link;
}

export function takePendingShareLink() {
  const l = pendingLink;
  pendingLink = null;
  return l;
}

// ──────────────────────────────────────────────────────────────────────
// The other account (B)
// ──────────────────────────────────────────────────────────────────────

async function memberKey(d, shareId) {
  needUmk(d);
  const k = await ss.deriveShareMemberKey(d.umk, shareId);
  return { seed: k.seed, pubHex: bytesToHex(k.publicKey) };
}

async function readShareRow(d, shareId, secretHex) {
  const token = await ss.shareTokenFromSecret(hexToBytes(secretHex));
  const res = await call(d, `${d.apex}/api/server-shares/${shareId}`, { headers: { "x-flagship-share-token": token } });
  return { res, token };
}

async function openOffer(shareId, secretHex, offerHex) {
  try {
    return ss.parseShareOfferPayload(
      await ss.openShareJson(await ss.shareLinkKey(hexToBytes(secretHex)), ss.shareAad(ss.AAD_SHARE_OFFER, shareId), offerHex),
    );
  } catch {
    return null;
  }
}

/** Read and open the offer a link points at. */
export async function openShareLink({ shareId, secretHex }, deps = {}) {
  const d = ctx(deps);
  const { res, token } = await readShareRow(d, shareId, secretHex);
  if (res.status === 404) throw new ShareError("This link doesn't work. Ask the owner to send it again.", "bad-link", 404);
  if (res.status === 410) throw new ShareError("This link has expired. Ask the owner for a new one.", "expired", 410);
  if (!res.ok) throw new ShareError(errText(res, "Couldn't open this link. Try again."), "open-failed", res.status);
  const offer = typeof res.body?.offer === "string" ? await openOffer(shareId, secretHex, res.body.offer) : null;
  if (!offer) throw new ShareError("This link doesn't work. Ask the owner to send it again.", "bad-link");
  if (res.body.state === "ended") throw new ShareError("The owner has ended this share.", "ended");
  let acceptedByMe = false;
  if (res.body.state === "accepted" && typeof res.body.acceptance === "string" && d.umk instanceof Uint8Array) {
    const mine = await memberKey(d, shareId);
    try {
      const p = ss.parseShareAcceptancePayload(
        await ss.openShareJson(
          await ss.shareLinkKey(hexToBytes(secretHex)),
          ss.shareAad(ss.AAD_SHARE_ACCEPTANCE, shareId),
          res.body.acceptance,
        ),
      );
      acceptedByMe = p?.accept.memberPubHex === mine.pubHex;
    } catch {
      acceptedByMe = false;
    }
  }
  return { shareId, secretHex, token, state: res.body.state, offer, acceptedByMe, unlock: !!res.body.unlock };
}

/** Accept: sign #3 with the member key, post it sealed, and save the share to
 *  B's inbox. Resolves to the six digits to read to the owner. */
export async function acceptShare(opened, deps = {}) {
  const d = ctx(deps);
  const { shareId, secretHex, offer } = opened;
  const member = await memberKey(d, shareId);
  const secret = hexToBytes(secretHex);
  const acceptedAt = d.now();
  if (!opened.acceptedByMe) {
    if (opened.state === "accepted") throw new ShareError("Someone else already used this link. Ask the owner for a new one.", "taken", 409);
    const accept = { serverDomain: offer.serverDomain, shareId, memberPubHex: member.pubHex, acceptedAt };
    const signature = await sigHex(ss.signServerShareAccept(accept, member.seed));
    const acceptance = await ss.sealShareJson(await ss.shareLinkKey(secret), ss.shareAad(ss.AAD_SHARE_ACCEPTANCE, shareId), {
      v: 1,
      accept,
      signature,
    });
    const res = await postJson(d, `${d.apex}/api/server-shares/${shareId}/accept`, { acceptance }, {
      "x-flagship-share-token": opened.token,
    });
    if (res.status === 409) throw new ShareError("Someone else already used this link. Ask the owner for a new one.", "taken", 409);
    if (res.status === 410) throw new ShareError("This link has expired. Ask the owner for a new one.", "expired", 410);
    if (!res.ok) throw new ShareError(errText(res, "Couldn't accept. Try again."), "accept-failed", res.status);
  }
  const entry = { shareId, secretHex, serverDomain: offer.serverDomain, serverName: offer.serverName, acceptedAt };
  let saved = null;
  try {
    const existing = (await listSharedWithMe(deps)).find((e) => e.shareId === shareId);
    saved = existing ?? (await putInboxEntry(entry, deps));
  } catch {
    saved = null;
  }
  return {
    entry: saved ?? entry,
    savedToInbox: !!saved,
    memberPubHex: member.pubHex,
    sas: ss.formatShareSas(await ss.shareSas(shareId, member.pubHex, secret)),
  };
}

async function inboxCall(d, op, entryId, ct) {
  needUmk(d);
  const key = await ss.deriveShareInboxKey(d.umk);
  const request = {
    inboxPubHex: bytesToHex(key.publicKey),
    op,
    entryId,
    ctSha256: ct ? await ss.shareSha256Hex(ct) : "",
    issuedAt: d.now(),
  };
  const signature = await sigHex(ss.signShareInboxRequest(request, key.seed));
  const res = await postJson(d, `${d.apex}/api/share-inbox`, { request, signature, ...(ct ? { ct } : {}) });
  if (!res.ok) throw new ShareError(errText(res, "Couldn't reach your shared servers list."), "inbox", res.status);
  return res.body;
}

export async function putInboxEntry(entry, deps = {}) {
  const d = ctx(deps);
  const entryId = ss.randomShareId();
  const ct = await ss.sealShareJson(await ss.deriveShareInboxSealKey(d.umk), ss.shareAad(ss.AAD_SHARE_INBOX_ENTRY, entryId), {
    v: 1,
    shareId: entry.shareId,
    secretHex: entry.secretHex,
    serverDomain: entry.serverDomain,
    serverName: entry.serverName,
    acceptedAt: entry.acceptedAt,
  });
  await inboxCall(d, "put", entryId, ct);
  return { entryId, ...entry };
}

export async function deleteInboxEntry(entryId, deps = {}) {
  return inboxCall(ctx(deps), "delete", entryId, "");
}

/** B's "Shared with me" entries, opened; one per share. */
export async function listSharedWithMe(deps = {}) {
  const d = ctx(deps);
  const body = await inboxCall(d, "list", "", "");
  const sealKey = await ss.deriveShareInboxSealKey(d.umk);
  const byShare = new Map();
  for (const e of Array.isArray(body?.entries) ? body.entries : []) {
    try {
      const entry = ss.parseShareInboxEntry(
        await ss.openShareJson(sealKey, ss.shareAad(ss.AAD_SHARE_INBOX_ENTRY, e.entryId), e.ct),
      );
      if (!entry) continue;
      const prev = byShare.get(entry.shareId);
      if (!prev || prev.acceptedAt < entry.acceptedAt) byShare.set(entry.shareId, { entryId: e.entryId, ...entry });
    } catch {
      /* not sealed with this account's key */
    }
  }
  return [...byShare.values()].sort((a, b) => a.serverName.localeCompare(b.serverName));
}

const sessions = new Map();
const SESSION_KEY = (shareId) => `flagship.shareSession.${shareId}`;

function cachedSession(shareId, now) {
  let s = sessions.get(shareId);
  if (!s) {
    try {
      const raw = globalThis.sessionStorage?.getItem(SESSION_KEY(shareId));
      s = raw ? JSON.parse(raw) : null;
    } catch {
      s = null;
    }
  }
  if (!s || typeof s.token !== "string" || !(s.expiresAt > now + 60_000)) return null;
  sessions.set(shareId, s);
  return s;
}

function rememberSession(shareId, s) {
  sessions.set(shareId, s);
  try {
    globalThis.sessionStorage?.setItem(SESSION_KEY(shareId), JSON.stringify(s));
  } catch {
    /* private mode: memory only */
  }
}

export function forgetShareSession(shareId) {
  sessions.delete(shareId);
  try {
    globalThis.sessionStorage?.removeItem(SESSION_KEY(shareId));
  } catch {
    /* nothing stored */
  }
}

const boxUrl = (serverDomain, path) => `https://${lower(serverDomain)}${path}`;

/**
 * Sign in to the shared box: nonce → #5 → a share session token. Throws
 * ShareError `not-shared` until the owner confirms, `share-ended` after.
 */
export async function signInToShare(entry, deps = {}, { force = false } = {}) {
  const d = ctx(deps);
  if (!force) {
    const cached = cachedSession(entry.shareId, d.now());
    if (cached) return cached;
  }
  const member = await memberKey(d, entry.shareId);
  const n = await call(d, boxUrl(entry.serverDomain, "/api/shares/nonce"));
  if (!n.ok || typeof n.body?.nonce !== "string") {
    throw new ShareError(errText(n, "Couldn't reach this server."), "unreachable", n.status);
  }
  const session = {
    serverDomain: lower(entry.serverDomain),
    shareId: entry.shareId,
    memberPubHex: member.pubHex,
    nonceHex: n.body.nonce,
    issuedAt: d.now(),
  };
  const signature = await sigHex(ss.signServerShareSession(session, member.seed));
  const res = await postJson(d, boxUrl(entry.serverDomain, "/api/shares/session"), { session, signature });
  if (res.status === 403 && (res.body?.code === "not-shared" || res.body?.error === "not-shared")) {
    throw new ShareError("The owner hasn't confirmed yet.", "not-shared", 403);
  }
  if (res.status === 403 && (res.body?.code === "share-ended" || res.body?.error === "share-ended")) {
    forgetShareSession(entry.shareId);
    throw new ShareError("This server isn't shared with you anymore.", "share-ended", 403);
  }
  if (!res.ok || typeof res.body?.token !== "string") {
    throw new ShareError(errText(res, "Couldn't sign in to this server."), "sign-in", res.status);
  }
  const s = {
    token: res.body.token,
    expiresAt: res.body.expiresAt,
    level: res.body.level === "manage" ? "manage" : "view",
    unlockAtBoot: !!res.body.unlockAtBoot,
    seeAppData: !!res.body.seeAppData,
  };
  rememberSession(entry.shareId, s);
  return s;
}

/** A box client on B's share session: `fetch(path, init)` like screensFetch,
 *  signing in again once on a 401. */
export function shareBoxClient(entry, deps = {}) {
  const d = ctx(deps);
  const run = async (path, init, token) => {
    const headers = { "x-flagship-session": token, ...(init.headers || {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return call(d, boxUrl(entry.serverDomain, path), { ...init, headers });
  };
  return {
    fqdn: lower(entry.serverDomain),
    async fetch(path, init = {}) {
      let s = await signInToShare(entry, deps);
      let res = await run(path, init, s.token);
      if (res.status === 401) {
        s = await signInToShare(entry, deps, { force: true });
        res = await run(path, init, s.token);
      }
      if (!res.ok) {
        if (res.status === 403 && res.body?.code === "share-ended") forgetShareSession(entry.shareId);
        const reason = res.body && typeof res.body === "object" && typeof res.body.error === "string" ? res.body.error : "";
        throw new ScreensError(reason || `HTTP ${res.status}`, res.status, res.body);
      }
      return res.body;
    },
  };
}

const pinnedOffers = new Map();

/** The offer (with the STK the owner pinned) and `.com`'s view of the share. */
export async function readSharedOffer(entry, deps = {}) {
  const d = ctx(deps);
  const { res } = await readShareRow(d, entry.shareId, entry.secretHex);
  if (res.status === 404 || res.status === 410) return { state: "ended", offer: pinnedOffers.get(entry.shareId) ?? null, unlock: false };
  if (!res.ok) throw new ShareError(errText(res, "Couldn't reach flagshipserver.com."), "com", res.status);
  const offer = typeof res.body?.offer === "string" ? await openOffer(entry.shareId, entry.secretHex, res.body.offer) : null;
  if (offer) pinnedOffers.set(entry.shareId, offer);
  return { state: res.body.state, offer, unlock: !!res.body.unlock };
}

/**
 * One "Shared with me" row with what's known right now: `status` is
 * "ready" (signed in; level and opt-ins from the box), "waiting" (the owner
 * hasn't confirmed), "offline", or "ended" (already removed from the inbox).
 */
export async function resolveSharedServer(entry, deps = {}) {
  try {
    const s = await signInToShare(entry, deps);
    return { entry, status: "ready", level: s.level, unlockAtBoot: s.unlockAtBoot, seeAppData: s.seeAppData };
  } catch (e) {
    let com = null;
    try {
      com = await readSharedOffer(entry, deps);
    } catch {
      com = null;
    }
    if (e?.code === "share-ended" || com?.state === "ended") {
      forgetShareSession(entry.shareId);
      await deleteInboxEntry(entry.entryId, deps).catch(() => {});
      return { entry, status: "ended" };
    }
    const offer = com?.offer ?? null;
    return {
      entry,
      status: e?.code === "not-shared" ? "waiting" : "offline",
      level: offer?.level ?? null,
      unlockAtBoot: !!com?.unlock,
      seeAppData: !!offer?.seeAppData,
    };
  }
}

export async function loadSharedWithMe(deps = {}) {
  const entries = await listSharedWithMe(deps);
  const rows = await Promise.all(entries.map((e) => resolveSharedServer(e, deps)));
  return rows.filter((r) => r.status !== "ended");
}

/** Leave: #4 to the box and to `.com`, then drop the inbox entry. */
export async function leaveShare(entry, deps = {}) {
  const d = ctx(deps);
  const member = await memberKey(d, entry.shareId);
  const leave = {
    serverDomain: lower(entry.serverDomain),
    shareId: entry.shareId,
    memberPubHex: member.pubHex,
    issuedAt: d.now(),
  };
  const signature = await sigHex(ss.signServerShareLeave(leave, member.seed));
  const token = await ss.shareTokenFromSecret(hexToBytes(entry.secretHex));
  const [boxSide, comSide] = await Promise.allSettled([
    postJson(d, boxUrl(entry.serverDomain, "/api/shares/leave"), { leave, signature }),
    postJson(d, `${d.apex}/api/server-shares/${entry.shareId}/leave`, { leave, signature }, { "x-flagship-share-token": token }),
  ]);
  const boxOk = boxSide.status === "fulfilled" && boxSide.value.ok;
  const comOk = comSide.status === "fulfilled" && (comSide.value.ok || comSide.value.status === 404);
  if (!boxOk && !comOk) throw new ShareError("Couldn't leave right now. Check your connection and try again.", "leave-failed");
  forgetShareSession(entry.shareId);
  forgetSharePush(entry.shareId, deps.storage === undefined ? defaultStorage() : deps.storage);
  if (entry.entryId) await deleteInboxEntry(entry.entryId, deps).catch(() => {});
  return { box: boxOk, com: comOk };
}

async function shareBootHeader(d, member, serverDomain, method, path) {
  const envelope = {
    role: "share",
    serverDomain: lower(serverDomain),
    method: method.toUpperCase(),
    path,
    pubKeyHex: member.pubHex,
    nonceHex: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    issuedAt: d.now(),
  };
  const signature = await signRaw(member.seed, bootSeal.canonicalBootAuth(envelope));
  const json = new TextEncoder().encode(JSON.stringify({ ...envelope, signatureHex: bytesToHex(signature) }));
  let bin = "";
  for (const b of json) bin += String.fromCharCode(b);
  return `Flagship-Boot-v1 ${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

async function signRaw(seed, bytes) {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes));
}

/** A `signWithIrk`-shaped signer over B's member key, for the envelopes B
 *  signs at manage level (`flagship/app-access/v1`). */
export async function shareMemberSigner(entry, deps = {}) {
  const member = await memberKey(ctx(deps), entry.shareId);
  return async (_umk, bytes) => signRaw(member.seed, bytes);
}

async function verifyRequest(r, stkPubHex) {
  try {
    const bytes = bootSeal.canonicalSecretRequest({
      serverDomain: r.request.serverDomain,
      stkPubHex,
      purpose: r.request.purpose,
      nonceHex: r.request.nonce,
      issuedAt: r.request.issuedAt,
    });
    const key = await crypto.subtle.importKey("raw", hexToBytes(stkPubHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(r.signature), bytes);
  } catch {
    return false;
  }
}

/**
 * Start-ups this server is waiting on that B may approve: only requests made
 * by the STK the owner pinned in the offer, signed by it.
 */
export async function fetchShareStartups(entry, deps = {}) {
  const d = ctx(deps);
  const offer = pinnedOffers.get(entry.shareId) ?? (await readSharedOffer(entry, deps)).offer;
  if (!offer) return [];
  const member = await memberKey(d, entry.shareId);
  const path = `/api/boot/share/pending/${lower(entry.serverDomain)}`;
  const res = await call(d, `${d.boot}${path}`, { headers: { authorization: await shareBootHeader(d, member, entry.serverDomain, "GET", path) } });
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) throw new ShareError(errText(res, "Couldn't check whether this server is starting."), "boot", res.status);
  const out = [];
  for (const r of Array.isArray(res.body?.requests) ? res.body.requests : []) {
    if (!r?.request || r.request.purpose !== "unlock-key") continue;
    if (lower(r.request.serverDomain) !== lower(entry.serverDomain)) continue;
    if (lower(r.request.stkPub) !== offer.stkPubHex) continue;
    if (!(await verifyRequest(r, offer.stkPubHex))) continue;
    out.push({ serverDomain: r.request.serverDomain, nonce: r.request.nonce, stkPub: offer.stkPubHex, purpose: "unlock-key", issuedAt: r.request.issuedAt });
  }
  return out;
}

/** Approve one start-up: open B's copy of the disk key, seal it for the
 *  pinned STK bound to the request, and answer the boot gate as `share`. */
export async function approveShareStartup(entry, req, deps = {}) {
  const d = ctx(deps);
  const offer = pinnedOffers.get(entry.shareId) ?? (await readSharedOffer(entry, deps)).offer;
  if (!offer) throw new ShareError("Couldn't confirm which server this is.", "no-offer");
  if (lower(req?.stkPub) !== offer.stkPubHex) {
    throw new ShareError("This start-up request doesn't come from the server that was shared with you.", "wrong-stk");
  }
  const member = await memberKey(d, entry.shareId);
  const keyPath = `/api/boot/share/key/${lower(entry.serverDomain)}`;
  const k = await call(d, `${d.boot}${keyPath}`, {
    headers: { authorization: await shareBootHeader(d, member, entry.serverDomain, "GET", keyPath) },
  });
  if (!k.ok || typeof k.body?.sealedKey !== "string") {
    throw new ShareError(errText(k, "The owner hasn't let you approve start-ups."), "no-copy", k.status);
  }
  let diskKey;
  try {
    diskKey = await bootSeal.openSealedWithEd25519Seed(hexToBytes(k.body.sealedKey), member.seed);
  } catch {
    throw new ShareError("Couldn't open your copy of the disk key.", "copy");
  }
  const sealed = await bootSeal.buildSealedResponse(diskKey, {
    stkEdPub: hexToBytes(offer.stkPubHex),
    nonceHex: req.nonce,
    purpose: "unlock-key",
  });
  const path = "/api/boot/response";
  const res = await postJson(
    d,
    `${d.boot}${path}`,
    {
      response: {
        serverDomain: lower(entry.serverDomain),
        requestNonceHex: req.nonce,
        purpose: "unlock-key",
        sealed: bytesToHex(sealed),
        issuedAt: d.now(),
      },
    },
    { authorization: await shareBootHeader(d, member, entry.serverDomain, "POST", path) },
  );
  if (!res.ok) throw new ShareError(errText(res, "Couldn't approve the start-up."), "approve-failed", res.status);
  return { ok: true };
}

// ── Start-up notices (B, part of unlock at boot) ──────────────────────

const PUSH_KEY = (shareId) => `flagship.sharePush.v1.${shareId}`;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** This device's registration for a share's start-up notices, or null. */
export function sharePushState(shareId, storage = defaultStorage()) {
  try {
    const v = JSON.parse(storage?.getItem(PUSH_KEY(shareId)) ?? "null");
    return v && typeof v.platform === "string" && /^[0-9a-f]{64}$/.test(v.tokenSha256 ?? "") ? v : null;
  } catch {
    return null;
  }
}

function forgetSharePush(shareId, storage = defaultStorage()) {
  try {
    storage?.removeItem(PUSH_KEY(shareId));
  } catch {
    /* nothing stored */
  }
}

/**
 * Turn this device's start-up notices for a share on or off: #10 signed by
 * the member key, posted to `.com` with the link token. On sends this
 * browser's Web Push subscription; off withdraws the one sent before.
 * `deps.providerToken()` and `deps.storage` are for tests.
 */
export async function setSharePush(entry, on, deps = {}) {
  const d = ctx(deps);
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const member = await memberKey(d, entry.shareId);
  const prev = sharePushState(entry.shareId, storage);
  let platform = "webpush";
  let providerToken = null;
  let tokenSha256;
  if (on) {
    const get = deps.providerToken ?? (async () => (await import("./push.js")).webPushProviderToken());
    try {
      providerToken = await get();
    } catch (e) {
      throw new ShareError(`This browser can't show notifications: ${humanError(e)}`, "no-push");
    }
    tokenSha256 = await ss.shareSha256Hex(providerToken);
  } else {
    if (!prev) return { ok: true, on: false };
    platform = prev.platform;
    tokenSha256 = prev.tokenSha256;
  }
  const push = {
    serverDomain: lower(entry.serverDomain),
    shareId: entry.shareId,
    memberPubHex: member.pubHex,
    op: on ? "put" : "delete",
    platform,
    tokenSha256,
    issuedAt: d.now(),
  };
  const signature = await sigHex(ss.signServerSharePush(push, member.seed));
  const token = await ss.shareTokenFromSecret(hexToBytes(entry.secretHex));
  const res = await postJson(
    d,
    `${d.apex}/api/server-shares/${entry.shareId}/push`,
    { push, signature, ...(on ? { providerToken } : {}) },
    { "x-flagship-share-token": token },
  );
  if (!on) {
    forgetSharePush(entry.shareId, storage);
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new ShareError(errText(res, "Couldn't turn notices off. Try again."), "push-failed", res.status);
    }
    return { ok: true, on: false };
  }
  if (res.status === 403 && res.body?.code === "unlock-not-shared") {
    throw new ShareError(NOTIFY_NOT_ALLOWED, "unlock-not-shared", 403);
  }
  if (!res.ok) throw new ShareError(errText(res, "Couldn't turn notices on. Try again."), "push-failed", res.status);
  try {
    storage?.setItem(PUSH_KEY(entry.shareId), JSON.stringify({ platform, tokenSha256 }));
  } catch {
    /* private mode: the switch shows off next time */
  }
  return { ok: true, on: true };
}

// ── Server updates (B at manage level) ────────────────────────────────

const UPDATE_ERRORS = {
  busy: "An update is already underway.",
  "pending-verify": "An update is already underway.",
  "from-commit-mismatch": "The server changed version. Refresh and try again.",
  "manage-only": "Only someone who can manage this server can update it.",
  stale: "Your device's clock looks off. Check it and try again.",
};

/**
 * Move a shared server to an endorsed release: #11 signed by the member key,
 * straight to the box over the share session. The box checks the release's
 * endorsement as it does for the owner; its verdict shows in server-detail's
 * `lastUpdate`.
 */
export async function orderShareUpdate(entry, { targetCommit, fromCommit }, deps = {}) {
  const d = ctx(deps);
  const member = await memberKey(d, entry.shareId);
  const random = deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const update = {
    serverDomain: lower(entry.serverDomain),
    shareId: entry.shareId,
    memberPubHex: member.pubHex,
    targetCommit: lower(targetCommit),
    fromCommit: lower(fromCommit),
    nonce: bytesToHex(random(32)),
    issuedAt: d.now(),
  };
  let signature;
  try {
    signature = await sigHex(ss.signServerShareUpdate(update, member.seed));
  } catch {
    throw new ShareError("This server hasn't reported its version yet. Refresh and try again.", "bad-order");
  }
  const client = deps.client ?? shareBoxClient(entry, deps);
  try {
    return await client.fetch("/api/shares/update", { method: "POST", body: JSON.stringify({ update, signature }) });
  } catch (e) {
    const code = e?.body?.code;
    const text = UPDATE_ERRORS[code] ?? (typeof e?.body?.error === "string" ? e.body.error : humanError(e));
    throw new ShareError(text, code ?? "update-failed", e?.status);
  }
}
