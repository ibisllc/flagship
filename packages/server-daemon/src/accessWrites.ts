/**
 * The access WRITES through the Rust authority (rust/crates/flagship-access, release plan R4): the account people,
 * handed-over journal entries (verified and applied), the store's own changes and the access journal.
 *
 * Same switch as the decision (`FLAGSHIP_ACCESS_AUTHORITY`, accessAuthority.ts):
 *   - `rust`    Rust verifies, applies and writes `service-access.json` and `access-journal.json` (the only writer);
 *               the daemon keeps a read copy from each answer. An unreachable Rust side fails the change (closed).
 *   - `shadow`  TypeScript writes as before; after each change Rust is asked the same question in a dry run over
 *               the state TypeScript had before it, and every difference in result or state is logged and counted.
 *   - `ts`      no Rust side.
 * Both are held to packages/server-daemon/test-vectors/access-writes.json.
 *
 * The anchors (owner key, admin root, owner AID, account, server name, strict assurance) are what the daemon's boot
 * resolution verified; the people are read and verified by Rust from the box's own files, never sent by the daemon.
 */
import type { AccessEntry } from "./accessJournal.js";
import type { EntryResult } from "./serviceAccess.js";
import { brokerCall } from "./rustStack/brokerClient.js";
import { ACCESS_SOCKET } from "./accessAuthority.js";

export interface AccessAnchors {
  username: string;
  ownerIrkHex: string;
  adminRootHex?: string;
  ownerAidHex?: string;
  serverDomain: string;
  strict?: boolean;
}

/** The facts of one app the daemon holds in memory (installed, catching up). */
export interface AppFacts {
  installed: boolean;
  catchingUp: string[];
}

export interface AccessWritesStats {
  calls: number;
  disagreed: number;
  unavailable: number;
}

export interface StateMirror {
  /** The state file's text as TypeScript holds it. */
  snapshotText(): string;
  /** Take Rust's state as the read copy. */
  adoptState(state: unknown): void;
}

export interface JournalApp {
  entries: Record<string, AccessEntry>;
  peers: string[];
  digest: string;
}

