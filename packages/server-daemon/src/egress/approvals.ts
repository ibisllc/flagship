/**
 * Owner-signed internet approvals for live apps (`flagship/app-egress/v1`).
 *
 * The box keeps the newest verified grant per service, sealed under the SWK,
 * WITH its signature, and re-verifies every grant when it loads them at boot:
 * a grant whose signature no longer verifies under the box's current
 * sensitive-order authority is dropped. What opens is approved ∩ declared:
 * a host the current manifest no longer lists closes again by itself.
 *
 *   GET  /api/screens/services/:serviceId/egress → { declared, approved }
 *   POST /api/screens/services/:serviceId/egress   { grant, signature }
 *        grant = { serverDomain, serviceId, hosts, issuedAt }; hosts [] revokes.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseAppEgressGrant,
  sortEgressHosts,
  verifyAppEgressGrant,
  type AdminGrantView,
  type AppEgressGrant,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SwkOps } from "../keyCustodian.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { effectiveHosts } from "./policy.js";

export interface StoredEgressGrant {
  grant: AppEgressGrant;
  /** Hex Ed25519 signature over the grant's canonical bytes. */
  signature: string;
}

export interface EgressView {
  declared: string[];
  approved: string[];
}

type Swk = Pick<SwkOps, "sealWithSwk" | "openWithSwk">;

export class AppEgressStore {
  private grants = new Map<string, StoredEgressGrant>();
  private chain: Promise<void> = Promise.resolve();

  /** `path` null ⇒ memory only (tests). */
  constructor(
    private readonly path: string | null,
    private readonly swk: Swk | null,
  ) {}

