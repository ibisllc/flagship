// The org read token (docs/account-read-token.md "Org routes"): `.com` serves an org's reads only to a
// bearer of one. This browser mints it as `seat:<seatId>` with the seat member key (derived from the
// account key per org, so no passkey prompt), keeps it in memory until 10 minutes before it expires,
// and mints again once when `.com` answers 401. A seat waiting for an admin mints the same way and
// reads only the chain. The plan and the invite offer need no token.

import * as org from "../vendor/flagship-org/org.js";

const REFRESH_MARGIN_MS = 10 * 60_000;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ORG_GET = /^\/api\/orgs\/([0-9a-f]{32})\/(.+)$/;

const cache = new Map();

/** The org a GET of `path` reads with a token, or null (the public plan, the invite offer, anything else). */
export function orgReadPathOrg(path) {
  const m = ORG_GET.exec(String(path).split("?")[0]);
  if (!m) return null;
  const sub = m[2];
  if (sub === "plan" || sub === "read-token" || sub.startsWith("invites/")) return null;
  return m[1];
}

/** The signed mint request (`flagship/org-read-token-request/v1`) for `seatId` under its member key. */
export function orgSeatReadTokenRequest(umk, orgId, seatId, now = Date.now(), nonce = crypto.getRandomValues(new Uint8Array(16))) {
  const member = org.deriveOrgSeatMemberSeeds(umk, orgId);
  try {
    const request = { orgId, subject: org.orgSeatReadSubject(seatId), pubHex: hex(org.ed.getPublicKey(member.edSeed)), issuedAt: now, nonceHex: hex(nonce) };
    const signature = org.signOrgReadTokenRequest(request, (m) => org.ed.sign(m, member.edSeed));
    return { request, signature };
  } finally {
    member.edSeed.fill(0);
    member.mldsaSeed.fill(0);
    member.hybridSecret.fill(0);
  }
}

/** A token for `orgId` as `seatId`, from memory or a fresh mint; null when none can be had. */
export async function orgReadToken({ base, fetch: f, umk, orgId, seatId, now = Date.now(), fresh = false }) {
  const key = `${orgId}|${seatId}`;
  const held = cache.get(key);
  if (!fresh && held && now < held.expiresAt - REFRESH_MARGIN_MS) return held.token;
  cache.delete(key);
  if (!(umk instanceof Uint8Array) || umk.length !== 32) return null;
  const body = orgSeatReadTokenRequest(umk, orgId, seatId, now);
  const res = await f(`${base}${org.orgReadTokenPath(orgId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  let json = {};
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (typeof json.token !== "string" || typeof json.expiresAt !== "number") return null;
  cache.set(key, { token: json.token, expiresAt: json.expiresAt });
  return json.token;
}

/** Forget every held token (sign-out, lock, a profile switch). */
export function forgetOrgReadTokens() {
  cache.clear();
}
