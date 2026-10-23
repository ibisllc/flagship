/**
 * What an app release is allowed to reach, as a comparable set (SECURITY-HARDENING-PLAN.md 10.1).
 *
 * A third-party update that only changes code inside unchanged authority is one thing; one that
 * adds a domain, an egress host, a data store, a browser host or a public route is a request for
 * new authority and needs a fresh admin approval. This reduces a manifest to the authority it asks
 * for, hashes it, and says what an update adds and removes.
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { AppManifest } from "./manifest.js";

export interface CapabilitySet {
  subdomain: string;
  egress: string[];
  postgres: string[];
  files: boolean;
  browserDomains: string[];
  publicRoutes: string[];
  queryableBy: string[];
  /** Environment variable names the app sets for itself (a new one may be a new secret slot). */
  envKeys: string[];
  /** The port the app is reached on. */
  port: number;
}

const sorted = (xs: readonly string[] | undefined) => [...new Set((xs ?? []).map((x) => x.toLowerCase()))].sort();

export function capabilitiesOf(m: AppManifest): CapabilitySet {
  const pg = m.data?.stores?.postgres;
  return {
    subdomain: m.network?.subdomain?.toLowerCase() ?? "",
    egress: sorted(m.network?.egress),
    postgres: pg === true ? ["default"] : Array.isArray(pg) ? sorted(pg) : [],
    files: m.data?.stores?.files === true,
    browserDomains: sorted(m.browser?.domains),
    publicRoutes: sorted(m.access?.public_routes),
    queryableBy: sorted(m.access?.queryable_by),
    envKeys: sorted(Object.keys(m.runtime?.env ?? {})),
    port: m.runtime?.port ?? 0,
  };
}

/** A digest of exactly the authority asked for, for the approval record and the release manifest. */
export function capabilityDigest(c: CapabilitySet): string {
  const line = (k: string, v: string | string[] | boolean | number) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`;
  const text = [
    "flagship/app-capabilities/v1",
    line("subdomain", c.subdomain), line("egress", c.egress), line("postgres", c.postgres), line("files", c.files),
    line("browser", c.browserDomains), line("public", c.publicRoutes), line("queryable", c.queryableBy),
    line("env", c.envKeys), line("port", c.port),
  ].join("|");
  return hex(sha256(new TextEncoder().encode(text)));
}

export interface CapabilityChange {
  capability: keyof CapabilitySet;
  added: string[];
  removed: string[];
}

export interface CapabilityDiff {
  /** Authority the new release asks for that the installed one did not. */
  expanded: CapabilityChange[];
  /** Authority it gives up. */
  narrowed: CapabilityChange[];
  /** True when any authority is added: a fresh admin approval is required. */
  needsApproval: boolean;
}

export function diffCapabilities(installed: CapabilitySet, next: CapabilitySet): CapabilityDiff {
  const expanded: CapabilityChange[] = [];
  const narrowed: CapabilityChange[] = [];
  const lists: Array<keyof CapabilitySet> = ["egress", "postgres", "browserDomains", "publicRoutes", "queryableBy", "envKeys"];
  for (const k of lists) {
    const a = installed[k] as string[];
    const b = next[k] as string[];
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    if (added.length) expanded.push({ capability: k, added, removed: [] });
    if (removed.length) narrowed.push({ capability: k, added: [], removed });
  }
  if (!installed.files && next.files) expanded.push({ capability: "files", added: ["files"], removed: [] });
  if (installed.files && !next.files) narrowed.push({ capability: "files", added: [], removed: ["files"] });
  if (installed.subdomain !== next.subdomain) expanded.push({ capability: "subdomain", added: [next.subdomain], removed: [installed.subdomain] });
  if (installed.port !== next.port) expanded.push({ capability: "port", added: [String(next.port)], removed: [String(installed.port)] });
  return { expanded, narrowed, needsApproval: expanded.length > 0 };
}
