/**
 * Which app an app is, and which code it has run (docs/restore-into-server.md
 * §1, §2): a restore into a running server compares a backed-up app with the
 * one already here by these, never by name alone.
 *
 *   origin       16 random bytes (32 hex) minted when an app is installed
 *                from nothing; copies, backups, restores and Migrate carry it.
 *                An app that predates origins gets a legacy one, the full
 *                SHA-256 (64 hex) of `flagship/app-origin/legacy/v1|<id>`, so
 *                copies of one legacy app agree. The length tells them apart.
 *   codeHistory  the code digests the app has run, newest last, at most 100.
 *
 * Neither is ever an input to a key, an id or a link, shown to anyone, or
 * read by a model.
 */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readCarriedBinaries, readServiceSource } from "./llm/serviceSource.js";

export const MAX_CODE_HISTORY = 100;

export interface CodeHistoryEntry {
  /** `tree:<hex>` (source), `sha256:<hex>` (pulled image), `wasi:<hex>` (module) or `manifest:<hex>` (nothing better known). */
  digest: string;
  /** The manifest's version when it ran. */
  version: string;
  at: number;
}

export interface AppLineage {
  origin: string;
  forkedFrom?: string;
  codeHistory: CodeHistoryEntry[];
}

const ORIGIN_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const DIGEST_RE = /^(?:tree|sha256|wasi|manifest):[0-9a-f]{64}$/;

export function mintOrigin(): string {
  return randomBytes(16).toString("hex");
}

/** For an app seen without an origin: its id when it was first seen that way (for a backup, the archived id). */
export function legacyOrigin(serviceId: string): string {
  return createHash("sha256").update(`flagship/app-origin/legacy/v1|${serviceId}`).digest("hex");
}

export function isOrigin(v: unknown): v is string {
  return typeof v === "string" && ORIGIN_RE.test(v);
}

export function isLegacyOrigin(origin: string): boolean {
  return origin.length === 64;
}

/**
 * A working tree's digest: SHA-256 over the sorted paths, each with the
 * SHA-256 of its bytes. Text and binary files count alike, so the same
 * source gives the same digest on any server and any CPU.
 */
export function treeDigest(files: Record<string, string>, binaries: Record<string, Uint8Array> = {}): string {
  const entries = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(files)) entries.set(p, Buffer.from(c, "utf8"));
  for (const [p, b] of Object.entries(binaries)) entries.set(p, b);
  const h = createHash("sha256").update("flagship/app-tree/v1\n");
  for (const p of [...entries.keys()].sort()) {
    const fileHash = createHash("sha256").update(entries.get(p)!).digest("hex");
    h.update(`${p}\0${fileHash}\n`);
  }
  return `tree:${h.digest("hex")}`;
}

/**
 * The digest of what a manifest runs when the caller knows no tree: a
 * WASI module's digest, else an image pinned by digest, else the manifest
 * itself (a moving tag says nothing about the code it named).
 */
export function manifestCodeDigest(manifestJson: string): string {
  try {
    const m = JSON.parse(manifestJson) as { runtime?: { image?: unknown; digest?: unknown } };
    const d = typeof m.runtime?.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(m.runtime.digest) : null;
    if (d) return `wasi:${d[1]}`;
    const img = typeof m.runtime?.image === "string" ? /@sha256:([0-9a-f]{64})$/.exec(m.runtime.image) : null;
    if (img) return `sha256:${img[1]}`;
  } catch {
    /* falls through to the manifest's own digest */
  }
  return `manifest:${createHash("sha256").update(manifestJson).digest("hex")}`;
}

/** The history with one more entry; a repeat of the newest digest is not added again. */
export function appendCode(history: readonly CodeHistoryEntry[] | undefined, entry: CodeHistoryEntry): CodeHistoryEntry[] {
  const h = [...(history ?? [])];
  if (h[h.length - 1]?.digest !== entry.digest) h.push(entry);
  return h.slice(-MAX_CODE_HISTORY);
}

