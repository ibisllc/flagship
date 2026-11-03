import { canonicalBoxHealthReport, ed, strictInForce, TAG_BOX_HEALTH } from "@flagship/protocol";
import type { AuthCodeStorage, DaemonStatusStorage, PqTrustStorage, ServerBootKeyStorage, ServerHealthStorage, ServerStorage } from "@flagship/storage";
import { currentBootKeyBinding } from "./bootKeys.js";
import { MIN_BOX_LEVEL, parseBoxLevel } from "./boxUpdateRequired.js";
import { gateBoxMessage, installationPolicy, verifiedStoredStkBinding } from "./pqKeyBindings.js";
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
  /** A box with a boot key signs its health with it (the timer runs outside the daemon and keyd). */
  serverBootKeys?: ServerBootKeyStorage;
  /** The stored heartbeat: a box that reported `boxLevel` >= 3 signs tagged reports, so its untagged ones are refused. */
  daemonStatus?: Pick<DaemonStatusStorage, "get">;
  /** The critical-signature gate's inputs (installation policy, the STK's hybrid binding). */
  pqTrust?: Pick<PqTrustStorage, "forServer">;
  now?: () => number;
}

/** Marks a stored report that arrived tagged: from then on the server's untagged reports are refused. */
const STORED_TAG_KEY = "tag";

function storedWasTagged(reportJson: string | undefined): boolean {
  if (!reportJson) return false;
  try {
    return (JSON.parse(reportJson) as Record<string, unknown>)[STORED_TAG_KEY] === TAG_BOX_HEALTH;
  } catch {
    return false;
  }
}

/** True once the server has shown it is a 0.3 box: a tagged report on file, or a heartbeat at `boxLevel` >= 3. */
async function signsTagged(deps: ServerHealthDeps, domain: string, prevJson: string | undefined): Promise<boolean> {
  if (storedWasTagged(prevJson)) return true;
  const status = deps.daemonStatus ? await deps.daemonStatus.get(domain) : undefined;
  if (!status?.reportJson) return false;
  try {
    const level = parseBoxLevel((JSON.parse(status.reportJson) as Record<string, unknown>).boxLevel);
    return level !== null && level >= MIN_BOX_LEVEL;
  } catch {
    return false;
  }
}

/**
 * POST /api/server/<d>/health. A 0.3 box signs `flagship/box-health/v1|<report>` (protocol boxHealth.ts) with its
 * STK or its bound boot key, and the signature goes through the critical-signature gate like the heartbeat's. A 0.2
 * box signed the bare report JSON: that is taken only while the server has never sent a tagged report or a heartbeat
 * at `boxLevel` >= 3 (no downgrade), and never on a strict installation.
 */
export async function handlePostServerHealth(
  deps: ServerHealthDeps,
  serverDomain: string,
  body: { report?: unknown; signature?: unknown; pqSignature?: unknown } | undefined,
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
  const sig = hexToBytes(body.signature);
  const stkHex = server.identityPubKeyHex.toLowerCase();
  // Read together (one D1 batch on the Worker).
  const [boot, pq, prev] = await Promise.all([
    deps.serverBootKeys ? currentBootKeyBinding({ servers: deps.servers, serverBootKeys: deps.serverBootKeys }, domain) : Promise.resolve(null),
    deps.pqTrust ? deps.pqTrust.forServer(domain) : Promise.resolve(null),
    deps.serverHealth.get(domain),
  ]);
  const keys = [stkHex, ...(boot ? [boot.bootKeyPubHex.toLowerCase()] : [])];
  const now = (deps.now ?? Date.now)();
  const policy = pq ? installationPolicy(pq.policy, domain) : null;

  const taggedBytes = canonicalBoxHealthReport(body.report);
  const signer = keys.find((k) => ed.verify(sig, taggedBytes, hexToBytes(k)));
  let tagged = false;
  if (signer) {
    if (policy && (body.pqSignature !== undefined || strictInForce(policy))) {
      const refused = gateBoxMessage({
        message: taggedBytes,
        purpose: TAG_BOX_HEALTH,
        classicalSignatureHex: body.signature,
        pqSignature: body.pqSignature,
        stkPubHex: signer,
        // Only the STK has a hybrid binding; a boot-key report has none (so strict refuses it).
        binding: signer === stkHex ? verifiedStoredStkBinding(pq!.stkBinding, domain, stkHex, now) : null,
        policy,
      });
      if (refused) return forbidden(`signature refused: ${refused}`);
    }
    tagged = true;
  } else {
    const legacyBytes = new TextEncoder().encode(body.report);
    if (!keys.some((k) => ed.verify(sig, legacyBytes, hexToBytes(k)))) return forbidden("invalid signature");
    if (policy && strictInForce(policy)) return forbidden("signature refused: strict-requires-hybrid");
    if (await signsTagged(deps, domain, prev?.reportJson)) {
      return forbidden("untagged health report refused: this server signs tagged reports");
    }
  }
  const report = parseBoxHealthReport(body.report);
  if (!report) return malformed("malformed health report");
  if (report.domain !== domain) return forbidden("report is for another server");
  if (Math.abs(now - report.at) > HEALTH_MAX_SKEW_MS) return forbidden("stale or future report");
  if (prev && report.at <= prev.reportedAt) return forbidden("replayed report");
  const reportJson = tagged
    ? JSON.stringify({ ...(JSON.parse(body.report) as Record<string, unknown>), [STORED_TAG_KEY]: TAG_BOX_HEALTH })
    : body.report;
  await deps.serverHealth.put({ serverDomain: domain, reportJson, reportedAt: report.at, receivedAt: now });
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
