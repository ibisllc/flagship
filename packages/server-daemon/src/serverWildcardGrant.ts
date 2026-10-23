/**
 * The admin's once-per-server grant for this box to hold a certificate for every app name on the
 * account (`*.<user>.<apex>`, `flagship/server-wildcard-grant/v1`). The box keeps the grant, sends
 * it with each DNS-01 request for `_acme-challenge.<user>.<apex>`, and adds the name to its own
 * certificate, whose key stays in keyd. Whichever of the owner's servers the relay routes an app's
 * canonical name to can then answer it; no key is ever copied between servers.
 *
 *   POST /api/screens/server-wildcard-grant   { issuedAt, signature }   (owner session)
 *
 * The box checks the signature itself against the account's sensitive-order key before keeping it,
 * then restarts so the next certificate names `*.<user>.<apex>`.
 */
import { verifyServerWildcardGrant, type ServerWildcardGrant } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";
import type { SensitiveAuthority } from "./egress/approvals.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const SERVER_WILDCARD_GRANT_PATH = "/api/screens/server-wildcard-grant";
const J = { "content-type": "application/json" } as const;

export interface StoredWildcardGrant {
  issuedAt: number;
  signatureHex: string;
}

export interface WildcardGrantOptions {
  path: string;
  serverDomain: string;
  /** The box's registered identity key, 64 lowercase hex. */
  stkPubHex: string;
  authority: () => SensitiveAuthority;
}

export class ServerWildcardGrantStore {
  private grant: StoredWildcardGrant | null = null;

  constructor(private readonly o: WildcardGrantOptions) {}

  private order(issuedAt: number): ServerWildcardGrant {
    return { username: this.o.authority().username, serverDomain: this.o.serverDomain, stkPubHex: this.o.stkPubHex, issuedAt };
  }

  /** True when the admin signed this grant for this server and the key it holds. */
  verifies(g: StoredWildcardGrant): boolean {
    if (!Number.isSafeInteger(g.issuedAt) || !/^[0-9a-f]{128}$/i.test(g.signatureHex)) return false;
    try {
      const a = this.o.authority();
      return authorizeSensitiveOrder({
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        order: this.order(g.issuedAt),
        signature: Uint8Array.from(Buffer.from(g.signatureHex, "hex")),
        verify: verifyServerWildcardGrant,
      });
    } catch {
      return false;
    }
  }

  /** Read the kept grant; one that no longer verifies (a rotated admin root, another key) is dropped. */
  async load(): Promise<StoredWildcardGrant | null> {
    const r = await readStateFile(this.o.path);
    if (r.kind === "missing") return null;
    try {
      if (r.kind === "unreadable") throw r.error;
      const g = JSON.parse(r.text) as StoredWildcardGrant;
      this.grant = this.verifies(g) ? { issuedAt: g.issuedAt, signatureHex: g.signatureHex.toLowerCase() } : null;
    } catch (e) {
      await keepCorruptAside(this.o.path, e, "The app-name certificate grant could not be read; the owner's apps send it again.");
      this.grant = null;
    }
    return this.grant;
  }

  current(): StoredWildcardGrant | null {
    return this.grant;
  }

  /** Keep a new grant. Returns true for the box's first one: its certificate then needs the new name (the caller restarts). */
  async accept(g: StoredWildcardGrant): Promise<boolean> {
    if (!this.verifies(g)) throw new Error("not signed by the account's admin");
    const same = this.grant?.issuedAt === g.issuedAt && this.grant.signatureHex === g.signatureHex.toLowerCase();
    if (same) return false;
    const had = this.grant !== null;
    this.grant = { issuedAt: g.issuedAt, signatureHex: g.signatureHex.toLowerCase() };
    await writeFileDurable(this.o.path, JSON.stringify(this.grant), 0o600);
    return !had;
  }
}

export function buildServerWildcardGrantHttp(o: { store: ServerWildcardGrantStore; onFirstGrant: () => void }) {
  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path !== SERVER_WILDCARD_GRANT_PATH) return null;
    if (method === "GET") return { status: 200, headers: J, body: JSON.stringify({ granted: o.store.current() !== null }) };
    if (method !== "POST") return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
    let b: { issuedAt?: unknown; signature?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return { status: 400, headers: J, body: JSON.stringify({ error: "invalid json" }) };
    }
    if (!Number.isSafeInteger(b.issuedAt) || typeof b.signature !== "string") return { status: 400, headers: J, body: JSON.stringify({ error: "a signed grant is required" }) };
    let first: boolean;
    try {
      first = await o.store.accept({ issuedAt: b.issuedAt as number, signatureHex: b.signature });
    } catch {
      return { status: 403, headers: J, body: JSON.stringify({ error: "that grant was not signed by the account's admin" }) };
    }
    if (first) o.onFirstGrant();
    return { status: 200, headers: J, body: JSON.stringify({ ok: true, restarting: first }) };
  };
}
