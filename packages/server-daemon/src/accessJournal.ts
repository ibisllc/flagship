/**
 * One access list per app across the account's servers (docs/service-access-
 * gating.md, "One list per app"): the signed entries that changed an app's
 * access, kept per app so the app's servers can hand them to each other.
 *
 * Every entry carries its own proof (an admin-signed order, a withdraw signed
 * by an admin or the creating device, a join backed by the signed create and
 * the joiner's own redeem signature), so whichever box hands an entry over is
 * never trusted: each box verifies every entry itself before applying it.
 * Applying is idempotent and "latest order wins" per target, so the order in
 * which entries arrive doesn't matter.
 *
 * One entry is kept per key: the newest order for a target, the first join of
 * a person through an invite, the first withdraw of an invite.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppRankOrder, ServiceAccessModeOrder, ServiceAllowRemoveOrder } from "@flagship/protocol";

export type AccessEntry =
  | { kind: "rank"; order: AppRankOrder; signature: string }
  | { kind: "mode"; order: ServiceAccessModeOrder; signature: string }
  | { kind: "remove"; order: ServiceAllowRemoveOrder; signature: string }
  | {
      kind: "join";
      create: Record<string, unknown>;
      createSig: string;
      redeem: { secretHash: string; visitorAID: string; redeemedAt: number; aidSig: string };
    }
  | {
      kind: "accept";
      create: Record<string, unknown>;
      createSig: string;
      accept: { inviteId: string; serviceRef: string; contactAID: string; acceptedAt: number };
      acceptSig: string;
    }
  | { kind: "withdraw"; revoke: { inviteId: string; issuedAt: number }; signature: string };

/** Which entry an entry supersedes (one per key) and how it orders against it. */
export function entryKey(e: AccessEntry): string {
  switch (e.kind) {
    case "rank":
      return `rank:${e.order.target}`;
    case "mode":
      return "mode";
    case "remove":
      return `remove:${e.order.aid}`;
    case "join":
      return `join:${String(e.create.inviteId)}/${e.redeem.visitorAID.toLowerCase()}`;
    case "accept":
      return `join:${e.accept.inviteId}/${e.accept.contactAID.toLowerCase()}`;
    case "withdraw":
      return `withdraw:${e.revoke.inviteId}`;
  }
}

/** The time that orders entries under one key (later wins for orders; first wins for joins/withdraws). */
function entryTime(e: AccessEntry): number {
  switch (e.kind) {
    case "rank":
    case "mode":
    case "remove":
      return e.order.issuedAt;
    case "join":
      return e.redeem.redeemedAt;
    case "accept":
      return e.accept.acceptedAt;
    case "withdraw":
      return e.revoke.issuedAt;
  }
}

function latestWins(e: AccessEntry): boolean {
  return e.kind === "rank" || e.kind === "mode" || e.kind === "remove";
}

export function entryHash(e: AccessEntry): string {
  return createHash("sha256").update(stableJson(e)).digest("hex");
}

/** Shape-check an untrusted entry (no signature check: the applier verifies). */
export function parseEntry(v: unknown): AccessEntry | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const sig = (s: unknown) => typeof s === "string" && /^[0-9a-f]{128}$/i.test(s);
  const obj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o);
  switch (r.kind) {
    case "rank":
    case "mode":
    case "remove": {
      if (!obj(r.order) || !sig(r.signature)) return null;
      const o = r.order;
      if (typeof o.serviceRef !== "string" || typeof o.issuedAt !== "number") return null;
      if (r.kind === "rank" && (typeof o.target !== "string" || typeof o.rank !== "string")) return null;
      if (r.kind === "mode" && o.mode !== "open" && o.mode !== "restricted") return null;
      if (r.kind === "remove" && typeof o.aid !== "string") return null;
      return r as unknown as AccessEntry;
    }
    case "join": {
      const d = r.redeem as Record<string, unknown> | undefined;
      if (!obj(r.create) || !sig(r.createSig) || !obj(d)) return null;
      if (typeof d.secretHash !== "string" || typeof d.visitorAID !== "string" || typeof d.redeemedAt !== "number" || !sig(d.aidSig)) return null;
      return r as unknown as AccessEntry;
    }
    case "accept": {
      const a = r.accept as Record<string, unknown> | undefined;
      if (!obj(r.create) || !sig(r.createSig) || !obj(a) || !sig(r.acceptSig)) return null;
      if (typeof a.inviteId !== "string" || typeof a.serviceRef !== "string" || typeof a.contactAID !== "string" || typeof a.acceptedAt !== "number") return null;
      return r as unknown as AccessEntry;
    }
    case "withdraw": {
      const rv = r.revoke as Record<string, unknown> | undefined;
      if (!obj(rv) || typeof rv.inviteId !== "string" || typeof rv.issuedAt !== "number" || !sig(r.signature)) return null;
      return r as unknown as AccessEntry;
    }
    default:
      return null;
  }
}

