import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Daemon-side client for the `/api/services/endpoints` discovery
 * endpoint on flagshipserver.com. Decouples the daemon from any
 * hardcoded `flagship-services.fly.dev:8443` so we can move the tunnel
 * hub (or peer multiple `.services` instances) without redeploying
 * every user's daemon.
 *
 * Resolution ladder on startup:
 *   1. Live fetch from the control plane → write to disk on success.
 *   2. On fetch failure, fall back to last-known cache on disk (any age).
 *   3. On no cache, fall back to the env-supplied default.
 *
 * The "any age" cache is intentional: if `.com` is down for a week,
 * a stale `tunnelHub` URL is still better than no URL — and the daemon
 * keeps trying live fetches on its normal reconnect cycle, so it'll
 * pick up changes as soon as `.com` recovers.
 */

export interface ServicesEndpoints {
  version: number;
  tunnelHub: string;
  passthroughIPv4: string | null;
  passthroughIPv6: string | null;
  /** Reserved for future inter-`.services` peer routing — see
   *  future_inter_services_peering.md in agent memory. Today this is
   *  always `[]`; daemons MUST tolerate unknown sibling shapes so the
   *  Worker can extend the contract without breaking older daemons. */
  siblings: ReadonlyArray<unknown>;
  /** ISO 8601 — the moment .com served this response. Useful for the
   *  status page to surface "endpoints last refreshed N ago." */
  issuedAt: string;
}

export interface ResolveOptions {
  controlPlaneBaseUrl: string;
  /** Where to cache the last successful fetch. Default `<dataDir>/services-endpoints.json`. */
  cachePath?: string;
  /** Hardcoded ultimate fallback (used only when both live + cache fail). */
  fallback: { tunnelHub: string };
  /** Network deadline. Default 5s — daemons can't wait forever on startup. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ResolveResult {
  endpoints: ServicesEndpoints;
  source: "live" | "cache" | "fallback";
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function resolveServicesEndpoints(opts: ResolveOptions): Promise<ResolveResult> {
  const fetcher = opts.fetchImpl ?? globalThis.fetch;
  const url = `${opts.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/services/endpoints`;

  // 1. Live fetch.
  const live = await tryFetch(fetcher, url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (live) {
    if (opts.cachePath) {
      // Best-effort persist; never let a write failure break boot.
      await persistCache(opts.cachePath, live).catch(() => {});
    }
    return { endpoints: live, source: "live" };
  }

  // 2. Cache.
  if (opts.cachePath) {
    const cached = await loadCache(opts.cachePath).catch(() => null);
    if (cached) return { endpoints: cached, source: "cache" };
  }

  // 3. Fallback.
  return {
    endpoints: {
      version: 1,
      tunnelHub: opts.fallback.tunnelHub,
      passthroughIPv4: null,
      passthroughIPv6: null,
      siblings: [],
      issuedAt: new Date(0).toISOString(),
    },
    source: "fallback",
  };
}

async function tryFetch(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<ServicesEndpoints | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return parseServicesEndpoints(body);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Validate a JSON blob into a strict shape. Returns null on malformed. */
export function parseServicesEndpoints(body: unknown): ServicesEndpoints | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== "number" || typeof b.tunnelHub !== "string") return null;
  if (b.tunnelHub.length === 0 || !/^wss?:\/\//.test(b.tunnelHub)) return null;
  return {
    version: b.version,
    tunnelHub: b.tunnelHub,
    passthroughIPv4: typeof b.passthroughIPv4 === "string" ? b.passthroughIPv4 : null,
    passthroughIPv6: typeof b.passthroughIPv6 === "string" ? b.passthroughIPv6 : null,
    siblings: Array.isArray(b.siblings) ? b.siblings : [],
    issuedAt: typeof b.issuedAt === "string" ? b.issuedAt : new Date().toISOString(),
  };
}

async function persistCache(path: string, endpoints: ServicesEndpoints): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(endpoints, null, 2) + "\n", { mode: 0o644 });
  await rename(tmp, path);
}

async function loadCache(path: string): Promise<ServicesEndpoints | null> {
  try {
    const raw = await readFile(path, "utf8");
    return parseServicesEndpoints(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Default cache location given a daemon dataDir. */
export function defaultEndpointsCachePath(dataDir: string): string {
  return join(dataDir, "services-endpoints.json");
}
