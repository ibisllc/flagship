/**
 * The decision for every request a service's browser makes (SECURITY-HARDENING-PLAN.md 10.4,
 * SEC-BROWSER-002). Pure of the browser: the manager feeds it what CDP observed (the URL, the type
 * of request, the chain of redirects the browser itself saw, the initiating document) and enforces
 * the answer in `Fetch.requestPaused`.
 *
 *   - Only http and https. `data:`, `blob:`, `file:`, `javascript:` and custom schemes are refused.
 *   - The name is resolved HERE and every address must be acceptable (so a name with one public and
 *     one internal answer is refused); the returned addresses are what the manager must connect to,
 *     which closes DNS rebinding.
 *   - Loopback, link-local, cloud metadata, multicast and reserved space are protected: no grant
 *     opens them. Private (RFC 1918 / ULA) space needs a local-network grant.
 *   - A document navigation needs a live grant that covers it, or a redirect chain the BROWSER saw
 *     that started inside one. After that a redirect may land on any public site. An unrelated
 *     direct navigation outside the grant is `needs-grant`, not a silent allow.
 *   - A subresource, worker or socket must come from a document that is itself in scope, and must
 *     reach a public destination.
 */
import { classifyAddress, type AddressClass } from "@flagship/protocol";
import { isIP } from "node:net";
import { patternCovers, type BrowserCapability, type BrowserGrant } from "./grants.js";

export type RequestKind = "document" | "subframe" | "subresource" | "worker" | "websocket" | "download";

export interface JudgeRequest {
  serviceId: string;
  url: string;
  kind: RequestKind;
  /** The redirect chain the browser observed, oldest first (not including `url`). Never app-supplied. */
  redirectChain?: string[];
  /** The URL of the document that initiated this request, for subresources and sockets. */
  initiatorUrl?: string;
  sessionId?: string;
}

export type Denial = "scheme" | "no-grant" | "out-of-scope" | "needs-grant" | "protected-destination" | "local-network" | "dns-failed" | "port" | "capability";

export type Decision =
  | { allow: true; grantId: string | null; addresses: string[]; viaRedirect: boolean }
  | { allow: false; code: Denial; reason: string };

export interface JudgeDeps {
  grants: { live(serviceId: string, sessionId?: string): BrowserGrant[]; spend(id: string): void };
  /** Resolve a name to every address it has. Throws or returns [] on failure. */
  resolve: (host: string) => Promise<string[]>;
  /** The control host's own name and addresses: never reachable from an app browser. */
  protectedHosts?: () => { names: string[]; addresses: string[] };
}

