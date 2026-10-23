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

/** Trees past this are not kept: the app still runs, it just cannot be synced from here. */
const MAX_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,125}$/;

export class ImportProvenanceStore {
  constructor(private readonly dir: string) {}

  private path(serviceId: string): string {
    if (!SAFE_ID.test(serviceId)) throw new Error("bad service id");
    return join(this.dir, `${serviceId}.json`);
  }

  /** False when the trees are too large to keep. */
  async save(serviceId: string, p: ImportProvenance): Promise<boolean> {
    const text = JSON.stringify(p);
    if (Buffer.byteLength(text) > MAX_BYTES) return false;
    await mkdir(this.dir, { recursive: true });
    await writeFileDurable(this.path(serviceId), text, 0o600);
    return true;
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
  }
}
