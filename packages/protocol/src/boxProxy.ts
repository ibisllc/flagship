// A box's outbound proxy (docs/outbound-proxy.md).
//
// The owner can make a box reach the internet through an HTTP CONNECT or
// SOCKS5 proxy, so Flagship's hub, `.com` and everything else the box talks to
// see the proxy's address instead of the box's. Which proxy a box uses is a
// sensitive order (it decides who sees all of the box's traffic metadata, and
// a bad one takes the box offline): signed by the admin master root when one
// is pinned, else the account IRK, and verified by the box. The same signed
// order rides in the recipe (as the unsigned `outboundProxy` sibling) so a new
// box uses the proxy from its first connection, and later edits reach the box
// over the paired session.
//
// Credentials are never part of the signed order: they travel beside it (the
// paired session's TLS, or the recipe only when the owner typed them there),
// so the order itself stays secret-free and can sit in a recipe file.

import { ed } from "./edSync.js";
import { hex, validateNoSepCtrl, type MsgSigner, resolveMsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BOX_PROXY = "flagship/box-proxy/v1";
/** A later edit must be issued within this window of the box's clock. */
export const BOX_PROXY_MAX_SKEW_MS = 10 * 60_000;

export type BoxProxyKind = "none" | "socks5" | "http";
export const BOX_PROXY_KINDS: readonly BoxProxyKind[] = ["none", "socks5", "http"];

export interface BoxProxy {
  /** The box this order is for, lowercase. */
  serverDomain: string;
  kind: BoxProxyKind;
  /** Lowercase hostname, IPv4, or IPv6 without brackets; "" when kind is none. */
  host: string;
  /** 1..65535; 0 when kind is none. */
  port: number;
  /** The proxy needs a username and password (sent beside the order). */
  auth: boolean;
  /** When the proxy can't be reached, the box may connect directly. */
  fallbackDirect: boolean;
  issuedAt: number;
  /** 32 random bytes, lowercase hex. */
  nonce: string;
}

export interface SignedBoxProxy {
  proxy: BoxProxy;
  signature: string;
}

export interface BoxProxyCredentials {
  username: string;
  password: string;
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/;

/** Why `host` is not an acceptable proxy host, or null when it is. Expects normalized input. */
export function boxProxyHostError(host: string): string | null {
  if (host.length === 0) return "Enter the proxy's address.";
  if (host.length > 253) return "That address is too long.";
  if (host.includes(":")) {
    return IPV6.test(host) && host.split(":").length >= 3 ? null : "That isn't a valid IPv6 address.";
  }
  if (IPV4.test(host)) return null;
  if (/^[0-9.]+$/.test(host)) return "That isn't a valid IPv4 address.";
  const labels = host.split(".");
  if (labels.every((l) => HOSTNAME_LABEL.test(l))) return null;
  return "Use a host name or an IP address, without a scheme, path or port.";
}

/** Trim, lowercase and drop IPv6 brackets: what the apps do to typed input before signing. */
export function normalizeBoxProxyHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Why the credentials can't be used, or null. SOCKS5 caps both at 255 bytes (RFC 1929). */
export function boxProxyCredentialsError(c: BoxProxyCredentials): string | null {
  const enc = new TextEncoder();
  const bad = (s: string) => [...s].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (typeof c?.username !== "string" || typeof c?.password !== "string") return "Enter a username and password.";
  const u = enc.encode(c.username).length;
  const p = enc.encode(c.password).length;
  if (u === 0 || p === 0) return "Enter a username and password.";
  if (u > 255 || p > 255) return "The username and password can be at most 255 bytes each.";
  if (c.username.includes(":")) return "The username can't contain a colon.";
  if (bad(c.username) || bad(c.password)) return "The username and password can't contain control characters.";
  return null;
}

export function canonicalBoxProxy(p: BoxProxy): Bytes {
  validateNoSepCtrl("serverDomain", p.serverDomain);
  if (p.serverDomain.length === 0 || p.serverDomain !== p.serverDomain.toLowerCase()) {
    throw new Error("serverDomain must be non-empty and lowercase");
  }
  if (!BOX_PROXY_KINDS.includes(p.kind)) throw new Error("kind must be none, socks5 or http");
  if (typeof p.auth !== "boolean" || typeof p.fallbackDirect !== "boolean") {
    throw new Error("auth and fallbackDirect must be booleans");
  }
  if (p.kind === "none") {
    if (p.host !== "" || p.port !== 0 || p.auth || p.fallbackDirect) {
      throw new Error("kind none carries no host, port, auth or fallback");
    }
  } else {
    if (typeof p.host !== "string" || normalizeBoxProxyHost(p.host) !== p.host) {
      throw new Error("host must be normalized (lowercase, no brackets, no trailing dot)");
    }
    const why = boxProxyHostError(p.host);
    if (why) throw new Error(`host: ${why}`);
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error("port must be 1..65535");
  }
  if (!/^[0-9a-f]{64}$/.test(p.nonce)) throw new Error("nonce must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(p.issuedAt) || p.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode(
    [
      TAG_BOX_PROXY,
      p.serverDomain,
      p.kind,
      p.host,
      p.port,
      p.auth ? "1" : "0",
      p.fallbackDirect ? "1" : "0",
      p.issuedAt,
      p.nonce,
    ].join("|"),
  );
}

export function signBoxProxy(p: BoxProxy, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalBoxProxy(p)));
}

export function verifyBoxProxy(p: BoxProxy, signatureHex: string, pub: Bytes): boolean {
  try {
    if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
    return ed.verify(sig, canonicalBoxProxy(p), pub);
  } catch {
    return false;
  }
}

/** Parse an untrusted `{proxy, signature}` into its typed shape, or null. Does not verify. */
export function parseSignedBoxProxy(raw: unknown): SignedBoxProxy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { proxy?: Partial<BoxProxy>; signature?: unknown };
  const p = r.proxy;
  if (
    !p || typeof p.serverDomain !== "string" || typeof p.kind !== "string" ||
    typeof p.host !== "string" || typeof p.port !== "number" ||
    typeof p.auth !== "boolean" || typeof p.fallbackDirect !== "boolean" ||
    typeof p.issuedAt !== "number" || typeof p.nonce !== "string" ||
    typeof r.signature !== "string"
  ) return null;
  const proxy: BoxProxy = {
    serverDomain: p.serverDomain,
    kind: p.kind as BoxProxyKind,
    host: p.host,
    port: p.port,
    auth: p.auth,
    fallbackDirect: p.fallbackDirect,
    issuedAt: p.issuedAt,
    nonce: p.nonce,
  };
  try {
    canonicalBoxProxy(proxy);
  } catch {
    return null;
  }
  return { proxy, signature: r.signature.toLowerCase() };
}

/** Parse untrusted credentials, or null when absent or unusable. */
export function parseBoxProxyCredentials(raw: unknown): BoxProxyCredentials | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { username?: unknown; password?: unknown };
  if (typeof r.username !== "string" || typeof r.password !== "string") return null;
  const c = { username: r.username, password: r.password };
  return boxProxyCredentialsError(c) === null ? c : null;
}