const PROTECTED: AddressClass[] = ["loopback", "link-local", "metadata", "multicast", "reserved", "invalid"];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function portOf(u: URL): number {
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

function schemeOk(g: BrowserGrant, u: URL): boolean {
  return g.schemes.includes(u.protocol.slice(0, -1) as "http" | "https");
}

function portOk(g: BrowserGrant, u: URL): boolean {
  const p = portOf(u);
  return g.ports.length === 0 ? p === (u.protocol === "https:" ? 443 : 80) : g.ports.includes(p);
}

function covers(g: BrowserGrant, u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return schemeOk(g, u) && portOk(g, u) && g.origins.some((o) => patternCovers(o, host));
}

export class BrowserJudge {
  constructor(private readonly deps: JudgeDeps) {}

  /** Is `url` inside a live grant for the service (used before and after every action)? */
  inScope(serviceId: string, url: string, capability?: BrowserCapability, sessionId?: string): boolean {
    const u = parse(url);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return false;
    return this.deps.grants.live(serviceId, sessionId).some((g) => covers(g, u) && (!capability || g.capabilities.includes(capability)));
  }

  async judge(req: JudgeRequest): Promise<Decision> {
    const u = parse(req.url);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return { allow: false, code: "scheme", reason: "only http and https pages can be opened" };
    if (!u.hostname) return { allow: false, code: "scheme", reason: "no host" };
    const live = this.deps.grants.live(req.serviceId, req.sessionId);
    if (live.length === 0) return { allow: false, code: "no-grant", reason: "this app has no browser access" };

    const destination = await this.destination(u, live);
    if (!destination.ok) return { allow: false, code: destination.code, reason: destination.reason };

    const direct = live.find((g) => covers(g, u) && this.capabilityFits(g, req.kind));
    if (destination.local && (req.kind === "document" || req.kind === "subframe")) {
      // Local-network access is its own grant, for the exact targets or the whole network; the
      // destination checks above already refused it when no such grant exists.
      const lan = live.find((g) => g.localNetwork !== null && this.capabilityFits(g, req.kind));
      if (lan) return this.allow(lan, destination.addresses, false);
      return { allow: false, code: "local-network", reason: "that is on your local network; ask for local-network access" };
    }
    if (req.kind === "document" || req.kind === "subframe" || req.kind === "download") {
      if (direct) return this.allow(direct, destination.addresses, false);
      // A redirect the browser saw, starting inside a grant, may land on any public site.
      const chain = req.redirectChain ?? [];
      const root = chain.length ? parse(chain[0]!) : null;
      const rooted = root ? live.find((g) => covers(g, root) && this.capabilityFits(g, req.kind)) : undefined;
      if (rooted && chain.every((c) => parse(c)) && !destination.local) return this.allow(rooted, destination.addresses, true);
      return { allow: false, code: chain.length ? "out-of-scope" : "needs-grant", reason: "this site is outside what you approved" };
    }
    // Subresource, worker, websocket: the initiating document must itself be in scope, and the
    // destination must be public (checked above for protected and private space).
    const init = req.initiatorUrl ? parse(req.initiatorUrl) : null;
    const initGrant = init ? live.find((g) => covers(g, init)) ?? this.viaRedirectScope(live, req) : undefined;
    if (!initGrant) return { allow: false, code: "out-of-scope", reason: "the page asking is outside what you approved" };
    if (destination.local) return { allow: false, code: "local-network", reason: "a page cannot reach your network from the internet" };
    return this.allow(initGrant, destination.addresses, false);
  }

  private viaRedirectScope(live: BrowserGrant[], req: JudgeRequest): BrowserGrant | undefined {
    const root = req.redirectChain?.length ? parse(req.redirectChain[0]!) : null;
    return root ? live.find((g) => covers(g, root)) : undefined;
  }

  private capabilityFits(g: BrowserGrant, kind: RequestKind): boolean {
    return kind === "download" ? g.capabilities.includes("download") : g.capabilities.includes("navigate");
  }

  private allow(g: BrowserGrant, addresses: string[], viaRedirect: boolean): Decision {
    this.deps.grants.spend(g.id);
    return { allow: true, grantId: g.id, addresses, viaRedirect };
  }

  private async destination(
    u: URL,
    live: BrowserGrant[],
  ): Promise<{ ok: true; addresses: string[]; local: boolean } | { ok: false; code: Denial; reason: string }> {
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const protectedHosts = this.deps.protectedHosts?.() ?? { names: [], addresses: [] };
    if (protectedHosts.names.some((n) => n.toLowerCase() === host)) return { ok: false, code: "protected-destination", reason: "that is this server" };
    let addrs: string[];
    if (isIP(host)) addrs = [host];
    else {
      try {
        addrs = await this.deps.resolve(host);
      } catch {
        addrs = [];
      }
      if (addrs.length === 0) return { ok: false, code: "dns-failed", reason: "the name did not resolve" };
    }
    let local = false;
    for (const a of addrs) {
      if (protectedHosts.addresses.includes(a)) return { ok: false, code: "protected-destination", reason: "that is this server" };
      const cls = classifyAddress(a);
      if (PROTECTED.includes(cls)) return { ok: false, code: "protected-destination", reason: `that address (${cls}) is never reachable from an app` };
      if (cls === "private") {
        local = true;
        const allowedLocal = live.some((g) => {
          const ln = g.localNetwork;
          if (!ln) return false;
          if (ln.kind === "whole-lan") return true;
          return ln.hosts.includes(host) || ln.hosts.includes(a);
        });
        if (!allowedLocal) return { ok: false, code: "local-network", reason: "that is on your local network; ask for local-network access" };
      }
    }
    return { ok: true, addresses: addrs, local };
  }
}
