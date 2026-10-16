/**
 * One access list per app across the account's servers (docs/service-access-
 * gating.md, "One list per app").
 *
 * The app's lead server (the gossip leader for its slug: the live server
 * highest in the owner's server order that runs it) holds the list. A change
 * accepted on any server (an admin order, a join, a withdraw) is verified there
 * as usual, kept in the app's journal, and handed to the leader, which applies
 * it and copies it out to the app's other servers in server order. Every box
 * verifies every entry itself, so the leader only distributes and is never
 * trusted; applying is idempotent with latest-order-wins per target.
 *
 * Box to box only, over each box's own TLS (`https://<server>/api/access-sync/…`),
 * authenticated with a key derived from the account's cloud gossip key: `.com`
 * never sees an app's member ids or ranks.
 *
 * Catching up: a box that knows other servers run an app (from its journal)
 * starts that app "catching up" at boot (and after an app copy): only the
 * owning account's devices get in until it has pulled the list from the leader
 * or the next live server in the order, so nobody another server removed slips
 * in. With no other live server for the liveness window, the box is alone and
 * serves its own list.
 *
 * Every few minutes each box also compares its journal with the leader's and
 * both sides take what they lack (a box that missed a push heals), and a push
 * that failed is retried.
 *
 * Scope seam: `scope(serviceRef)` is "account" for every app on main. A future
 * per-server list (a Pro option on feat/marketplace) returns "server" and its
 * changes stay on the box; going back to "account" adopts the leader's list.
 */
import { createHash, createHmac } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { ServiceAccessStore, EntryResult } from "./serviceAccess.js";
import { entryHash, entryKey, parseEntry, type AccessEntry, type AccessJournal } from "./accessJournal.js";

export const ACCESS_SYNC_TAG = "flagship/access-sync/v1";
const KEY_INFO = "flagship/access-sync/key/v1";
const MAX_SKEW_MS = 5 * 60_000;
const MAX_ENTRIES_PER_PUSH = 2000;

export type AccessScope = "account" | "server";

/** Where the app's other servers are, from gossip. */
export interface AccessPeers {
  /** The app's lead server right now (this box's own FQDN when it leads), or null when unknown. */
  leaderFor(serviceRef: string): string | null;
  /** The other live servers running the app, in server order. */
  runners(serviceRef: string): string[];
}

/** The box-to-box key, from the account's cloud gossip key. */
export function deriveAccessSyncKey(cgk: Uint8Array): Uint8Array {
  return hkdf(sha256, cgk, new Uint8Array(0), new TextEncoder().encode(KEY_INFO), 32);
}

export function accessSyncMac(
  key: Uint8Array,
  f: { op: "push" | "pull"; from: string; to: string; serviceRef: string; issuedAt: number; body: string },
): string {
  const bodyHash = createHash("sha256").update(f.body).digest("hex");
  const canonical = [ACCESS_SYNC_TAG, f.op, f.from.toLowerCase(), f.to.toLowerCase(), f.serviceRef, String(f.issuedAt), bodyHash].join("|");
  return createHmac("sha256", key).update(canonical).digest("hex");
}

export interface AccessSyncOptions {
  selfFqdn: string;
  journal: AccessJournal;
  store: Pick<ServiceAccessStore, "setCatchingUp" | "isCatchingUp">;
  /** Verify and apply one handed-over entry (rank entries included). */
  apply: (serviceRef: string, entry: AccessEntry) => Promise<EntryResult>;
  /** Late-bound: null until gossip is up (then nothing is handed over). */
  peers: () => AccessPeers | null;
  /** The box-to-box key; null disables handing over (a box with no cloud gossip key). */
  key: Uint8Array | null;
  installed: (serviceRef: string) => boolean;
  /** Apps installed here (catch-up and the periodic compare walk them). */
  apps: () => string[];
  scope?: (serviceRef: string) => AccessScope;
  fetchImpl?: typeof fetch;
  baseUrl?: (fqdn: string) => string;
  now?: () => number;
  /** How long a box with no other live server for an app waits before serving its own list. */
  aloneAfterMs?: number;
  log?: (m: string) => void;
}

