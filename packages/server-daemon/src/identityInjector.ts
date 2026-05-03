import { ed } from "@flagship/protocol";
import type { AppMembership } from "./membership.js";
import type { Bytes } from "@flagship/protocol";

/**
 * Stamps signed identity headers on inbound HTTP requests after authenticating
 * the requester against the per-app membership store.
 *
 * Lives between Caddy and the user's app container. In production this is
 * either:
 *   - A small Caddy plugin module (Go), OR
 *   - A pre-route handler on a Node reverse proxy fronting the container.
 *
 * The function is split into a runtime-agnostic core (`evaluate`) and a thin
 * Fastify wrapper (`asPreHandler`) so the same logic can be lifted to any
 * proxy harness without bringing the harness into tests.
 */

const DEFAULT_HEADER_TTL_MS = 5 * 60_000;

export interface IdentityInjectorOptions {
  app: AppMembership;
  /**
   * Resolves an authenticated paired-session token to the requester's IRK
   * pubkey. Returns null for unauthenticated/invalid tokens.
   */
  resolveSession: (sessionToken: string | undefined) => Bytes | null;
  /**
   * Public routes from the manifest that bypass membership and are served to
   * anonymous visitors with `X-Flagship-User: anonymous`.
   */
  publicRoutes?: string[];
  /** Server-runtime keypair used to sign the injected headers. */
  signer: { privateKey: Bytes; publicKey: Bytes };
  /** Header TTL for replay protection. Default 5 min. */
  headerTtlMs?: number;
  now?: () => number;
}

export type Decision =
  | {
      action: "allow";
      headers: {
        "X-Flagship-Member": string;
        "X-Flagship-Role": string;
        "X-Flagship-Issued-At": string;
        "X-Flagship-Signature": string;
      };
    }
  | {
      action: "allow-anonymous";
      headers: {
        "X-Flagship-Member": "anonymous";
        "X-Flagship-Issued-At": string;
        "X-Flagship-Signature": string;
      };
    }
  | { action: "deny"; status: 401 | 403; reason: string };

export interface InboundRequest {
  path: string;
  sessionToken?: string;
  /** Any X-Flagship-* headers the client tried to send — these get stripped. */
  spoofedFlagshipHeaders?: string[];
}

export class IdentityInjector {
  private readonly app: AppMembership;
  private readonly resolveSession: IdentityInjectorOptions["resolveSession"];
  private readonly publicRoutes: string[];
  private readonly signer: IdentityInjectorOptions["signer"];
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: IdentityInjectorOptions) {
    this.app = opts.app;
    this.resolveSession = opts.resolveSession;
    this.publicRoutes = opts.publicRoutes ?? [];
    this.signer = opts.signer;
    this.ttl = opts.headerTtlMs ?? DEFAULT_HEADER_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  evaluate(req: InboundRequest): Decision {
    // Spoofed headers are observed but always stripped — even existing.
    // Caller is expected to actually drop them; this method just decides what
    // the canonical injected set should be.

    const irkPub = this.resolveSession(req.sessionToken);
    if (!irkPub) {
      if (this.isPublic(req.path)) {
        return this.signAnonymous();
      }
      return { action: "deny", status: 401, reason: "authentication required" };
    }

    const role = this.app.members.getRole(irkPub);
    if (role === null) {
      if (this.isPublic(req.path)) {
        return this.signAnonymous();
      }
      return { action: "deny", status: 403, reason: "not a member of this app" };
    }

    const stableId = this.app.stableIdFor(irkPub);
    return this.signMember(stableId, role);
  }

  private isPublic(path: string): boolean {
    for (const p of this.publicRoutes) {
      if (path === p) return true;
      if (p.endsWith("/*") && path.startsWith(p.slice(0, -1))) return true;
    }
    return false;
  }

  private signMember(stableId: string, role: string): Decision {
    const issuedAt = this.now();
    const canonical = canonicalHeaderBytes(stableId, role, issuedAt);
    const sig = ed.sign(canonical, this.signer.privateKey);
    return {
      action: "allow",
      headers: {
        "X-Flagship-Member": stableId,
        "X-Flagship-Role": role,
        "X-Flagship-Issued-At": String(issuedAt),
        "X-Flagship-Signature": bytesToHex(sig),
      },
    };
  }

  private signAnonymous(): Decision {
    const issuedAt = this.now();
    const canonical = canonicalHeaderBytes("anonymous", "anonymous", issuedAt);
    const sig = ed.sign(canonical, this.signer.privateKey);
    return {
      action: "allow-anonymous",
      headers: {
        "X-Flagship-Member": "anonymous",
        "X-Flagship-Issued-At": String(issuedAt),
        "X-Flagship-Signature": bytesToHex(sig),
      },
    };
  }
}

/**
 * Verify the runtime-injected identity header set inside an app — useful for
 * apps that want defense-in-depth and don't want to trust the in-server
 * reverse proxy unconditionally.
 */
export function verifyIdentityHeaders(
  headers: Record<string, string | undefined>,
  runtimePubKey: Bytes,
  maxAgeMs = DEFAULT_HEADER_TTL_MS,
  now: () => number = () => Date.now(),
): { ok: true; member: string; role: string } | { ok: false; reason: string } {
  const member = headers["x-flagship-member"];
  const role = headers["x-flagship-role"] ?? "anonymous";
  const issuedAt = headers["x-flagship-issued-at"];
  const sig = headers["x-flagship-signature"];
  if (!member || !issuedAt || !sig) return { ok: false, reason: "missing headers" };
  const ts = Number(issuedAt);
  if (!Number.isFinite(ts)) return { ok: false, reason: "issuedAt not numeric" };
  if (now() - ts > maxAgeMs) return { ok: false, reason: "stale" };
  let sigBytes: Bytes;
  try {
    sigBytes = hexToBytes(sig);
  } catch {
    return { ok: false, reason: "signature not hex" };
  }
  const canonical = canonicalHeaderBytes(member, role, ts);
  try {
    if (!ed.verify(sigBytes, canonical, runtimePubKey)) {
      return { ok: false, reason: "bad signature" };
    }
  } catch {
    return { ok: false, reason: "verify threw" };
  }
  return { ok: true, member, role };
}

function canonicalHeaderBytes(member: string, role: string, issuedAt: number): Bytes {
  return new TextEncoder().encode(`flagship/identity-header/v1|${member}|${role}|${issuedAt}`);
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Bytes {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
