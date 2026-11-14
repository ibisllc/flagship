/**
 * Who owns apps on an arch-v2 box (docs/architecture-v2/broker-runtime-core.md §11): the owner's
 * two settings, kept in `/var/flagship/rust-ownership.json`.
 *
 *   reconciler  "shadow" (default): the daemon deploys, stops and restarts app containers itself;
 *               core keeps the desired state, compares it with the engine and journals its diff,
 *               and acts on nothing. "rust": core decides every app container effect (deploy,
 *               remove, generation, address, admission) and the daemon only performs what core
 *               hands it (coreOwnership.ts). Exactly one writer either way.
 *   proxy       "ts" (default): the daemon's TS proxy carries app traffic. "rust": the Rust
 *               ingress replaces flagship-tlsd and carries it after the daemon's decision
 *               (rustProxyDecide.ts, flagship-ingress proxy.rs).
 *
 * Changed only by an admin-signed `flagship/rust-ownership/v1` order (POST /api/stack/rust-ownership),
 * then the daemon restarts so every component starts under the new setting. The cut-over rule
 * refuses to move anything onto Rust unless the box is on arch-v2 (Podman, the Rust units on) and:
 * for the reconciler, core is running from this release's pinned binary and its shadow comparison
 * agreed with the engine on the last CUTOVER_PASSES passes; for the proxy, this release carries a
 * pinned flagship-ingress and the app network is known. Going back to TS is never refused.
 *
 * Defaults (owner, 2026-11-02): on arch-v2 the Rust owners ARE the default; TypeScript is the fallback
 * and the rollback. A box whose owner never sent an order (`chosenBy: "default"`) moves each setting to
 * Rust on its own as soon as the same cut-over rule clears it ({@link autoCutover}: core agreed on
 * CUTOVER_PASSES passes; the ingress is pinned and the app network known), then restarts. Until then,
 * and on classic, it runs shadow/TS as before. Any admin-signed order (`chosenBy: "owner"`), including
 * one back to TS, ends the automatic moves for good.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canonicalRustOwnershipOrder,
  parseRustOwnershipOrder,
  verifyRustOwnershipOrder,
  type AdminGrantView,
  type ProxyOwner,
  type ReconcilerOwner,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import { writeFileDurable } from "../durableFile.js";
import { hybridOrderSignature } from "../pqAuthority.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { CORE_STATUS, RUST_PINS_REL, RUST_RUN_DIR } from "./units.js";

export const OWNERSHIP_FILE = "/var/flagship/rust-ownership.json";
/** Consecutive agreeing shadow passes core must report before the reconciler moves to Rust. */
export const CUTOVER_PASSES = 3;
const ORDER_MAX_AGE_MS = 5 * 60_000;
const HEX_SIG = /^[0-9a-f]{128}$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export interface RustOwnership {
  version: 1;
  reconciler: ReconcilerOwner;
  proxy: ProxyOwner;
  /** The app networks the Rust proxy may dial (private IPv4 subnets). */
  proxyAllow: string[];
  /** The last orders' nonces: an order is used once. */
  nonces: string[];
  at: number;
  /** `default`: nobody ordered anything, so the Rust owners are taken as soon as they qualify. `owner`: an order set it. */
  chosenBy: "default" | "owner";
}

export const DEFAULT_OWNERSHIP: RustOwnership = { version: 1, reconciler: "shadow", proxy: "ts", proxyAllow: [], nonces: [], at: 0, chosenBy: "default" };