export interface AccessSync {
  /** A change this box accepted: keep it and hand it to the leader (or, leading, to the others). */
  record(serviceRef: string, entry: AccessEntry): void;
  /** `/api/access-sync/push` and `/api/access-sync/pull`. */
  handle(req: HttpRequest): Promise<HttpResponse | null>;
  /** Hold an app until its list is pulled from the leader (or the next live server). */
  catchUp(serviceRef: string): Promise<boolean>;
  /** One catch-up round for every app still waiting (what the 10 s timer runs). */
  catchUpAll(): Promise<void>;
  /** Compare with the leader once for every app (both sides take what they lack). */
  reconcileOnce(): Promise<void>;
  /** Retry failed pushes once. */
  flushOnce(): Promise<void>;
  /** Whether `peer` runs the app and answers (an authenticated pull with this box's digest). */
  probe(peer: string, serviceRef: string): Promise<boolean>;
  /** Drop an uninstalled app's journal and pending hand-overs. */
  forget(serviceRef: string): Promise<void>;
  /**
   * Wait for every hand-over this box has under way (and any it starts
   * meanwhile) to finish; resolves true when there was one.
   */
  idle(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function buildAccessSync(opts: AccessSyncOptions): AccessSync {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? ((f: string) => `https://${f}`);
  const scope = opts.scope ?? (() => "account");
  const self = opts.selfFqdn.toLowerCase();
  const startedAt = now();
  const aloneAfterMs = opts.aloneAfterMs ?? 120_000;
  /** peer → serviceRef → entries still to hand over */
  const outbox = new Map<string, Map<string, Map<string, AccessEntry>>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  const inFlight = new Set<Promise<void>>();

  /** Run a hand-over in the background; it must never reject. */
  function background(p: Promise<void>): void {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  const shared = (ref: string) => opts.key !== null && scope(ref) === "account";

  function queue(peer: string, ref: string, entries: AccessEntry[]): void {
    const byRef = outbox.get(peer) ?? new Map<string, Map<string, AccessEntry>>();
    outbox.set(peer, byRef);
    const m = byRef.get(ref) ?? new Map<string, AccessEntry>();
    byRef.set(ref, m);
    for (const e of entries) m.set(entryKey(e), e);
  }

  async function post(op: "push" | "pull", to: string, ref: string, payload: Record<string, unknown>): Promise<Response | null> {
    if (!opts.key) return null;
    const issuedAt = now();
    const body = JSON.stringify(payload);
    const mac = accessSyncMac(opts.key, { op, from: self, to, serviceRef: ref, issuedAt, body });
    try {
      const r = await fetchImpl(`${baseUrl(to)}/api/access-sync/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: self, to, serviceRef: ref, issuedAt, mac, body }),
      });
      return r;
    } catch {
      return null;
    }
  }

  async function push(to: string, ref: string, entries: AccessEntry[]): Promise<boolean> {
    for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_PUSH) {
      const r = await post("push", to, ref, { entries: entries.slice(i, i + MAX_ENTRIES_PER_PUSH) });
      if (!r || !r.ok) return false;
    }
    return true;
  }

  /** Hand entries to every other live runner, in server order (the leader's job). */
  async function fanOut(ref: string, entries: AccessEntry[], except: string | null): Promise<void> {
    const runners = opts.peers()?.runners(ref) ?? [];
    await opts.journal.notePeers(ref, runners);
    for (const peer of runners) {
      if (peer === except || peer === self) continue;
      if (!(await push(peer, ref, entries))) queue(peer, ref, entries);
    }
  }

  async function forward(ref: string, entries: AccessEntry[]): Promise<void> {
    if (!shared(ref) || entries.length === 0) return;
    const leader = opts.peers()?.leaderFor(ref)?.toLowerCase() ?? null;
    if (!leader || leader === self) {
      await fanOut(ref, entries, null);
      return;
    }
    if (!(await push(leader, ref, entries))) queue(leader, ref, entries);
  }

  const failed = (ref: string) => (e: unknown) => log(`[access-sync] ${ref}: hand-over failed: ${String((e as Error)?.message ?? e)}`);

  function record(ref: string, entry: AccessEntry): void {
    background(
      (async () => {
        if (!(await opts.journal.add(ref, entry))) return;
        await forward(ref, [entry]);
      })().catch(failed(ref)),
    );
  }

  /** Apply what a peer handed over; returns the entries new to this box. */
  async function take(ref: string, raw: unknown[]): Promise<AccessEntry[]> {
    const fresh: AccessEntry[] = [];
    for (const v of raw) {
      const e = parseEntry(v);
      if (!e) continue;
      let r: EntryResult;
      try {
        r = await opts.apply(ref, e);
      } catch {
        r = "refused";
      }
      if (r === "refused" || r === "skipped") continue;
      // `stale` still means a valid entry another box may lack (an older order).
      if (await opts.journal.add(ref, e)) fresh.push(e);
    }
    return fresh;
  }

  function readEnvelope(req: HttpRequest, op: "push" | "pull"): { from: string; ref: string; payload: Record<string, unknown> } | HttpResponse {
    if (!opts.key) return bad(404, "not found");
    let env: { from?: unknown; to?: unknown; serviceRef?: unknown; issuedAt?: unknown; mac?: unknown; body?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    if (
      typeof env.from !== "string" ||
      typeof env.to !== "string" ||
      typeof env.serviceRef !== "string" ||
      typeof env.issuedAt !== "number" ||
      typeof env.mac !== "string" ||
      typeof env.body !== "string"
    ) {
      return bad(400, "malformed");
    }
    if (env.to.toLowerCase() !== self) return bad(403, "not this server");
    if (Math.abs(now() - env.issuedAt) > MAX_SKEW_MS) return bad(403, "stale");
    const want = accessSyncMac(opts.key, {
      op,
      from: env.from,
      to: env.to,
      serviceRef: env.serviceRef,
      issuedAt: env.issuedAt,
      body: env.body,
    });
    if (!timingSafeEqualHex(want, env.mac)) return bad(403, "bad mac");
    if (!shared(env.serviceRef)) return bad(409, "this app keeps its own list on this server");
    if (!opts.installed(env.serviceRef)) return bad(404, "the app isn't on this server");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(env.body) as Record<string, unknown>;
    } catch {
      return bad(400, "invalid body");
    }
    return { from: env.from.toLowerCase(), ref: env.serviceRef, payload };
  }

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.method !== "POST") return null;
    if (req.path === "/api/access-sync/push") {
      const env = readEnvelope(req, "push");
      if ("status" in env) return env;
      const raw = Array.isArray(env.payload.entries) ? env.payload.entries : [];
      if (raw.length > MAX_ENTRIES_PER_PUSH) return bad(413, "too many entries");
      const fresh = await take(env.ref, raw);
      await opts.journal.notePeers(env.ref, [env.from]);
      const leader = opts.peers()?.leaderFor(env.ref)?.toLowerCase() ?? null;
      if (fresh.length > 0 && leader === self) background(fanOut(env.ref, fresh, env.from).catch(failed(env.ref)));
      return json(200, { ok: true, taken: fresh.length, digest: opts.journal.digest(env.ref) });
    }
    if (req.path === "/api/access-sync/pull") {
      const env = readEnvelope(req, "pull");
      if ("status" in env) return env;
      await opts.journal.notePeers(env.ref, [env.from]);
      const digest = opts.journal.digest(env.ref);
      if (env.payload.digest === digest) return json(200, { same: true, digest });
      return json(200, { same: false, digest, entries: opts.journal.entries(env.ref) });
    }
    return null;
  }

  /** Pull from `peer`, take what it has, push back what it lacks. */
  async function syncWith(peer: string, ref: string): Promise<boolean> {
    const r = await post("pull", peer, ref, { digest: opts.journal.digest(ref) });
    if (!r || !r.ok) return false;
    let body: { same?: unknown; entries?: unknown };
    try {
      body = (await r.json()) as typeof body;
    } catch {
      return false;
    }
    if (body.same === true) return true;
    const theirs = Array.isArray(body.entries) ? body.entries : [];
    await take(ref, theirs);
    const theirHashes = new Map<string, string>();
    for (const v of theirs) {
      const e = parseEntry(v);
      if (e) theirHashes.set(entryKey(e), entryHash(e));
    }
    const missing = opts.journal.entries(ref).filter((e) => theirHashes.get(entryKey(e)) !== entryHash(e));
    if (missing.length > 0) await push(peer, ref, missing);
    return true;
  }

  /** The server to catch up from: the leader, else the next live runner in the order. */
  function sources(ref: string): string[] {
    const p = opts.peers();
    if (!p) return [];
    const leader = p.leaderFor(ref)?.toLowerCase() ?? null;
    const runners = p.runners(ref).map((x) => x.toLowerCase()).filter((x) => x !== self);
    return leader && leader !== self ? [leader, ...runners.filter((x) => x !== leader)] : runners;
  }

  async function catchUp(ref: string): Promise<boolean> {
    if (!shared(ref)) {
      opts.store.setCatchingUp(ref, false);
      return true;
    }
    for (const peer of sources(ref)) {
      if (await syncWith(peer, ref)) {
        opts.store.setCatchingUp(ref, false);
        log(`[access-sync] ${ref}: caught up from ${peer}`);
        return true;
      }
    }
    return false;
  }

  async function tickCatchUp(): Promise<void> {
    for (const ref of opts.apps()) {
      if (!opts.store.isCatchingUp(ref)) continue;
      if (await catchUp(ref)) continue;
      if (sources(ref).length === 0 && now() - startedAt >= aloneAfterMs) {
        opts.store.setCatchingUp(ref, false);
        log(`[access-sync] ${ref}: no other server is up; serving this server's list`);
      }
    }
  }

  async function reconcileOnce(): Promise<void> {
    for (const ref of opts.apps()) {
      if (!shared(ref) || opts.store.isCatchingUp(ref)) continue;
      const p = opts.peers();
      if (!p) return;
      await opts.journal.notePeers(ref, p.runners(ref));
      const [first] = sources(ref);
      if (first) await syncWith(first, ref);
    }
  }

  async function flushOnce(): Promise<void> {
    for (const [peer, byRef] of [...outbox]) {
      for (const [ref, m] of [...byRef]) {
        const entries = [...m.values()];
        // A queued push to a leader that has since lost the role goes to the new one.
        const leader = opts.peers()?.leaderFor(ref)?.toLowerCase() ?? null;
        const to = leader && leader !== self && !(opts.peers()?.runners(ref) ?? []).includes(peer) ? leader : peer;
        if (await push(to, ref, entries)) byRef.delete(ref);
      }
      if (byRef.size === 0) outbox.delete(peer);
    }
  }

  return {
    record,
    handle,
    catchUp: async (ref) => {
      if (shared(ref) && sources(ref).length > 0) opts.store.setCatchingUp(ref, true);
      return catchUp(ref);
    },
    reconcileOnce,
    flushOnce,
    catchUpAll: tickCatchUp,
    async probe(peer, ref) {
      if (!shared(ref)) return false;
      const r = await post("pull", peer.toLowerCase(), ref, { digest: opts.journal.digest(ref) });
      return !!r && r.ok;
    },
    async idle() {
      if (inFlight.size === 0) return false;
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      return true;
    },
    async forget(ref) {
      opts.store.setCatchingUp(ref, false);
      for (const byRef of outbox.values()) byRef.delete(ref);
      await opts.journal.forget(ref);
    },
    start() {
      // Apps other servers ran (as of the last run) wait for the list first;
      // with the journal lost, which those were is unknown, so every one does.
      const lost = opts.journal.wasLost();
      for (const ref of opts.apps()) {
        if (shared(ref) && (lost || opts.journal.peers(ref).length > 0)) opts.store.setCatchingUp(ref, true);
      }
      const every = (ms: number, f: () => Promise<void>) => {
        const t = setInterval(() => void f().catch(() => {}), ms);
        if (typeof t.unref === "function") t.unref();
        timers.push(t);
      };
      every(10_000, tickCatchUp);
      every(30_000, flushOnce);
      every(120_000, reconcileOnce);
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function bad(status: number, error: string): HttpResponse {
  return json(status, { error });
}
