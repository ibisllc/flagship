/**
 * Browser grants (SECURITY-HARDENING-PLAN.md 10.4 and 17.3, SEC-BROWSER-002).
 *
 * An app asks for a typed browser capability and a list of sites. The harness shows the NORMALIZED
 * effective list to the admin, who approves it for once, this session or this service. A grant is
 * scoped to one service, names capabilities, origin patterns, schemes, ports and any local-network
 * exception, and can be revoked. Matching is on parsed hosts at DNS label boundaries:
 * `*.example.com` matches subdomains of example.com, never example.com itself and never
 * `example.com.attacker.test`. A URL path is recorded for the prompt but is NOT a security
 * boundary: the same origin runs scripts with that origin's authority.
 */
import { isIP } from "node:net";

export type BrowserCapability = "navigate" | "read-dom" | "screenshot" | "input" | "download";
export type GrantDuration = "once" | "session" | "service";
export type LocalNetworkGrant = null | { kind: "exact"; hosts: string[] } | { kind: "whole-lan" };

export interface BrowserGrantRequest {
  serviceId: string;
  capabilities: BrowserCapability[];
  /** Exact hosts (`shop.example.com`) or subdomain wildcards (`*.example.com`). */
  origins: string[];
  /** Informational: paths the app said it needs. Not enforced as isolation. */
  urlPrefixes?: string[];
  schemes?: Array<"http" | "https">;
  /** Ports allowed; empty = the scheme's default only. */
  ports?: number[];
  localNetwork?: LocalNetworkGrant;
  duration: GrantDuration;
  /** The app's own explanation, shown beside (never instead of) the normalized list. */
  explanation?: string;
}

export interface BrowserGrant extends Required<Omit<BrowserGrantRequest, "explanation" | "urlPrefixes">> {
  id: string;
  urlPrefixes: string[];
  explanation: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  /** A `once` grant is spent by its first top-level navigation. */
  spentAt: number | null;
}

export class GrantRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantRequestError";
  }
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercase, validated host or `*.host` pattern; throws on anything else. */
export function normalizeOriginPattern(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s || s === "*" || s.includes("/") || s.includes(":") || s.includes("@") || s.includes(" ")) throw new GrantRequestError(`"${raw}" is not a host`);
  const wildcard = s.startsWith("*.");
  const host = wildcard ? s.slice(2) : s;
  if (isIP(host) || /^[0-9.]+$/.test(host)) throw new GrantRequestError("an address is not a site; ask for local-network access instead");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new GrantRequestError(`"${raw}" is not a multi-label host name`);
  // A wildcard needs a registrable name under it: `*.com` would be every .com site.
  if (wildcard && labels.length < 2) throw new GrantRequestError(`"${raw}" is too broad`);
  return wildcard ? `*.${host}` : host;
}

/** Does `pattern` (normalized) cover `host` (lowercase)? Wildcards cover subdomains only. */
export function patternCovers(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === host;
  const suffix = pattern.slice(1); // ".example.com"
  return host.length > suffix.length && host.endsWith(suffix);
}

/** What the admin is told each pattern means. */
export function describePattern(pattern: string): string {
  if (!pattern.startsWith("*.")) return `${pattern} only`;
  return `any subdomain of ${pattern.slice(2)} (for example shop.${pattern.slice(2)}), but not ${pattern.slice(2)} itself`;
}

export function describeGrant(g: Pick<BrowserGrantRequest, "capabilities" | "origins" | "localNetwork" | "duration">): string[] {
  const lines = [
    `Can ${g.capabilities.join(", ")} on: ${g.origins.map(describePattern).join("; ")}.`,
    "Sites you approve may send the browser to other public sites by redirect; those pages stay inside this approval until it ends.",
    "It can never reach this server, the control plane, cloud metadata or anything on your network unless you approve that below.",
  ];
  if (g.localNetwork?.kind === "exact") lines.push(`Also allowed on your local network: ${g.localNetwork.hosts.join(", ")}.`);
  if (g.localNetwork?.kind === "whole-lan") lines.push("Also allowed: every device on your local network (not this server or cloud metadata).");
  lines.push(g.duration === "once" ? "Valid for one visit." : g.duration === "session" ? "Valid until this session ends." : "Valid until you remove it.");
  return lines;
}

export class BrowserGrants {
  private grants = new Map<string, BrowserGrant>();
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Record an approved grant with its normalized effective list. */
  approve(req: BrowserGrantRequest, opts: { sessionId?: string; ttlMs?: number } = {}): BrowserGrant {
    if (req.capabilities.length === 0) throw new GrantRequestError("a grant needs at least one capability");
    if (req.origins.length === 0 && !req.localNetwork) throw new GrantRequestError("a grant needs at least one site");
    if (req.duration === "session" && !opts.sessionId) throw new GrantRequestError("a session grant needs a session");
    const t = this.now();
    const g: BrowserGrant = {
      id: `bg${++this.seq}`,
      serviceId: req.serviceId,
      capabilities: [...new Set(req.capabilities)],
      origins: [...new Set(req.origins.map(normalizeOriginPattern))].sort(),
      urlPrefixes: (req.urlPrefixes ?? []).slice(0, 20),
      schemes: req.schemes?.length ? [...new Set(req.schemes)] : ["https"],
      ports: [...new Set(req.ports ?? [])].filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
      localNetwork: req.localNetwork ?? null,
      duration: req.duration,
      explanation: (req.explanation ?? "").slice(0, 500),
      sessionId: req.duration === "session" ? opts.sessionId ?? null : null,
      issuedAt: t,
      expiresAt: opts.ttlMs ? t + opts.ttlMs : null,
      revokedAt: null,
      spentAt: null,
    };
    this.grants.set(g.id, g);
    return { ...g };
  }

  /** Live grants for a service: not revoked, not expired, not spent, and for this session if session-scoped. */
  live(serviceId: string, sessionId?: string): BrowserGrant[] {
    const t = this.now();
    return [...this.grants.values()].filter(
      (g) =>
        g.serviceId === serviceId && g.revokedAt === null && g.spentAt === null && (g.expiresAt === null || g.expiresAt > t) &&
        (g.duration !== "session" || g.sessionId === sessionId),
    ).map((g) => ({ ...g }));
  }

  spend(id: string): void {
    const g = this.grants.get(id);
    if (g && g.duration === "once" && g.spentAt === null) g.spentAt = this.now();
  }

  revoke(id: string): boolean {
    const g = this.grants.get(id);
    if (!g || g.revokedAt !== null) return false;
    g.revokedAt = this.now();
    return true;
  }

  revokeService(serviceId: string): string[] {
    const ids: string[] = [];
    for (const g of this.grants.values()) if (g.serviceId === serviceId && this.revoke(g.id)) ids.push(g.id);
    return ids;
  }

  endSession(sessionId: string): void {
    for (const g of this.grants.values()) if (g.sessionId === sessionId) this.revoke(g.id);
  }
}
