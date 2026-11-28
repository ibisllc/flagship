// An organization's seat invitation opened in the browser (docs/enterprise-accounts.md §7):
// /org-join#o=<orgId>&s=<seatId>&k=<link key>. The key rides in the fragment and never reaches a
// server. It derives the offer key, which opens the offer the inviter sealed (AES-GCM, nonce ||
// ciphertext || tag), and the invite key, whose signature `.com` needs before it serves the offer or
// takes an accept. Joining on this browser is lib/orgSeat.js (docs/webapp-key-custody.md item 1); the
// same link also opens on a phone.

import * as org from "../vendor/flagship-org/org.js";
import { controlApex } from "./apex.js";

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;

/** Parses an org-join link; null when it is not one. */
export function parseOrgJoinLink(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.pathname.replace(/\/+$/, "") !== "/org-join") return null;
  const p = new URLSearchParams(u.hash.replace(/^#/, ""));
  const orgId = p.get("o") ?? "";
  const seatId = p.get("s") ?? "";
  const keyHex = p.get("k") ?? "";
  if (!HEX16.test(orgId) || !HEX16.test(seatId) || !HEX32.test(keyHex)) return null;
  return { orgId, seatId, keyHex, link: `${controlApex()}/org-join#o=${orgId}&s=${seatId}&k=${keyHex}` };
}

const bytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** The offer key and the invite key the link key derives (wipe `hybridSecret` after use). */
export function inviteKeys(keyHex) {
  return org.deriveOrgInviteKeys(bytes(keyHex));
}

/** Opens the sealed offer with the offer key the link key derives. */
export async function openOrgOffer(offerHex, keyHex) {
  const sealed = bytes(offerHex);
  if (sealed.length < 12 + 16) throw Object.assign(new Error("offer"), { code: "org-offer" });
  const k = inviteKeys(keyHex);
  k.hybridSecret.fill(0);
  const key = await crypto.subtle.importKey("raw", k.offerKey, "AES-GCM", false, ["decrypt"]);
  k.offerKey.fill(0);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12));
  } catch {
    throw Object.assign(new Error("offer"), { code: "org-offer" });
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

/** The headers that prove the link key to `GET /api/orgs/<orgId>/invites/<seatId>` (fresh for 5 minutes). */
export function inviteReadHeaders(link, now = Date.now()) {
  const k = inviteKeys(link.keyHex);
  try {
    return { "x-flagship-issued-at": String(now), "x-flagship-signature": org.orgInviteReadSignature(k.hybridSecret, link.orgId, link.seatId, now) };
  } finally {
    k.hybridSecret.fill(0);
    k.offerKey.fill(0);
  }
}

/**
 * Fetches the invitation and the org's authority, opens the offer and checks it names this org,
 * this seat and the genesis `.com` recorded. `fetchImpl` is a test seam.
 */
export async function loadOrgInvite(link, fetchImpl = fetch) {
  const base = `${controlApex()}/api/orgs/${link.orgId}`;
  const r = await fetchImpl(`${base}/invites/${link.seatId}`, { headers: inviteReadHeaders(link), cache: "no-store" });
  if (r.status === 410) throw Object.assign(new Error("expired"), { code: "org-invite-expired" });
  if (!r.ok) throw Object.assign(new Error("invite"), { code: "org-invite-missing" });
  const inv = await r.json();
  const offer = await openOrgOffer(inv.offerHex, link.keyHex);
  const a = await fetchImpl(`${base}/authority`);
  if (!a.ok) throw Object.assign(new Error("authority"), { code: "org-invite-missing" });
  const auth = await a.json();
  const pub = inviteKeys(link.keyHex);
  pub.hybridSecret.fill(0);
  pub.offerKey.fill(0);
  if (offer.orgId !== link.orgId || offer.seatId !== link.seatId || inv.invite?.seatId !== link.seatId || inv.invite?.inviteKeyPub !== pub.inviteKeyPub || offer.genesisHash !== auth.org?.genesisHash) {
    throw Object.assign(new Error("mismatch"), { code: "org-offer" });
  }
  return {
    orgName: String(offer.orgName ?? auth.org?.name ?? ""),
    pseudonym: String(offer.pseudonym ?? ""),
    roles: Array.isArray(inv.roles) ? inv.roles : [],
    expiresAt: Number(inv.invite?.expiresAt ?? 0),
    accepted: inv.accepted === true,
  };
}
