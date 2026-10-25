/**
 * Where an imported app came from, kept after it goes live so the owner can later sync with its
 * upstream (syncProposal.ts, SECURITY-HARDENING-PLAN.md 18.12): the repo and commit it was imported
 * at, that commit's tree (the base) and the tree that went live (the owner's side). Builds are
 * forgotten after 30 days; this stays until the app is removed.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileDurable } from "../durableFile.js";
import type { FileTree } from "./syncProposal.js";

export interface ImportProvenance {
  repoUrl: string;
  commit?: string;
  ref?: string;
  /** The upstream tree at that commit. */
  base: FileTree;
  /** What went live. */
  local: FileTree;
  at: number;
}

/** Where an app was imported from, without its trees: what the app's page shows ("Check for updates from <repo>"). */
export interface ImportedFrom {
  repo: string;
  commit?: string;
  ref?: string;
}

/** Trees past this are not kept: the app still runs, it just cannot be synced from here. */
const MAX_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,125}$/;

export class ImportProvenanceStore {
  constructor(private readonly dir: string) {}

  private path(serviceId: string): string {
    if (!SAFE_ID.test(serviceId)) throw new Error("bad service id");
    return join(this.dir, `${serviceId}.json`);
  }

  /** The small record beside the trees, so the app's page never parses them. */
  private fromPath(serviceId: string): string {
    if (!SAFE_ID.test(serviceId)) throw new Error("bad service id");
    return join(this.dir, `${serviceId}.from.json`);
  }

  private static from(p: Pick<ImportProvenance, "repoUrl" | "commit" | "ref">): ImportedFrom {
    return { repo: p.repoUrl, ...(p.commit ? { commit: p.commit } : {}), ...(p.ref ? { ref: p.ref } : {}) };
  }

  /** False when the trees are too large to keep. */
  async save(serviceId: string, p: ImportProvenance): Promise<boolean> {
    const text = JSON.stringify(p);
    if (Buffer.byteLength(text) > MAX_BYTES) return false;
    await mkdir(this.dir, { recursive: true });
    await writeFileDurable(this.path(serviceId), text, 0o600);
    await writeFileDurable(this.fromPath(serviceId), JSON.stringify(ImportProvenanceStore.from(p)), 0o600);
    return true;
  }

  /** The import record alone; null for an app that was not imported here (or whose trees were too large to keep). */
  async importedFrom(serviceId: string): Promise<ImportedFrom | null> {
    if (!SAFE_ID.test(serviceId)) return null;
    try {
      const f = JSON.parse(await readFile(this.fromPath(serviceId), "utf8")) as ImportedFrom;
      if (typeof f.repo === "string" && f.repo) {
        return { repo: f.repo, ...(typeof f.commit === "string" ? { commit: f.commit } : {}), ...(typeof f.ref === "string" ? { ref: f.ref } : {}) };
      }
    } catch {
      // kept before the small record existed: read the full one once and write it
    }
    const p = await this.load(serviceId);
    if (!p) return null;
    const f = ImportProvenanceStore.from(p);
    await writeFileDurable(this.fromPath(serviceId), JSON.stringify(f), 0o600).catch(() => {});
    return f;
  }

  async load(serviceId: string): Promise<ImportProvenance | null> {
    try {
      const p = JSON.parse(await readFile(this.path(serviceId), "utf8")) as ImportProvenance;
      return typeof p.repoUrl === "string" && p.base && p.local ? p : null;
    } catch {
      return null;
    }
  }

  async forget(serviceId: string): Promise<void> {
    if (!SAFE_ID.test(serviceId)) return;
    await rm(this.path(serviceId), { force: true }).catch(() => {});
    await rm(this.fromPath(serviceId), { force: true }).catch(() => {});
  }
}
