// An organization's seat invitation opened in the browser (docs/enterprise-accounts.md §7):
// /org-join#o=<orgId>&s=<seatId>&k=<link key>. The key rides in the fragment and never reaches a
// server; it opens the offer the inviter sealed (AES-GCM, nonce || ciphertext || tag). The webapp
// holds no seat keys (accepting signs with ML-DSA keys only the phone app holds), so it shows the
// invitation and hands the same link to the phone.

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

/** Opens the sealed offer with the link key. */
export async function openOrgOffer(offerHex, keyHex) {
  const sealed = bytes(offerHex);
  if (sealed.length < 12 + 16) throw Object.assign(new Error("offer"), { code: "org-offer" });
  const key = await crypto.subtle.importKey("raw", bytes(keyHex), "AES-GCM", false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12));
  } catch {
    throw Object.assign(new Error("offer"), { code: "org-offer" });
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Fetches the invitation and the org's authority, opens the offer and checks it names this org,
 * this seat and the genesis `.com` recorded. `fetchImpl` is a test seam.
 */
export async function loadOrgInvite(link, fetchImpl = fetch) {
  const base = `${controlApex()}/api/orgs/${link.orgId}`;
  const r = await fetchImpl(`${base}/invites/${link.seatId}`);
  if (r.status === 410) throw Object.assign(new Error("expired"), { code: "org-invite-expired" });
  if (!r.ok) throw Object.assign(new Error("invite"), { code: "org-invite-missing" });
  const inv = await r.json();
  const offer = await openOrgOffer(inv.offerHex, link.keyHex);
  const a = await fetchImpl(`${base}/authority`);
  if (!a.ok) throw Object.assign(new Error("authority"), { code: "org-invite-missing" });
  const auth = await a.json();
  if (offer.orgId !== link.orgId || offer.seatId !== link.seatId || inv.invite?.seatId !== link.seatId || offer.genesisHash !== auth.org?.genesisHash) {
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
