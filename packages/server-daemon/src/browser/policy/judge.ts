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
 *   - A subresource, worker or socket must come from a document that is itself in scope (covered by a
 *     grant, or admitted by the judge as the main frame, also through a redirect), and must reach a
 *     public destination.
 *   - A `once` grant is spent by the top-level navigation it admits; the visit it opened stays usable
 *     (its subresources, the app's actions on that page) while the tab stays on it.
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
  /** The grant under which the browser admitted that document (it may have landed there by redirect). */
  initiatorGrantId?: string;
  sessionId?: string;
}

export type Denial = "scheme" | "no-grant" | "out-of-scope" | "needs-grant" | "protected-destination" | "local-network" | "dns-failed" | "port" | "capability";

export type Decision =
  | { allow: true; grantId: string | null; addresses: string[]; viaRedirect: boolean }
  | { allow: false; code: Denial; reason: string };

/** A main-frame document the judge admitted: its origin and the grant it was admitted under. */
export interface AdmittedDocument {
  origin: string;
  grantId: string;
}

export interface JudgeDeps {
  grants: {
    live(serviceId: string, sessionId?: string): BrowserGrant[];
    spend(id: string): void;
    /** Like `live`, but a spent `once` grant still counts (the visit it opened). Absent: `live`. */
    usable?(serviceId: string, sessionId?: string): BrowserGrant[];
  };
  /** Resolve a name to every address it has. Throws or returns [] on failure. */
  resolve: (host: string) => Promise<string[]>;
  /**
   * This server's own names and addresses, and the services it depends on: never reachable from an app
   * browser. `names` match exactly; `zones` match the name and every name under it; `labelPrefixes`
   * match a name directly under `zone` whose first label starts with `prefix`. `portLimited` names
   * destinations (by address, or by name and every name under it) reachable only on the listed ports:
   * the relay, whose web ports carry other people's apps and whose other ports are its own services.
   */
  protectedHosts?: () => ProtectedHostsView;
}

export interface ProtectedHostsView {
  names: string[];
  addresses: string[];
  zones?: string[];
  labelPrefixes?: Array<{ prefix: string; zone: string }>;
  portLimited?: { addresses: string[]; zones?: string[]; ports: number[] };
}

const PROTECTED: AddressClass[] = ["loopback", "link-local", "metadata", "multicast", "reserved", "invalid"];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The host every check compares: lowercase, IDNA (`URL` already gives the ASCII form), no brackets, and
 * no trailing dot, so `box.example.` and `BOX.example` are the same name as `box.example`.
 */
export function hostOf(u: URL): string {
  return canonicalName(u.hostname.replace(/^\[|\]$/g, ""));
}

function canonicalName(n: string): string {
  let h = n.trim().toLowerCase().replace(/\.+$/, "");
  if (!isIP(h) && /[^\x00-\x7f]/.test(h)) {
    try {
      h = new URL(`http://${h}/`).hostname;
    } catch {
      // leave it: it will not match anything real
    }
  }
  return h;
}

function sameAddress(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.)/, "");
  return n(a) === n(b);
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
  const host = hostOf(u);
  return schemeOk(g, u) && portOk(g, u) && g.origins.some((o) => patternCovers(o, host));
}

export class BrowserJudge {
  constructor(private readonly deps: JudgeDeps) {}

  private usable(serviceId: string, sessionId?: string): BrowserGrant[] {
    return this.deps.grants.usable?.(serviceId, sessionId) ?? this.deps.grants.live(serviceId, sessionId);
  }

  /**
   * Is `url` inside a grant for the service (used before and after every action)? Either a grant covers
   * it, or it is the document the judge admitted in that tab (`admitted`, also a redirect's landing page)
   * and the grant that admitted it still holds.
   */
  inScope(serviceId: string, url: string, capability?: BrowserCapability, sessionId?: string, admitted?: AdmittedDocument): boolean {
    const u = parse(url);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return false;
    const usable = this.usable(serviceId, sessionId);
    const fits = (g: BrowserGrant) => !capability || g.capabilities.includes(capability);
    if (usable.some((g) => covers(g, u) && fits(g))) return true;
    if (!admitted || u.origin !== admitted.origin) return false;
    const g = usable.find((x) => x.id === admitted.grantId);
    return !!g && fits(g);
  }

