// Direct names (docs/direct-access-and-domains.md §8): one name per app on the
// direct domain, whose records point at the owner's own server, never at the
// relay. The admin device signs one sensitive order per name:
//
//   flagship/direct-name/v1|<name>|<serverDomain>|<on|off>|<addresses>|<caa>|<issuedAt>
//
// Port of packages/protocol/src/directName.ts. Must pass
// packages/protocol/test-vectors/direct-name/vectors.json.

import { bytesToHex, hexToBytes, verifyWithEd25519Pub } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { getSession } from "./state.js";
import { canonicalIp, isPublicAddress, DIRECT_MAX_ADDRESSES, DirectOrderRefused } from "./directAccess.js";

export const TAG_DIRECT_NAME = "flagship/direct-name/v1";
export const DIRECT_APEX = "fshp.app";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const USER = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const SLUG = /^[a-z0-9](?:-?[a-z0-9]){0,29}$/;

export const RESERVED_DIRECT_LABELS = new Set([
  "www", "webapp", "remote", "recovery", "boot", "web", "api", "app", "apps", "admin", "mail", "smtp", "imap",
  "ns", "ns1", "ns2", "dns", "relay", "status", "docs", "help", "support", "security", "abuse", "flagship",
  "flagshipserver", "fshp", "voici", "inference", "_psl",
]);

/** The label of `name` under `apex`, or null when it isn't exactly one valid label deeper. */
export function directLabelOf(name, apex = DIRECT_APEX) {
  if (typeof name !== "string" || name !== name.toLowerCase()) return null;
  const suffix = `.${apex}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}

/** `{kind: "derived", slug, creator}`, `{kind: "vanity"}`, or null for a label nobody may hold. */
export function directNameKind(label) {
  if (typeof label !== "string" || !LABEL.test(label) || label.startsWith("xn--") || RESERVED_DIRECT_LABELS.has(label)) return null;
  const parts = label.split("--");
  if (parts.length === 1) return { kind: "vanity" };
  if (parts.length !== 2) return null;
  const [slug, creator] = parts;
  if (!SLUG.test(slug) || !USER.test(creator)) return null;
  return { kind: "derived", slug, creator };
}

/** `<slug>--<creator>.<apex>`, or null when the label can't be held. */
export function derivedDirectName(slug, creator, apex = DIRECT_APEX) {
  const label = `${String(slug ?? "").toLowerCase()}--${String(creator ?? "").toLowerCase()}`;
  return directNameKind(label)?.kind === "derived" ? `${label}.${apex}` : null;
}

/** The reason code an order can't be signed or taken, or null. */
export function directNameOrderProblem(o, apex = DIRECT_APEX) {
  if (!o || typeof o !== "object" || typeof o.name !== "string") return "malformed";
  const label = directLabelOf(o.name, apex);
  if (!label || !directNameKind(label)) return "bad-name";
  if (typeof o.serverDomain !== "string" || o.serverDomain.length === 0 || /[|,\s]/.test(o.serverDomain)) return "no-server";
  if (typeof o.enabled !== "boolean" || !Array.isArray(o.addresses)) return "malformed";
  if (o.caa !== "pin" && o.caa !== "off") return "bad-caa";
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt <= 0) return "bad-time";
  if (!o.enabled) return o.addresses.length === 0 ? null : "off-with-addresses";
  if (o.addresses.length > DIRECT_MAX_ADDRESSES) return "too-many";
  for (const a of o.addresses) {
    if (typeof a !== "string") return "malformed";
    const c = canonicalIp(a);
    if (!c) return "bad-address";
    if (c !== a) return "non-canonical-address";
    if (!isPublicAddress(a)) return "private-address";
  }
  if (new Set(o.addresses).size !== o.addresses.length) return "duplicate";
  return null;
}

function guard(name, v) {
  if (/[|\x00-\x1f\x7f]/.test(v)) throw new Error(`${name} contains a separator or control character`);
}

export function canonicalDirectNameOrder(o) {
  guard("name", o.name);
  guard("serverDomain", o.serverDomain);
  guard("caa", o.caa);
  if (!Number.isSafeInteger(o.issuedAt)) throw new Error("direct-name issuedAt must be an integer");
  for (const a of o.addresses) {
    guard("address", a);
    if (a.includes(",")) throw new Error("direct-name address contains ','");
  }
  return new TextEncoder().encode(
    [TAG_DIRECT_NAME, o.name, o.serverDomain, o.enabled ? "on" : "off", [...o.addresses].sort().join(","), o.caa, String(o.issuedAt)].join("|"),
  );
}

/** True only for a well-formed order whose signature verifies under `pubHex`. Never throws. */
export async function verifyDirectNameOrder(o, signatureHex, pubHex, apex = DIRECT_APEX) {
  try {
    if (directNameOrderProblem(o, apex)) return false;
    if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^[0-9a-f]{64}$/.test(pubHex)) return false;
    return await verifyWithEd25519Pub(hexToBytes(pubHex), hexToBytes(signatureHex), canonicalDirectNameOrder(o));
  } catch {
    return false;
  }
}

/** Sign `{order, signatureHex}` with the sensitive-order key. Throws {@link DirectOrderRefused} before signing a bad order. */
export async function signDirectNameOrder(order, deps = {}) {
  const problem = directNameOrderProblem(order, deps.apex ?? DIRECT_APEX);
  if (problem) throw new DirectOrderRefused(problem);
  const umk = deps.umk ?? getSession()?.umk;
  if (!umk) throw new DirectOrderRefused("locked");
  const sign = deps.sign ?? sensitiveSigner();
  const sig = await sign(umk, canonicalDirectNameOrder(order));
  return { order, signatureHex: bytesToHex(sig) };
}
