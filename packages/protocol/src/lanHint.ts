/**
 * STK-signed LAN hint — where a box can be reached directly on its local
 * network (docs/lan-direct.md).
 *
 * The box serves this to its paired devices over the normal relayed, pinned
 * TLS connection; a device verifies it under the STK it derives from its own
 * UMK (the same anchor as the daemon-status report) before it ever dials a
 * local address. `.com` never sees it: LAN topology stays between the box and
 * its owner's devices.
 *
 * It is a SEPARATE message from the daemon-status report on purpose: that
 * report's canonical bytes are pinned by every installed client, so growing it
 * would make old clients fail their hard-fail cert pin.
 *
 * Canonical bytes:
 *
 *   flagship/lan-hint/v1|<serverDomain>|<certSha256>|<endpoints>|<issuedAt>|<expiresAt>
 *
 * `endpoints` is the sorted, ","-joined list of `<ipv4>:<port>` /
 * `[<ipv6>]:<port>`. `certSha256` binds the hint to the leaf cert the device
 * pins, so a hint outlives neither a cert rotation nor the cert it vouches for.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export interface LanEndpoint {
  address: string;
  port: number;
}

export interface LanHint {
  serverDomain: string;
  /** Leaf-cert SHA-256, lowercase hex — the cert the device must pin. */
  certSha256: string;
  endpoints: LanEndpoint[];
  issuedAt: number;
  expiresAt: number;
}

const TAG_LAN_HINT = "flagship/lan-hint/v1";
/** A hint lives at most a day; the box re-issues on every fetch. */
export const LAN_HINT_MAX_TTL_MS = 24 * 60 * 60_000;
export const LAN_HINT_MAX_ENDPOINTS = 8;
const CLOCK_SKEW_MS = 5 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * True only for addresses that can only mean "this local network": IPv4
 * RFC 1918 (10/8, 172.16/12, 192.168/16) and IPv6 unique-local (fc00::/7).
 * Everything else — public, loopback, link-local, CGNAT (100.64/10),
 * multicast, unspecified, IPv4-mapped IPv6 — is refused, so a hint can never
 * steer a device to the internet or to itself.
 */
export function isLanAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    const [a, b] = o as [number, number, number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!address.includes(":") || address.includes(".")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(address)) return false;
  const first = address.split(":")[0]!;
  if (first.length === 0 || first.length > 4) return false;
  return (parseInt(first, 16) & 0xfe00) === 0xfc00;
}

export function formatLanEndpoint(e: LanEndpoint): string {
  return e.address.includes(":") ? `[${e.address.toLowerCase()}]:${e.port}` : `${e.address}:${e.port}`;
}

export function canonicalLanHint(h: LanHint): Bytes {
  legacyFieldGuard("serverDomain", h.serverDomain);
  legacyFieldGuard("certSha256", h.certSha256);
  const endpoints = h.endpoints.map(formatLanEndpoint).sort();
  for (const e of endpoints) legacyFieldGuard("endpoint", e);
  return new TextEncoder().encode(
    [
      TAG_LAN_HINT,
      h.serverDomain,
      h.certSha256,
      endpoints.join(","),
      String(h.issuedAt),
      String(h.expiresAt),
    ].join("|"),
  );
}

export function signLanHint(h: LanHint, identity: MsgSigner): Bytes {
  return resolveMsgSigner(identity)(canonicalLanHint(h));
}

export type LanHintCheck = { ok: true } | { ok: false; reason: string };

/**
 * Accept a hint only if the STK signature holds AND it is well-formed for the
 * box the device is talking to: same domain, same pinned cert, current, and
 * every endpoint a LAN address. A box never emits a non-LAN endpoint, so one
 * is treated as tampering and the whole hint is refused.
 */
export function checkLanHint(
  h: LanHint,
  sig: Bytes,
  stkPub: Bytes,
  expect: { serverDomain: string; certSha256: string; now: number },
): LanHintCheck {
  let sigOk = false;
  try {
    sigOk = ed.verify(sig, canonicalLanHint(h), stkPub);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "bad-signature" };
  if (h.serverDomain.toLowerCase() !== expect.serverDomain.toLowerCase()) {
    return { ok: false, reason: "wrong-server" };
  }
  if (!HEX64.test(h.certSha256) || h.certSha256 !== expect.certSha256.toLowerCase()) {
    return { ok: false, reason: "cert-mismatch" };
  }
  if (h.issuedAt > expect.now + CLOCK_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  if (h.expiresAt <= expect.now) return { ok: false, reason: "expired" };
  if (h.expiresAt - h.issuedAt > LAN_HINT_MAX_TTL_MS) return { ok: false, reason: "ttl-too-long" };
  if (h.endpoints.length === 0 || h.endpoints.length > LAN_HINT_MAX_ENDPOINTS) {
    return { ok: false, reason: "bad-endpoint-count" };
  }
  for (const e of h.endpoints) {
    if (!isLanAddress(e.address)) return { ok: false, reason: "non-lan-endpoint" };
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
      return { ok: false, reason: "bad-port" };
    }
  }
  return { ok: true };
}
