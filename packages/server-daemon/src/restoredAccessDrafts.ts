/**
 * Permissions a restore held back (SECURITY-HARDENING-PLAN.md 18.9, N09). A backup's list of who
 * could use an app is brought back only as an inert draft: the app is members-only with nobody on
 * the list until an admin approves THIS draft with a signature over its digest. A draft that is
 * replaced, or discarded, cannot be approved with an old signature. Kept in the state directory,
 * not in app data, so restoring an app cannot restore an approval.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "./durableFile.js";

export type DraftEntry = {
  mode: "open" | "restricted";
  allow: string[];
  groups: Record<string, string[]>;
  roles?: unknown;
};

export interface DraftInfo {
  serviceRef: string;
  sha256: string;
  people: number;
  mode: "open" | "restricted";
  restoredAt: number;
}

interface Row {
  entry: DraftEntry;
  sha256: string;
  restoredAt: number;
}

export function draftDigest(serviceRef: string, e: DraftEntry): string {
  return createHash("sha256").update(JSON.stringify({ serviceRef, mode: e.mode, allow: [...e.allow].sort(), groups: sortGroups(e.groups), roles: e.roles ?? null })).digest("hex");
}

function sortGroups(g: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.keys(g).sort().map((k) => [k, [...g[k]!].sort()]));
}

export class RestoredAccessDrafts {
  private rows = new Map<string, Row>();

  constructor(private readonly path: string, private readonly now: () => number = () => Date.now()) {}

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const p = JSON.parse(read.text) as { v?: number; rows?: Record<string, Row> };
      if (p?.v !== 1 || typeof p.rows !== "object") throw new Error("not a restored-access file");
      for (const [k, v] of Object.entries(p.rows ?? {})) this.rows.set(k, v);
    } catch (e) {
      // Losing a draft loses nothing live: the apps stay members-only and the owner invites again.
      await keepCorruptAside(this.path, e, "Permissions a restore was holding for approval are gone; people are invited again.");
    }
  }

  async put(serviceRef: string, entry: DraftEntry): Promise<DraftInfo> {
    const row: Row = { entry, sha256: draftDigest(serviceRef, entry), restoredAt: this.now() };
    this.rows.set(serviceRef, row);
    await this.persist();
    return this.info(serviceRef, row);
  }

  get(serviceRef: string): { info: DraftInfo; entry: DraftEntry } | null {
    const r = this.rows.get(serviceRef);
    return r ? { info: this.info(serviceRef, r), entry: r.entry } : null;
  }

  list(): DraftInfo[] {
    return [...this.rows].map(([k, r]) => this.info(k, r));
  }

  async remove(serviceRef: string): Promise<boolean> {
    if (!this.rows.delete(serviceRef)) return false;
    await this.persist();
    return true;
  }

  private info(serviceRef: string, r: Row): DraftInfo {
    return { serviceRef, sha256: r.sha256, people: r.entry.allow.length, mode: r.entry.mode, restoredAt: r.restoredAt };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, (write) => write(JSON.stringify({ v: 1, rows: Object.fromEntries(this.rows) })));
  }
}