/** A private app network (10/8, 172.16/12, 192.168/16, 100.64/10), never loopback or the world. */
export function isAppNetwork(cidr: string): boolean {
  const m = CIDR.exec(cidr);
  if (!m) return false;
  const [a, b, c, d, len] = m.slice(1).map(Number) as [number, number, number, number, number];
  if ([a, b, c, d].some((x) => x > 255) || len < 8 || len > 30) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function parseOwnership(text: string | null): RustOwnership {
  if (!text) return { ...DEFAULT_OWNERSHIP };
  try {
    const v = JSON.parse(text) as Partial<RustOwnership>;
    return {
      version: 1,
      reconciler: v.reconciler === "rust" ? "rust" : "shadow",
      proxy: v.proxy === "rust" ? "rust" : "ts",
      proxyAllow: Array.isArray(v.proxyAllow) ? v.proxyAllow.filter((c): c is string => typeof c === "string" && isAppNetwork(c)).slice(0, 8) : [],
      nonces: Array.isArray(v.nonces) ? v.nonces.filter((n): n is string => typeof n === "string" && /^[0-9a-f]{32}$/.test(n)).slice(-64) : [],
      at: typeof v.at === "number" ? v.at : 0,
      // A file written before this field came from an owner's order.
      chosenBy: v.chosenBy === "default" ? "default" : "owner",
    };
  } catch {
    // A damaged file is the safe default: everything stays with the TS daemon, and no automatic move
    // (the file may have held an owner's rollback).
    return { ...DEFAULT_OWNERSHIP, chosenBy: "owner" };
  }
}

export function loadOwnership(path = process.env.FLAGSHIP_RUST_OWNERSHIP_FILE ?? OWNERSHIP_FILE): RustOwnership {
  try {
    return parseOwnership(existsSync(path) ? readFileSync(path, "utf8") : null);
  } catch {
    return { ...DEFAULT_OWNERSHIP, chosenBy: "owner" };
  }
}

export async function saveOwnership(o: RustOwnership, path = process.env.FLAGSHIP_RUST_OWNERSHIP_FILE ?? OWNERSHIP_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileDurable(path, `${JSON.stringify(o, null, 2)}\n`, 0o644);
}

/** What core's status file says about the app reconciler (main.rs `serve`). */
export interface CoreAppsStatus {
  ok: boolean;
  mode: string;
  live: boolean;
  agreePasses: number;
  lastShadow: string | null;
  at: number;
}

export function parseCoreStatus(text: string | null): CoreAppsStatus | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { ok?: boolean; mode?: string; at?: number; apps?: { live?: boolean; agreePasses?: number; lastShadow?: string | null } };
    return {
      ok: v.ok === true,
      mode: String(v.mode ?? ""),
      live: v.apps?.live === true,
      agreePasses: Number(v.apps?.agreePasses ?? 0),
      lastShadow: v.apps?.lastShadow ?? null,
      at: Number(v.at ?? 0),
    };
  } catch {
    return null;
  }
}

export interface CutoverFacts {
  stack: "arch-v2" | "classic";
  engine: "podman" | "docker";
  /** /run/flagship-rust/core.choice: core runs the release's pinned binary. */
  coreChoice: "rust" | "ts" | null;
  core: CoreAppsStatus | null;
  /** The release's PINS.json names a flagship-ingress. */
  ingressPinned: boolean;
  appNetworks: string[];
}

export interface Blocker {
  code: string;
  error: string;
}