/** Entries kept per app, at most. */
export const JOURNAL_CAP = 20_000;

interface AppJournal {
  entries: Record<string, AccessEntry>;
  /** Other servers seen running this app (so a restart knows to catch up first). */
  peers: string[];
}

export class AccessJournal {
  private byApp = new Map<string, AppJournal>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, { entries?: unknown; peers?: unknown }>;
      this.byApp.clear();
      for (const [ref, j] of Object.entries(raw ?? {})) {
        const entries: Record<string, AccessEntry> = {};
        if (j?.entries && typeof j.entries === "object") {
          for (const v of Object.values(j.entries as Record<string, unknown>)) {
            const e = parseEntry(v);
            if (e) entries[entryKey(e)] = e;
          }
        }
        const peers = Array.isArray(j?.peers) ? j.peers.filter((p): p is string => typeof p === "string") : [];
        this.byApp.set(ref, { entries, peers });
      }
    } catch {
      this.byApp.clear();
    }
  }

  /**
   * Keep an entry; returns whether it is new (or newer than the one it
   * supersedes). A join or withdraw already held under its key is kept as is.
   */
  async add(serviceRef: string, e: AccessEntry): Promise<boolean> {
    const j = this.app(serviceRef);
    const key = entryKey(e);
    const prev = j.entries[key];
    if (prev) {
      if (entryHash(prev) === entryHash(e)) return false;
      if (!latestWins(e) || entryTime(e) <= entryTime(prev)) return false;
    } else if (Object.keys(j.entries).length >= JOURNAL_CAP) {
      return false;
    }
    j.entries[key] = e;
    await this.persist();
    return true;
  }

  entries(serviceRef: string): AccessEntry[] {
    return Object.values(this.byApp.get(serviceRef)?.entries ?? {});
  }

  keys(serviceRef: string): string[] {
    return Object.keys(this.byApp.get(serviceRef)?.entries ?? {});
  }

  /** A short fingerprint of an app's entries: equal on two boxes ⇔ they hold the same entries. */
  digest(serviceRef: string): string {
    const lines = Object.entries(this.byApp.get(serviceRef)?.entries ?? {})
      .map(([k, e]) => `${k}=${entryHash(e)}`)
      .sort();
    return createHash("sha256").update(lines.join("\n")).digest("hex");
  }

  peers(serviceRef: string): string[] {
    return [...(this.byApp.get(serviceRef)?.peers ?? [])];
  }

  /** Remember the other servers running an app (union; capped). */
  async notePeers(serviceRef: string, fqdns: readonly string[]): Promise<void> {
    if (fqdns.length === 0) return;
    const j = this.app(serviceRef);
    const next = [...new Set([...j.peers, ...fqdns.map((f) => f.toLowerCase())])].slice(0, 64);
    if (next.length === j.peers.length) return;
    j.peers = next;
    await this.persist();
  }

  apps(): string[] {
    return [...this.byApp.keys()];
  }

  async forget(serviceRef: string): Promise<void> {
    if (this.byApp.delete(serviceRef)) await this.persist();
  }

  private app(serviceRef: string): AppJournal {
    let j = this.byApp.get(serviceRef);
    if (!j) {
      j = { entries: {}, peers: [] };
      this.byApp.set(serviceRef, j);
    }
    return j;
  }

  private writing: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const out: Record<string, AppJournal> = {};
      for (const [ref, j] of this.byApp) out[ref] = j;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
      await rename(tmp, this.path);
    }).catch(() => {});
    return this.writing;
  }
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
