/**
 * Direct names (docs/direct-access-and-domains.md §2-§5, §6 step 3): a name on the direct domain (`fshp.app`) whose
 * DNS records point at the owner's own infrastructure, never at the relay.
 *
 *   flagship/direct-name/v1|<name>|<serverDomain>|<on|off>|<addresses>|<caa>|<issuedAt>
 *
 * The owner's order for one name, signed like every sensitive order (admin root; the IRK only on an account that
 * pins none). `name` is the full name (`game--john-doe.fshp.app`), one label under the direct apex.
 * `serverDomain` is the box that holds the name's certificate. `addresses` empty means "the box's own direct
 * addresses" (the newest accepted `direct-address/v1` update inside the box's `direct-access/v1` order, or before
 * any update the order's exact addresses); a non-empty list is exactly what the owner wants published (A for IPv4,
 * AAAA for IPv6), which may be another host. `caa` is `pin` (the default: a CAA record so only the issuance
 * service's ACME account can get a certificate for the name) or `off` (the owner runs the name on a host that gets
 * its own certificate). "off" carries no address. A newer order for the same name replaces the older one.
 *
 * Special-purpose addresses are refused exactly as in `direct-access/v1`: public DNS pointing at a private address
 * is a DNS-rebinding vector against visitors' own networks.
 */
import { ed } from "./edSync.js";
import { isPublicAddress } from "./addressPolicy.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import { canonicalIp, DIRECT_MAX_ADDRESSES } from "./directAccess.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_DIRECT_NAME = "flagship/direct-name/v1";
export const DIRECT_APEX = "fshp.app";

export type DirectNameCaa = "pin" | "off";
export type DirectNameKind = "derived" | "vanity";

export interface DirectNameOrder {
  /** Full name, lowercase: `<label>.<direct apex>`. */
  name: string;
  serverDomain: string;
  enabled: boolean;
  /** Empty: follow the box's direct addresses. Otherwise exact public addresses, canonical text. */
  addresses: string[];
  caa: DirectNameCaa;
  /** Unix ms. */
  issuedAt: number;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The username and app-slug rules of `@flagship/services-zone` (validation.ts). */
const USER = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const SLUG = /^[a-z0-9](?:-?[a-z0-9]){0,29}$/;

/**
 * Labels nobody may hold on the direct domain: the website mirror's old labels, our own names, and names that look
 * like infrastructure.
 */
export const RESERVED_DIRECT_LABELS: ReadonlySet<string> = new Set([
  "www",
  "webapp",
  "remote",
  "recovery",
  "boot",
  "web",
  "api",
  "app",
  "apps",
  "admin",
  "mail",
  "smtp",
  "imap",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "relay",
  "status",
  "docs",
  "help",
  "support",
  "security",
  "abuse",
  "flagship",
  "flagshipserver",
  "fshp",
  "voici",
  "inference",
  "_psl",
]);

/** The label of `name` under `apex`, or null when it is not exactly one valid label deeper. */
export function directLabelOf(name: string, apex = DIRECT_APEX): string | null {
  if (typeof name !== "string" || name !== name.toLowerCase()) return null;
  const suffix = `.${apex}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}

/**
 * What a label is: `derived` for `<slug>--<creator>` (docs/service-addressing-double-dash.md), `vanity` for a
 * plain label (no `--`), null when it is neither (two `--`, a bad half, a reserved word, punycode).
 */
export function directNameKind(label: string): { kind: "derived"; slug: string; creator: string } | { kind: "vanity" } | null {
  if (!LABEL.test(label) || label.startsWith("xn--") || RESERVED_DIRECT_LABELS.has(label)) return null;
  const parts = label.split("--");
  if (parts.length === 1) return { kind: "vanity" };
  if (parts.length !== 2) return null;
  const [slug, creator] = parts as [string, string];
  if (!SLUG.test(slug) || !USER.test(creator) || creator.includes("--")) return null;
  return { kind: "derived", slug, creator };
}

/** Why an order can't be signed or taken, as a reason code, or null when its shape is fine. */
export function directNameOrderProblem(o: DirectNameOrder, apex = DIRECT_APEX): string | null {
  if (!o || typeof o !== "object") return "malformed";
  if (typeof o.name !== "string") return "malformed";
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

export function canonicalDirectNameOrder(o: DirectNameOrder): Bytes {
  legacyFieldGuard("name", o.name);
  legacyFieldGuard("serverDomain", o.serverDomain);
  legacyFieldGuard("caa", o.caa);
  if (!Number.isSafeInteger(o.issuedAt)) throw new Error("direct-name issuedAt must be an integer");
  for (const a of o.addresses) {
    legacyFieldGuard("address", a);
    if (a.includes(",")) throw new Error("direct-name address contains ','");
  }
  return new TextEncoder().encode(
    [TAG_DIRECT_NAME, o.name, o.serverDomain, o.enabled ? "on" : "off", [...o.addresses].sort().join(","), o.caa, String(o.issuedAt)].join("|"),
  );
}

/** Sign with the sensitive-order key (admin root, or the IRK on an account that pins none). */
export function signDirectNameOrder(o: DirectNameOrder, key: Keypair, apex = DIRECT_APEX): Bytes {
  const problem = directNameOrderProblem(o, apex);
  if (problem) throw new Error(`direct-name order refused: ${problem}`);
  return ed.sign(canonicalDirectNameOrder(o), key.privateKey);
}

/** Never throws. An order with a bad shape never verifies. */
export function verifyDirectNameOrder(o: DirectNameOrder, sig: Bytes, pub: Bytes, apex = DIRECT_APEX): boolean {
  try {
    if (directNameOrderProblem(o, apex)) return false;
    return ed.verify(sig, canonicalDirectNameOrder(o), pub);
  } catch {
    return false;
  }
}

/** Read an order object with exactly its fields; null on any other shape. */
export function parseDirectNameOrder(raw: unknown): DirectNameOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = ["name", "serverDomain", "enabled", "addresses", "caa", "issuedAt"];
  const have = Object.keys(o);
  if (have.length !== keys.length || !keys.every((k) => have.includes(k))) return null;
  if (
    typeof o.name !== "string" ||
    typeof o.serverDomain !== "string" ||
    typeof o.enabled !== "boolean" ||
    !Array.isArray(o.addresses) ||
    !o.addresses.every((a) => typeof a === "string") ||
    (o.caa !== "pin" && o.caa !== "off") ||
    typeof o.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    name: o.name,
    serverDomain: o.serverDomain,
    enabled: o.enabled,
    addresses: [...(o.addresses as string[])],
    caa: o.caa,
    issuedAt: o.issuedAt,
  };
}