/** Why the order's target can't be taken now (empty: it can). Moving back to TS never blocks. */
export function cutoverBlockers(target: { reconciler: ReconcilerOwner; proxy: ProxyOwner }, current: RustOwnership, f: CutoverFacts): Blocker[] {
  const out: Blocker[] = [];
  const onArchV2 = f.stack === "arch-v2" && f.engine === "podman";
  if (target.reconciler === "rust" && current.reconciler !== "rust") {
    if (!onArchV2) out.push({ code: "not-arch-v2", error: "This server isn't on the arch-v2 stack (Podman and the Rust components)." });
    else if (f.coreChoice !== "rust") out.push({ code: "core-not-running", error: "The Rust controller isn't running from this release on this server." });
    else if (!f.core?.ok || f.core.mode !== "serve") out.push({ code: "core-not-serving", error: "The Rust controller isn't answering the daemon yet." });
    else if (f.core.agreePasses < CUTOVER_PASSES) {
      out.push({
        code: "shadow-disagrees",
        error: `The Rust controller has agreed with what runs for ${f.core.agreePasses} of the ${CUTOVER_PASSES} checks it needs${f.core.lastShadow && f.core.lastShadow !== "agree" ? ` (last: ${f.core.lastShadow})` : ""}.`,
      });
    }
  }
  if (target.proxy === "rust" && current.proxy !== "rust") {
    if (!onArchV2) out.push({ code: "not-arch-v2", error: "This server isn't on the arch-v2 stack (Podman and the Rust components)." });
    else if (!f.ingressPinned) out.push({ code: "no-ingress", error: "This release carries no pinned Rust ingress." });
    else if (!f.appNetworks.some(isAppNetwork)) out.push({ code: "no-app-network", error: "The app network's address range isn't known yet." });
  }
  return out;
}

export function readCutoverFacts(o: { repoPath: string; stack: "arch-v2" | "classic"; engine: "podman" | "docker"; appNetworks: string[] }): CutoverFacts {
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const choice = read(join(RUST_RUN_DIR, "core.choice"))?.trim();
  let ingressPinned = false;
  try {
    const pins = JSON.parse(read(join(o.repoPath, RUST_PINS_REL)) ?? "{}") as { binaries?: Record<string, string> };
    ingressPinned = /^[0-9a-f]{64}$/.test(pins.binaries?.["flagship-ingress"] ?? "");
  } catch {
    ingressPinned = false;
  }
  return {
    stack: o.stack,
    engine: o.engine,
    coreChoice: choice === "rust" || choice === "ts" ? choice : null,
    core: parseCoreStatus(read(CORE_STATUS)),
    ingressPinned,
    appNetworks: o.appNetworks,
  };
}

export interface OwnershipHttpOptions {
  serverId: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username?: string;
  activeGrants?: () => readonly AdminGrantView[];
  gate: { check(req: HttpRequest): HttpResponse | null };
  current: () => RustOwnership;
  facts: () => Promise<CutoverFacts>;
  save: (o: RustOwnership) => Promise<void>;
  /** Restart so every component starts under the new setting. */
  requestRestart: () => void;
  /** What runs now: the reconciler mode in force, core's last answer, the proxy's decisions. */
  running?: () => unknown;
  now?: () => number;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * `GET /api/stack/rust-ownership` (owner sessions): the setting, core's view and what blocks each
 * move. `POST` `{ order, signature, pqSignature? }`: the admin-signed order; 202 and a restart.
 */
export function buildOwnershipHttp(o: OwnershipHttpOptions) {
  const now = o.now ?? (() => Date.now());
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== "/api/stack/rust-ownership") return null;
    if (req.method === "GET") {
      const denied = o.gate.check(req);
      if (denied) return denied;
      const cur = o.current();
      const f = await o.facts();
      return json(200, {
        reconciler: cur.reconciler,
        proxy: cur.proxy,
        proxyAllow: cur.proxyAllow,
        chosenBy: cur.chosenBy,
        core: f.core,
        coreChoice: f.coreChoice,
        ingressPinned: f.ingressPinned,
        running: o.running?.() ?? null,
        blockers: { reconciler: cutoverBlockers({ reconciler: "rust", proxy: cur.proxy }, cur, f), proxy: cutoverBlockers({ reconciler: cur.reconciler, proxy: "rust" }, cur, f) },
      });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    let env: { order?: unknown; signature?: unknown; pqSignature?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8")) as typeof env;
    } catch {
      return json(400, { error: "invalid json" });
    }
    const order = parseRustOwnershipOrder(env?.order);
    if (!order || typeof env.signature !== "string" || !HEX_SIG.test(env.signature)) return json(400, { error: "malformed ownership order" });
    if (order.serverDomain.toLowerCase() !== o.serverId.toLowerCase()) return json(403, { error: "serverId mismatch" });
    if (Math.abs(now() - order.issuedAt) > ORDER_MAX_AGE_MS) return json(403, { error: "stale request" });
    const authorized = authorizeSensitiveOrder({
      order,
      signature: Uint8Array.from(Buffer.from(env.signature, "hex")),
      verify: verifyRustOwnershipOrder,
      ownerIrkPub: o.ownerIrkPub,
      ...(o.adminRootPub ? { adminRootPub: o.adminRootPub } : {}),
      username: o.username ?? "",
      activeGrants: o.activeGrants?.() ?? [],
      hybrid: hybridOrderSignature(canonicalRustOwnershipOrder(order), env.pqSignature),
    });
    if (!authorized) return json(403, { error: "invalid signature" });
    const cur = o.current();
    if (cur.nonces.includes(order.nonce)) return json(409, { error: "this order was already used", code: "replayed" });
    const f = await o.facts();
    const blockers = cutoverBlockers(order, cur, f);
    if (blockers.length > 0) return json(409, { error: blockers[0]!.error, code: blockers[0]!.code, blockers });
    const next: RustOwnership = {
      version: 1,
      reconciler: order.reconciler,
      proxy: order.proxy,
      proxyAllow: order.proxy === "rust" ? f.appNetworks.filter(isAppNetwork).slice(0, 8) : cur.proxyAllow,
      nonces: [...cur.nonces, order.nonce].slice(-64),
      at: now(),
      chosenBy: "owner",
    };
    await o.save(next);
    const changed = next.reconciler !== cur.reconciler || next.proxy !== cur.proxy;
    if (changed) setTimeout(() => o.requestRestart(), 500).unref?.();
    return json(changed ? 202 : 200, { ok: true, reconciler: next.reconciler, proxy: next.proxy, state: changed ? "restarting" : "unchanged" });
  };
}