  /** Load and keep only grants that still verify. Returns how many were dropped. */
  async load(isAuthorized: (g: AppEgressGrant, sig: Uint8Array) => boolean): Promise<number> {
    if (!this.path || !this.swk) return 0;
    let hex: string;
    try {
      hex = (await readFile(this.path, "utf8")).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 12) throw new Error("app-egress file is truncated");
    const plain = this.swk.openWithSwk({ nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12) });
    const parsed = JSON.parse(Buffer.from(plain).toString("utf8")) as { v?: number; grants?: unknown };
    let dropped = 0;
    this.grants.clear();
    for (const raw of Array.isArray(parsed.grants) ? parsed.grants : []) {
      const r = raw as { grant?: unknown; signature?: unknown };
      const g = parseAppEgressGrant(r.grant);
      const sig = typeof r.signature === "string" ? hexToBytes(r.signature) : null;
      if (!g || !sig || !isAuthorized(g, sig)) {
        dropped++;
        continue;
      }
      this.grants.set(g.serviceId, { grant: g, signature: r.signature as string });
    }
    return dropped;
  }

  get(serviceId: string): StoredEgressGrant | null {
    return this.grants.get(serviceId) ?? null;
  }

  serviceIds(): string[] {
    return [...this.grants.keys()];
  }

  approvedHosts(serviceId: string): string[] {
    return this.grants.get(serviceId)?.grant.hosts ?? [];
  }

  async put(rec: StoredEgressGrant): Promise<void> {
    this.grants.set(rec.grant.serviceId, rec);
    await this.save();
  }

  /** Drop a service's grant (uninstall). Idempotent. */
  async forget(serviceId: string): Promise<void> {
    if (!this.grants.delete(serviceId)) return;
    await this.save();
  }

  private save(): Promise<void> {
    const path = this.path;
    const swk = this.swk;
    if (!path || !swk) return Promise.resolve();
    const snapshot = [...this.grants.values()];
    const next = this.chain.then(async () => {
      const blob = swk.sealWithSwk(new TextEncoder().encode(JSON.stringify({ v: 1, grants: snapshot })));
      const hex = Buffer.concat([Buffer.from(blob.nonce), Buffer.from(blob.ciphertext)]).toString("hex");
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, hex, { mode: 0o600 });
      await rename(tmp, path);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export interface AppEgressHttpOptions {
  /** The box FQDN every grant must name. */
  serverDomain: string;
  /** The account (for the delegated admin-grant check). */
  username: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  activeGrants?: readonly AdminGrantView[];
  store: AppEgressStore;
  /** The installed service's declared hosts, or null when it isn't installed. */
  declared: (serviceId: string) => string[] | null;
  /** Called after a grant is stored, so the gateway applies it now. */
  onChange?: (serviceId: string) => void;
  now?: () => number;
  /** How far `issuedAt` may be from the box clock. Default 10 min. */
  maxSkewMs?: number;
}

const J = { "content-type": "application/json" } as const;
const PATH_RE = /^\/api\/screens\/services\/([^/]+)\/egress$/;

export function isAppEgressPath(path: string): boolean {
  return PATH_RE.test(path);
}

/** Verify a grant under the box's sensitive-order authority. */
export function authorizeEgressGrant(
  opts: Pick<AppEgressHttpOptions, "ownerIrkPub" | "adminRootPub" | "username" | "activeGrants">,
  grant: AppEgressGrant,
  signature: Uint8Array,
): boolean {
  return authorizeSensitiveOrder({
    order: grant,
    signature,
    verify: verifyAppEgressGrant,
    ownerIrkPub: opts.ownerIrkPub,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    username: opts.username,
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  });
}

export function egressView(store: AppEgressStore, serviceId: string, declared: readonly string[]): EgressView {
  return { declared: [...declared], approved: effectiveHosts(declared, store.approvedHosts(serviceId)) };
}

/**
 * The screens-API handler. Runs behind the paired-session gate and the
 * companion write guard (screensHttp); the session only carries the request,
 * the signature is what authorizes it.
 */
export function buildAppEgressHttp(opts: AppEgressHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const maxSkew = opts.maxSkewMs ?? 10 * 60_000;
  const err = (status: number, error: string): HttpResponse => ({ status, headers: J, body: JSON.stringify({ error }) });

  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    const m = PATH_RE.exec(path);
    if (!m) return null;
    let serviceId: string;
    try {
      serviceId = decodeURIComponent(m[1]!);
    } catch {
      return err(400, "bad service id");
    }
    const declared = opts.declared(serviceId);
    if (declared === null) return err(404, "no such service");
    if (method === "GET") {
      return { status: 200, headers: J, body: JSON.stringify(egressView(opts.store, serviceId, declared)) };
    }
    if (method !== "POST") return err(405, "method not allowed");

    let body: { grant?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    const grant = parseAppEgressGrant(body?.grant);
    if (!grant) return err(400, "malformed grant");
    if (typeof body.signature !== "string") return err(400, "signature required");
    const sig = hexToBytes(body.signature);
    if (!sig || sig.length !== 64) return err(400, "invalid signature hex");
    if (grant.serviceId !== serviceId) return err(400, "grant is for a different service");
    if (grant.serverDomain !== opts.serverDomain) return err(403, "grant is for a different server");
    if (Math.abs(now() - grant.issuedAt) > maxSkew) return err(403, "stale grant");
    if (!authorizeEgressGrant(opts, grant, sig)) return err(403, "invalid signature");
    const prev = opts.store.get(serviceId);
    if (prev && grant.issuedAt <= prev.grant.issuedAt) return err(409, "a newer grant is already applied");
    const undeclared = grant.hosts.filter((h) => !declared.includes(h));
    if (undeclared.length > 0) {
      return err(422, `not declared in the app's network.egress: ${undeclared.join(", ")}`);
    }
    await opts.store.put({
      grant: { ...grant, hosts: sortEgressHosts(grant.hosts) },
      signature: body.signature.toLowerCase(),
    });
    opts.onChange?.(serviceId);
    return {
      status: 200,
      headers: J,
      body: JSON.stringify({ ok: true, egress: egressView(opts.store, serviceId, declared) }),
    };
  };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