  async judge(req: JudgeRequest): Promise<Decision> {
    const u = parse(req.url);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return { allow: false, code: "scheme", reason: "only http and https pages can be opened" };
    if (!u.hostname) return { allow: false, code: "scheme", reason: "no host" };
    const live = this.deps.grants.live(req.serviceId, req.sessionId);
    const usable = this.usable(req.serviceId, req.sessionId);
    if (usable.length === 0) return { allow: false, code: "no-grant", reason: "this app has no browser access" };

    const destination = await this.destination(u, usable);
    if (!destination.ok) return { allow: false, code: destination.code, reason: destination.reason };

    // A new top-level visit needs a live grant; a frame or download inside the visit a spent `once` opened may use it.
    const direct = (req.kind === "document" ? live : usable).find((g) => covers(g, u) && this.capabilityFits(g, req.kind));
    if (destination.local && (req.kind === "document" || req.kind === "subframe")) {
      // Local-network access is its own grant, for the exact targets or the whole network; the
      // destination checks above already refused it when no such grant exists.
      const lan = live.find((g) => g.localNetwork !== null && this.capabilityFits(g, req.kind));
      if (lan) return this.allow(lan, destination.addresses, false, req.kind);
      return { allow: false, code: "local-network", reason: "that is on your local network; ask for local-network access" };
    }
    if (req.kind === "document" || req.kind === "subframe" || req.kind === "download") {
      if (direct) return this.allow(direct, destination.addresses, false, req.kind);
      // A redirect the browser saw, starting inside a grant, may land on any public site. The chain's
      // first hop was itself judged (and may have spent a `once` grant), so a spent grant still roots it.
      const chain = req.redirectChain ?? [];
      const root = chain.length ? parse(chain[0]!) : null;
      const rooted = root ? usable.find((g) => covers(g, root) && this.capabilityFits(g, req.kind)) : undefined;
      if (rooted && chain.every((c) => parse(c)) && !destination.local) return this.allow(rooted, destination.addresses, true, req.kind);
      if (live.length === 0 && !chain.length) return { allow: false, code: "no-grant", reason: "this app has no browser access" };
      return { allow: false, code: chain.length ? "out-of-scope" : "needs-grant", reason: "this site is outside what you approved" };
    }
    // Subresource, worker, websocket: the initiating document must itself be in scope, and the
    // destination must be public (checked above for protected and private space).
    const init = req.initiatorUrl ? parse(req.initiatorUrl) : null;
    const admittedBy = req.initiatorGrantId ? usable.find((g) => g.id === req.initiatorGrantId) : undefined;
    const initGrant = init ? usable.find((g) => covers(g, init)) ?? admittedBy ?? this.viaRedirectScope(usable, req) : undefined;
    if (!initGrant) return { allow: false, code: "out-of-scope", reason: "the page asking is outside what you approved" };
    if (destination.local) return { allow: false, code: "local-network", reason: "a page cannot reach your network from the internet" };
    return this.allow(initGrant, destination.addresses, false, req.kind);
  }

  private viaRedirectScope(live: BrowserGrant[], req: JudgeRequest): BrowserGrant | undefined {
    const root = req.redirectChain?.length ? parse(req.redirectChain[0]!) : null;
    return root ? live.find((g) => covers(g, root)) : undefined;
  }

  private capabilityFits(g: BrowserGrant, kind: RequestKind): boolean {
    return kind === "download" ? g.capabilities.includes("download") : g.capabilities.includes("navigate");
  }

  private allow(g: BrowserGrant, addresses: string[], viaRedirect: boolean, kind: RequestKind): Decision {
    // Only a top-level navigation spends a `once` grant: the page it opens may still load what it needs.
    if (kind === "document") this.deps.grants.spend(g.id);
    return { allow: true, grantId: g.id, addresses, viaRedirect };
  }

  private async destination(
    u: URL,
    live: BrowserGrant[],
  ): Promise<{ ok: true; addresses: string[]; local: boolean } | { ok: false; code: Denial; reason: string }> {
    const host = hostOf(u);
    const protectedHosts: ProtectedHostsView = this.deps.protectedHosts?.() ?? { names: [], addresses: [] };
    const under = (z: string) => host === canonicalName(z) || host.endsWith(`.${canonicalName(z)}`);
    const named =
      protectedHosts.names.some((n) => canonicalName(n) === host) ||
      (protectedHosts.zones ?? []).some(under) ||
      (protectedHosts.labelPrefixes ?? []).some(({ prefix, zone }) => {
        const z = canonicalName(zone);
        return host.endsWith(`.${z}`) && !host.slice(0, -z.length - 1).includes(".") && host.startsWith(prefix.toLowerCase());
      });
    if (named) return { ok: false, code: "protected-destination", reason: "that is this server" };
    const port = portOf(u);
    const limited = protectedHosts.portLimited;
    const portShut = !!limited && !limited.ports.includes(port);
    if (portShut && (limited!.zones ?? []).some(under)) return { ok: false, code: "protected-destination", reason: "that port is the relay's own service" };
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
      if (protectedHosts.addresses.some((p) => sameAddress(p, a))) return { ok: false, code: "protected-destination", reason: "that is this server" };
      if (portShut && limited!.addresses.some((p) => sameAddress(p, a))) return { ok: false, code: "protected-destination", reason: "that port is the relay's own service" };
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
