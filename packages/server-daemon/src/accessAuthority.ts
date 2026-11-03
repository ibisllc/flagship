/**
 * The Rust access decision (rust/crates/flagship-access, release plan R4) beside the proxy's own.
 *
 * `FLAGSHIP_ACCESS_AUTHORITY` picks who decides who reaches an app:
 *   - `ts`      the TypeScript proxy alone (the default on a box without the Rust access socket, i.e. classic);
 *   - `shadow`  both decide, the TypeScript answer is used and every disagreement is logged and counted;
 *   - `rust`    the Rust answer wins; an unreachable or failing Rust side refuses the request (fail closed).
 *               The default whenever the socket is up, i.e. arch-v2 with flagship-access running (owner,
 *               2026-11-02: the Rust owners are the arch-v2 default, TypeScript is the fallback and rollback).
 * The same switch routes the access WRITES (accessWrites.ts): in `rust` Rust classifies the account people from the
 * box's own files, verifies and applies journal entries and is the only writer of the access state and journal.
 * Both sides are held to packages/protocol/test-vectors/access-enforcement/decisions.json.
 *
 * The Rust side reads the access state file and the session records itself; what it is told is what the
 * proxy observed (the routed app, the request, the API-key check) and the account people the box verified.
 */
import { existsSync } from "node:fs";
import { brokerCall } from "./rustStack/brokerClient.js";

export const ACCESS_SOCKET = "/run/flagship-access/access.sock";

export type AccessAuthorityMode = "ts" | "shadow" | "rust";

/** What the access authority runs as on this box, for the owner's stack view (`GET /api/stack/rust-ownership`). */
export const accessAuthorityStatus: {
  mode: AccessAuthorityMode | null;
  decisions: (() => AccessAuthorityStats) | null;
  writes: (() => { calls: number; disagreed: number; unavailable: number }) | null;
} = { mode: null, decisions: null, writes: null };

export function accessAuthorityMode(env: NodeJS.ProcessEnv = process.env, socketPath = ACCESS_SOCKET, exists: (p: string) => boolean = existsSync): AccessAuthorityMode {
  const v = env.FLAGSHIP_ACCESS_AUTHORITY?.trim().toLowerCase();
  if (v === "ts" || v === "shadow" || v === "rust") return v;
  return exists(socketPath) ? "rust" : "ts";
}

/** What the proxy observed about one request (no decision in it). */
export interface AccessFacts {
  serviceRef: string;
  routedHost: string;
  publicRoutes: string[];
  defaultRole: string;
  method: string;
  path: string;
  upgrade: boolean;
  headers: Record<string, string>;
  sessionToken: string | null;
  apiKey: "none" | "invalid" | "scope" | "rate-limited" | { keyId: string };
  externalFresh: boolean;
}

export interface AccessVerdict {
  outcome: string;
  visitor?: string;
  role?: string | null;
  identity?: string | null;
  external?: boolean;
}

export interface AccessAuthorityHook {
  mode: "shadow" | "rust";
  decide(facts: AccessFacts): Promise<AccessVerdict>;
  /** Called with every disagreement (shadow and rust alike). */
  onDisagree?(serviceRef: string, ts: AccessVerdict, rust: AccessVerdict | null): void;
}

export function sameVerdict(a: AccessVerdict, b: AccessVerdict): boolean {
  if (a.outcome !== b.outcome) return false;
  if (a.outcome !== "forward") return true;
  return a.visitor === b.visitor && (a.role ?? null) === (b.role ?? null) && (a.identity ?? null) === (b.identity ?? null) && (a.external ?? false) === (b.external ?? false);
}

export interface AccessAuthorityStats {
  asked: number;
  disagreed: number;
  unavailable: number;
}

/**
 * The hook the proxy calls. `context` adds what only the box's verified stores know: the account people
 * (devices from the device book, co-managers from the share store), the owner's id, the catch-up hold.
 */
export function buildAccessAuthority(opts: {
  mode: "shadow" | "rust";
  context: (serviceRef: string) => { principals: unknown[]; ownerAid: string | null; catchingUp: boolean };
  /** The box's verified anchors: with them Rust classifies the account people itself (the list in `context` is unused). */
  anchors?: () => unknown;
  socketPath?: string;
  timeoutMs?: number;
  call?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (m: string) => void;
}): AccessAuthorityHook & { stats(): AccessAuthorityStats } {
  const stats: AccessAuthorityStats = { asked: 0, disagreed: 0, unavailable: 0 };
  const call = opts.call ?? ((op, args) => brokerCall(op, args, opts.socketPath ?? ACCESS_SOCKET, opts.timeoutMs ?? 2_000));
  const log = opts.log ?? ((m: string) => console.warn(m));
  const lastLog = new Map<string, number>();
  return {
    mode: opts.mode,
    stats: () => ({ ...stats }),
    async decide(facts) {
      stats.asked++;
      try {
        const r = (await call("decide", { ...facts, ...opts.context(facts.serviceRef), ...(opts.anchors ? { anchors: opts.anchors() } : {}) })) as AccessVerdict;
        if (!r || typeof r.outcome !== "string") throw new Error("no verdict");
        return r;
      } catch (e) {
        stats.unavailable++;
        throw e;
      }
    },
    onDisagree(serviceRef, ts, rust) {
      stats.disagreed++;
      const now = Date.now();
      if (now - (lastLog.get(serviceRef) ?? 0) < 60_000) return;
      lastLog.set(serviceRef, now);
      // Outcome, visitor kind and rank only: never who the visitor is.
      const brief = (v: AccessVerdict | null) => (v ? `${v.outcome}${v.visitor ? `/${v.visitor}` : ""}${v.role ? `/${v.role}` : ""}` : "unavailable");
      log(`[access] ${serviceRef}: TypeScript decided ${brief(ts)}, Rust ${brief(rust)} (${opts.mode === "rust" ? "Rust's answer used" : "shadow: TypeScript's answer used"})`);
    },
  };
}