/** Equal as state files: key order aside, numbers by value. */
export function sameState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameState(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameState((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export class AccessWrites {
  private readonly st: AccessWritesStats = { calls: 0, disagreed: 0, unavailable: 0 };
  private readonly call: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  private readonly log: (m: string) => void;
  private lastLog = 0;

  constructor(
    readonly mode: "shadow" | "rust",
    private readonly anchors: () => AccessAnchors,
    opts: { call?: (op: string, args: Record<string, unknown>) => Promise<unknown>; socketPath?: string; log?: (m: string) => void } = {},
  ) {
    this.call = opts.call ?? ((op, args) => brokerCall(op, args, opts.socketPath ?? ACCESS_SOCKET, 5_000));
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  stats(): AccessWritesStats {
    return { ...this.st };
  }

  private async ask<T>(op: string, args: Record<string, unknown>): Promise<T> {
    this.st.calls++;
    try {
      return (await this.call(op, { anchors: this.anchors(), ...args })) as T;
    } catch (e) {
      this.st.unavailable++;
      throw e;
    }
  }

  /** A difference between the two sides (what, never who). */
  private differ(what: string, ts: unknown, rust: unknown): void {
    this.st.disagreed++;
    const now = Date.now();
    if (now - this.lastLog < 60_000) return;
    this.lastLog = now;
    const brief = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? String(v) : typeof v);
    this.log(`[access] ${what}: TypeScript ${brief(ts)}, Rust ${brief(rust)} (${this.mode === "rust" ? "Rust's answer used" : "shadow: TypeScript's answer used"})`);
  }

  // ── the store's own changes ─────────────────────────────────────────────────────────────────────────────────────

  /** Rust makes the change and writes the file; the read copy follows. */
  async storeMutate(method: string, args: Record<string, unknown>, mirror: StateMirror): Promise<unknown> {
    const r = await this.ask<{ result: unknown; state: unknown }>("store-mutate", { method, args });
    mirror.adoptState(r.state);
    return r.result;
  }

  /** Shadow: the same change in a dry run over the state before it. Never throws, never waits the caller. */
  shadowStore(method: string, args: Record<string, unknown>, pre: string, tsResult: unknown, post: string): void {
    void this.ask<{ result: unknown; state: unknown }>("store-mutate", { method, args, dryRun: true, state: pre })
      .then((r) => {
        if (!sameState(tsResult ?? null, r.result ?? null)) this.differ(`store ${method} result`, tsResult ?? null, r.result);
        else if (!sameState(JSON.parse(post), r.state)) this.differ(`store ${method} state`, "a state", "another");
      })
      .catch(() => {});
  }

  // ── handed-over entries ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Apply one handed-over entry. `ts` is the TypeScript applier (shadow, and the people refresh it may need);
   * `refreshPeople` asks `.com` for the device book again (a create signed by a device added since).
   */
  async apply(
    serviceRef: string,
    entry: AccessEntry,
    facts: AppFacts,
    mirror: StateMirror,
    ts: () => Promise<EntryResult>,
    refreshPeople: () => Promise<void>,
  ): Promise<EntryResult> {
    if (this.mode === "shadow") {
      const pre = mirror.snapshotText();
      const tsResult = await ts();
      const post = mirror.snapshotText();
      void this.ask<{ result: EntryResult; state: unknown }>("apply-entry", { serviceRef, entry, ...facts, dryRun: true, state: pre })
        .then((r) => {
          if (r.result !== tsResult) this.differ(`${entry.kind} entry`, tsResult, r.result);
          else if (!sameState(JSON.parse(post), r.state)) this.differ(`${entry.kind} entry state`, "a state", "another");
        })
        .catch(() => {});
      return tsResult;
    }
    const once = async () => {
      const r = await this.ask<{ result: EntryResult; state: unknown }>("apply-entry", { serviceRef, entry, ...facts });
      mirror.adoptState(r.state);
      return r.result;
    };
    const first = await once();
    if (first !== "refused" || (entry.kind !== "join" && entry.kind !== "accept")) return first;
    // As `peerCreate`: a create's signer may be a device the book learns of on a refresh.
    await refreshPeople();
    return once();
  }

  // ── the journal ─────────────────────────────────────────────────────────────────────────────────────────────────

  async journalAdd(serviceRef: string, entry: AccessEntry, facts: AppFacts): Promise<{ kept: boolean; app: JournalApp }> {
    const r = await this.ask<{ result: string; app: JournalApp }>("journal-add", { serviceRef, entry, ...facts });
    return { kept: r.result === "kept", app: r.app };
  }

  shadowJournalAdd(serviceRef: string, entry: AccessEntry, facts: AppFacts, preJournal: string, state: string, tsKept: boolean): void {
    void this.ask<{ result: string }>("journal-add", { serviceRef, entry, ...facts, dryRun: true, journal: preJournal, state })
      .then((r) => {
        const kept = r.result === "kept";
        if (kept !== tsKept) this.differ(`journal ${entry.kind}`, tsKept ? "kept" : "held", r.result);
      })
      .catch(() => {});
  }

  async journalPeers(serviceRef: string, fqdns: readonly string[]): Promise<JournalApp> {
    return (await this.ask<{ app: JournalApp }>("journal-note-peers", { serviceRef, fqdns })).app;
  }

  async journalForget(serviceRef: string): Promise<void> {
    await this.ask("journal-forget", { serviceRef });
  }

  // ── the people ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Compare the people both sides verified (devices with tiers, co-managers); the shadow check of classification. */
  async comparePeople(ts: { devices: Array<{ pub: string; deviceId: string | null; tier: string }>; coManagers: Array<{ pub: string; shareId: string; label: string; level: string }> }): Promise<boolean> {
    const r = await this.ask<{ devices: unknown[]; coManagers: unknown[] }>("people", {});
    const norm = (l: unknown[]) => [...l].map((x) => JSON.stringify(x, Object.keys(x as object).sort())).sort();
    const same = sameState(norm(ts.devices), norm(r.devices)) && sameState(norm(ts.coManagers), norm(r.coManagers));
    if (!same) this.differ("account people", `${ts.devices.length}/${ts.coManagers.length}`, `${r.devices.length}/${r.coManagers.length}`);
    return same;
  }
}