/**
 * The arch-v2 default (owner, 2026-11-02): while no order was ever sent, take each Rust owner as soon as the
 * cut-over rule clears it, one setting at a time, and say whether anything changed (the caller restarts).
 * Never moves anything back, never acts on classic, never overrides an owner's order.
 */
export async function autoCutover(o: {
  current: () => RustOwnership;
  facts: () => Promise<CutoverFacts>;
  save: (next: RustOwnership) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  /** Until then one owner is not taken alone while the other still waits: each move restarts the daemon, and a new
   *  box took the proxy and then the reconciler minutes apart (two of its first-boot restarts). */
  holdOneUntil?: number;
}): Promise<boolean> {
  const cur = o.current();
  if (cur.chosenBy !== "default") return false;
  const f = await o.facts();
  if (f.stack !== "arch-v2" || f.engine !== "podman") return false;
  const reconciler = cur.reconciler === "rust" || cutoverBlockers({ reconciler: "rust", proxy: cur.proxy }, cur, f).length === 0 ? "rust" : "shadow";
  const proxy = cur.proxy === "rust" || cutoverBlockers({ reconciler: cur.reconciler, proxy: "rust" }, cur, f).length === 0 ? "rust" : "ts";
  if (reconciler === cur.reconciler && proxy === cur.proxy) return false;
  if (o.holdOneUntil !== undefined && (o.now ?? Date.now)() < o.holdOneUntil && (reconciler !== "rust" || proxy !== "rust")) return false;
  const next: RustOwnership = {
    ...cur,
    reconciler,
    proxy,
    proxyAllow: proxy === "rust" && cur.proxy !== "rust" ? f.appNetworks.filter(isAppNetwork).slice(0, 8) : cur.proxyAllow,
    at: (o.now ?? Date.now)(),
    chosenBy: "default",
  };
  await o.save(next);
  o.log?.(`[rust-ownership] arch-v2 default: reconciler ${cur.reconciler} → ${reconciler}, proxy ${cur.proxy} → ${proxy}`);
  return true;
}
