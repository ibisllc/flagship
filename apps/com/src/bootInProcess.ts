/**
 * In-process backing for the `/api/boot/*` contract when it is served by
 * the identity plane ITSELF (the reference deployment — boot.flagshipserver.com
 * collapsed onto flagship-com).
 *
 * The standalone `apps/boot` worker reaches the identity plane over HTTP (its
 * `HttpDirectoryClient` reads `/api/users/:u/pods` etc.) and over the notify
 * pipe (`POST /api/internal/notify-owner`, shared-secret authed). When the
 * boot routes run on `.com`, BOTH of those become same-process calls against
 * `flagship-state` storage + the local push forwarder — no self-fetch, no
 * cross-worker bridge, and crucially NO shared secret to drift (the box's
 * Ed25519 signature, re-verified against the directory-bound STK inside the
 * gate, is the only auth on the reference box path).
 *
 * These implement the SAME `DirectoryClient` / `NotifyPipe` interfaces the
 * boot-core router consumes, so the router itself is byte-identical across the
 * two deployments.
 */

import type { DirectoryClient, NotifyPipe } from "@flagship/boot-core";
import { usernameFromServerDomain } from "@flagship/boot-core";
import type {
  ServerStorage,
  UsernameStorage,
  WatchDelegateStorage,
} from "@flagship/storage";

export interface InProcessDirectoryDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  watchDelegates: WatchDelegateStorage;
  /** The apex box FQDNs sit under (`<server>.<user>.<apex>`); used only to
   *  derive the account label from a domain. Defaults to flagship.services. */
  apex?: string;
}

/**
 * Resolve box STK / owner IRK / active boot-approval delegates for a
 * serverDomain directly from `flagship-state`, mirroring the semantics of
 * `HttpDirectoryClient` exactly (so the gate's authz binding is unchanged):
 *
 *   - box STK   ← servers.get(domain).identityPubKeyHex (null if revoked /
 *                 unknown — a revoked pod is no longer a valid box).
 *   - owner IRK ← usernames.get(<user>).irkPubHex, gated behind the server
 *                 actually existing + belonging to that account (so an owner
 *                 can't write to a domain that merely maps to their username
 *                 but was never registered).
 *   - delegates ← the account's un-revoked, "boot-approval"-scoped
 *                 watch-delegates (the gate filters expiry).
 */
export class InProcessDirectoryClient implements DirectoryClient {
  private readonly servers: ServerStorage;
  private readonly usernames: UsernameStorage;
  private readonly watchDelegates: WatchDelegateStorage;
  private readonly apex: string;

  constructor(deps: InProcessDirectoryDeps) {
    this.servers = deps.servers;
    this.usernames = deps.usernames;
    this.watchDelegates = deps.watchDelegates;
    this.apex = deps.apex ?? "flagship.services";
  }

  async boxStkForDomain(serverDomain: string): Promise<string | null> {
    const reg = await this.servers.get(serverDomain.toLowerCase());
    if (!reg) return null;
    // A revoked pod is no longer a valid box for boot operations.
    if (reg.revokedAt) return null;
    return reg.identityPubKeyHex.toLowerCase();
  }

  async ownerIrkForDomain(serverDomain: string): Promise<string | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    // The server must exist + belong to this account (same precondition as
    // the HTTP client's boxStk-first guard) before we hand back the IRK.
    const stk = await this.boxStkForDomain(serverDomain);
    if (stk === null) return null;
    const rec = await this.usernames.get(user);
    if (!rec) return null;
    return rec.irkPubHex.toLowerCase();
  }

  async activeBootDelegatesForDomain(
    serverDomain: string,
  ): Promise<Array<{ pubKeyHex: string; expiresAt: number }> | null> {
    const user = usernameFromServerDomain(serverDomain, this.apex);
    if (!user) return null;
    // Same existence precondition as the owner-IRK read.
    const stk = await this.boxStkForDomain(serverDomain);
    if (stk === null) return null;
    const rows = await this.watchDelegates.listForUser(user);
    const out: Array<{ pubKeyHex: string; expiresAt: number }> = [];
    for (const d of rows) {
      if (d.revokedAt) continue;
      let scopes: unknown;
      try {
        scopes = JSON.parse(d.scopesJson);
      } catch {
        continue;
      }
      if (Array.isArray(scopes) && scopes.includes("boot-approval")) {
        out.push({ pubKeyHex: d.delegatePubHex.toLowerCase(), expiresAt: d.expiresAt });
      }
    }
    return out;
  }

  async usernameForDomain(serverDomain: string): Promise<string | null> {
    // Authoritative: the server record's own username (not just an FQDN
    // derivation), so the parked mailbox row is scoped to the account the
    // phone's /api/secret-requests listing queries.
    const reg = await this.servers.get(serverDomain.toLowerCase());
    if (!reg || reg.revokedAt) return null;
    return reg.username;
  }
}

export interface InProcessNotifyDeps {
  servers: ServerStorage;
  /**
   * The push fan-out closure (`buildPushUserDevices`) — resolves the
   * account's registered devices + sends the encrypted Web Push. Absent ⇒
   * no push (the box still polls; the request is still parked by the router).
   */
  pushUserDevices?: (username: string, category: string, payload?: Uint8Array) => Promise<void>;
}

/**
 * The in-process NOTIFY PIPE. Where the standalone boot worker POSTs to
 * `/api/internal/notify-owner` (which then re-verifies + parks + pushes),
 * here the router has ALREADY parked + re-verified the request against the
 * same directory, so this pipe only has to fire the push for the owning
 * account. The box's STK signature was verified by the gate AND the router
 * before this runs, so there is nothing to re-authenticate — the shared
 * secret has no job on this path and is gone.
 */
export class InProcessNotifyPipe implements NotifyPipe {
  private readonly servers: ServerStorage;
  private readonly pushUserDevices?: (
    username: string,
    category: string,
    payload?: Uint8Array,
  ) => Promise<void>;

  constructor(deps: InProcessNotifyDeps) {
    this.servers = deps.servers;
    this.pushUserDevices = deps.pushUserDevices;
  }

  async notifyOwner(args: {
    serverDomain: string;
    signedRequest: unknown;
    purpose: string;
  }): Promise<boolean> {
    if (!this.pushUserDevices) return false;
    const reg = await this.servers.get(args.serverDomain.toLowerCase());
    if (!reg || reg.revokedAt) return false;
    const sr = args.signedRequest as
      | { request?: Record<string, unknown>; signature?: unknown; deviceInfo?: unknown }
      | undefined;
    const r = sr?.request ?? {};
    const payload = new TextEncoder().encode(
      JSON.stringify({
        kind: "secret-request",
        serverFqdn: args.serverDomain,
        purpose: args.purpose,
        requestNonceHex: typeof r.nonce === "string" ? r.nonce.toLowerCase() : undefined,
        signedRequest: sr
          ? {
              request: r,
              signature: sr.signature,
              ...(sr.deviceInfo ? { deviceInfo: sr.deviceInfo } : {}),
            }
          : undefined,
      }),
    );
    try {
      await this.pushUserDevices(reg.username, "secret-request", payload);
      return true;
    } catch {
      return false;
    }
  }
}