/** A lineage carried in a copy or a backup, checked; anything malformed reads as absent. */
export function parseLineage(v: unknown): AppLineage | null {
  const l = v as Partial<AppLineage> | null;
  if (!l || typeof l !== "object" || !isOrigin(l.origin)) return null;
  if (l.forkedFrom !== undefined && !isOrigin(l.forkedFrom)) return null;
  const history: CodeHistoryEntry[] = [];
  if (Array.isArray(l.codeHistory)) {
    for (const e of l.codeHistory.slice(-MAX_CODE_HISTORY)) {
      if (!e || typeof e.digest !== "string" || !DIGEST_RE.test(e.digest) || typeof e.version !== "string" || e.version.length > 64 || !Number.isSafeInteger(e.at)) return null;
      history.push({ digest: e.digest, version: e.version, at: e.at });
    }
  }
  return { origin: l.origin, ...(l.forkedFrom ? { forkedFrom: l.forkedFrom } : {}), codeHistory: history };
}

/**
 * What a copy or restore passes to install: the lineage it carried (or the
 * legacy one of the id the app had where it came from), and the code digest
 * it last ran, since it runs exactly that code here.
 */
export function carriedLineage(carried: unknown, carriedServiceId: string): { lineage: AppLineage; codeDigest?: string } {
  const l = parseLineage(carried) ?? { origin: legacyOrigin(carriedServiceId), codeHistory: [] };
  const last = l.codeHistory[l.codeHistory.length - 1];
  return { lineage: l, ...(last ? { codeDigest: last.digest } : {}) };
}

export type CodeRelation = "same" | "backup-older" | "backup-newer" | "diverged" | "unknown";

/** How a backup's code relates to the box's (§2.1). */
export function compareCode(backup: readonly CodeHistoryEntry[], box: readonly CodeHistoryEntry[]): CodeRelation {
  const b = backup[backup.length - 1];
  const x = box[box.length - 1];
  if (!b || !x) return "unknown";
  if (b.digest === x.digest) return "same";
  if (box.some((e) => e.digest === b.digest)) return "backup-older";
  if (backup.some((e) => e.digest === x.digest)) return "backup-newer";
  return "diverged";
}

/** Without histories: the manifests' semver, said as "probably". */
export function compareVersions(backup: string, box: string): "same" | "backup-older" | "backup-newer" | "unknown" {
  const parse = (s: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(backup);
  const b = parse(box);
  if (!a || !b) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return "backup-older";
    if (a[i]! > b[i]!) return "backup-newer";
  }
  return "same";
}

export type SchemaRelation = "same" | "backup-older" | "backup-newer" | "diverged";

/** How a backup's applied migrations relate to the box's (§2.2). */
export function compareSchema(backup: readonly string[], box: readonly string[]): SchemaRelation {
  const B = new Set(backup);
  const X = new Set(box);
  const bInX = [...B].every((m) => X.has(m));
  const xInB = [...X].every((m) => B.has(m));
  if (bInX && xInB) return "same";
  if (bInX) return "backup-older";
  if (xInB) return "backup-newer";
  return "diverged";
}

/** The migrations the box's code would run on the backup's data (X∖B, in filename order). */
export function migrationsToRun(backup: readonly string[], box: readonly string[]): string[] {
  const B = new Set(backup);
  return [...new Set(box)].filter((m) => !B.has(m)).sort((a, b) => a.localeCompare(b));
}

/** The schema guard a plan line pins (§4.2): SHA-256 hex of the sorted migration names. */
export function schemaGuard(applied: readonly string[]): string {
  return createHash("sha256").update([...new Set(applied)].sort().join("\n")).digest("hex");
}

/** The digest of an app's working tree as written on this box (what a backup carries), or undefined. */
export async function writtenTreeDigest(workingDir: string, serviceId: string): Promise<string | undefined> {
  const tree = await readServiceSource(workingDir, serviceId).catch(() => null);
  if (!tree?.ok) return undefined;
  const binaries = await readCarriedBinaries(join(workingDir, serviceId)).catch(() => ({}));
  return treeDigest(tree.files, binaries);
}
