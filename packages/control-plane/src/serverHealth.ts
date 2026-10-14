import { ed } from "@flagship/protocol";
import type { AuthCodeStorage, ServerHealthStorage, ServerStorage } from "@flagship/storage";
import { HEX128, hexToBytes } from "./hex.js";
import { forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Box health reports: a timer on the box (independent of the daemon, so it
 * keeps reporting while the daemon is down) signs a small fixed-field report
 * with the box identity key (STK) about once a minute. `.com` keeps the latest
 * per server and relays it on /pods, which is public, so the report carries
 * numbers and enums only: never log lines, paths, addresses or names.
 */
export interface BoxHealthReport {
  v: 1;
  domain: string;
  /** Box clock, ms. */
  at: number;
  uptimeS: number;
  memTotalMB: number;
  memAvailMB: number;
  swapUsedMB: number;
  /** Kernel OOM kills since boot (/proc/vmstat oom_kill). */
  oomKills: number;
  daemon: { state: DaemonUnitState; restarts: number; lastExit: number };
  /** The daemon holds a connection to the relay. */
  tunnel: boolean;
  diskUsedPct: number;
}

export type DaemonUnitState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "reloading";
const UNIT_STATES: ReadonlySet<string> = new Set(["active", "activating", "deactivating", "inactive", "failed", "reloading"]);

/** Reports older than this (box clock vs ours) or further ahead are refused. */
export const HEALTH_MAX_SKEW_MS = 15 * 60_000;

const count = (v: unknown, max = 1e9): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

export function parseBoxHealthReport(raw: string): BoxHealthReport | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object") return null;
  const d = r.daemon as Record<string, unknown> | undefined;
  if (
    r.v !== 1 ||
    typeof r.domain !== "string" ||
    !count(r.at, 1e14) ||
    !count(r.uptimeS) ||
    !count(r.memTotalMB, 1e7) ||
    !count(r.memAvailMB, 1e7) ||
    !count(r.swapUsedMB, 1e7) ||
    !count(r.oomKills) ||
    !d || typeof d !== "object" ||
    typeof d.state !== "string" || !UNIT_STATES.has(d.state) ||
    !count(d.restarts) ||
    typeof d.lastExit !== "number" || !Number.isInteger(d.lastExit) ||
    typeof r.tunnel !== "boolean" ||
    !count(r.diskUsedPct, 100)
  ) {
    return null;
  }
  return {
    v: 1,
    domain: r.domain.toLowerCase(),
    at: r.at,
    uptimeS: r.uptimeS,
    memTotalMB: r.memTotalMB,
    memAvailMB: r.memAvailMB,
    swapUsedMB: r.swapUsedMB,
    oomKills: r.oomKills,
    daemon: { state: d.state as DaemonUnitState, restarts: d.restarts, lastExit: d.lastExit },
    tunnel: r.tunnel,
    diskUsedPct: r.diskUsedPct,
  };
}

export interface ServerHealthDeps {
  servers: ServerStorage;
  serverHealth: ServerHealthStorage;
  now?: () => number;
}

export async function handlePostServerHealth(
  deps: ServerHealthDeps,
  serverDomain: string,
  body: { report?: unknown; signature?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (typeof body?.report !== "string" || body.report.length > 4096 ||
      typeof body.signature !== "string" || !HEX128.test(body.signature)) {
    return malformed("expected { report: string, signature: hex }");
  }
  const domain = serverDomain.toLowerCase();
  const server = await deps.servers.get(domain);
  if (!server) return forbidden("unknown server");
  if (server.revokedAt) return forbidden("server revoked");
  // The signature covers the exact report bytes; parse only after it checks out.
  const signed = new TextEncoder().encode(body.report);
  if (!ed.verify(hexToBytes(body.signature), signed, hexToBytes(server.identityPubKeyHex))) {
    return forbidden("invalid signature");
  }
  const report = parseBoxHealthReport(body.report);
  if (!report) return malformed("malformed health report");
  if (report.domain !== domain) return forbidden("report is for another server");
  const now = (deps.now ?? Date.now)();
  if (Math.abs(now - report.at) > HEALTH_MAX_SKEW_MS) return forbidden("stale or future report");
  const prev = await deps.serverHealth.get(domain);
  if (prev && report.at <= prev.reportedAt) return forbidden("replayed report");
  await deps.serverHealth.put({ serverDomain: domain, reportJson: body.report, reportedAt: report.at, receivedAt: now });
  return ok({ ok: true });
}

/** The /pods view of a server's health: the parsed report plus when it arrived. */
export async function healthForPods(
  store: ServerHealthStorage,
  serverDomain: string,
): Promise<(BoxHealthReport & { receivedAt: number }) | undefined> {
  const rec = await store.get(serverDomain);
  if (!rec) return undefined;
  const report = parseBoxHealthReport(rec.reportJson);
  return report ? { ...report, receivedAt: rec.receivedAt } : undefined;
}

/**
 * GET /api/order/<serial>/health — the health of the server an order
 * created, for Studio's VM list. The order serial is the capability (Studio
 * holds it from the recipe), so this needs no account read token.
 */
export async function handleGetOrderHealth(
  deps: {
    authCodes: Pick<AuthCodeStorage, "get">;
    servers: Pick<ServerStorage, "get">;
    serverHealth: ServerHealthStorage;
  },
  serial: string,
): Promise<HandlerResponseWithHeaders> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(serial)) return malformed("malformed serial");
  const order = await deps.authCodes.get(serial);
  if (!order) return notFound("no such order");
  const server = await deps.servers.get(order.serverDomain.toLowerCase());
  if (!server || server.revokedAt) return notFound("no server for this order");
  const health = await healthForPods(deps.serverHealth, server.serverDomain);
  return ok({ serverDomain: server.serverDomain, health: health ?? null }, { "cache-control": "no-store" });
}
