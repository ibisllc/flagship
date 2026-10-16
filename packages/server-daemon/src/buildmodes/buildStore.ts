/**
 * Where git and IDE builds are kept across a daemon restart (an update
 * causes one), like build chats (llm/vibeCodeSession.ts). One file per build
 * holds its state, files, env requests (names only) and repo source; its
 * non-text files sit beside it, written once. Writes are durable
 * (durableFile.ts). The MCP key lives in its own store (mcpKeyStore.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { removeDurable, writeFileDurable } from "../durableFile.js";

/** What a build needs to come back; the orchestrator owns the shapes inside. */
export interface BuildSnapshot {
  v: 1;
  buildId: string;
  updatedAt: number;
  state: unknown;
  files: Record<string, string>;
  envRequests?: unknown[];
  gitSource?: unknown;
  aiTouched: boolean;
  sealed: boolean;
}

export interface StoredBuild {
  snap: BuildSnapshot;
  /** path → base64 */
  binaries?: Record<string, string>;
}

export interface BuildStore {
  save(snap: BuildSnapshot): Promise<void>;
  saveBinaries(buildId: string, binaries: Record<string, string>): Promise<void>;
  loadAll(): Promise<StoredBuild[]>;
  delete(buildId: string): Promise<void>;
}

const BUILD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function fileBuildStore(dir: string): BuildStore {
  const main = (id: string) => join(dir, `${id}.json`);
  const bins = (id: string) => join(dir, `${id}.bin.json`);
  return {
    async save(snap) {
      if (!BUILD_ID_RE.test(snap.buildId)) return;
      await writeFileDurable(main(snap.buildId), JSON.stringify(snap));
    },
    async saveBinaries(buildId, binaries) {
      if (!BUILD_ID_RE.test(buildId)) return;
      await writeFileDurable(bins(buildId), JSON.stringify(binaries));
    },
    async loadAll() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const out: StoredBuild[] = [];
      for (const n of names) {
        if (!n.endsWith(".json") || n.endsWith(".bin.json")) continue;
        const id = n.slice(0, -".json".length);
        if (!BUILD_ID_RE.test(id)) continue;
        try {
          const snap = JSON.parse(await readFile(main(id), "utf8")) as BuildSnapshot;
          if (snap?.v !== 1 || snap.buildId !== id) continue;
          let binaries: Record<string, string> | undefined;
          try {
            binaries = JSON.parse(await readFile(bins(id), "utf8")) as Record<string, string>;
          } catch {
            /* a build without non-text files */
          }
          out.push({ snap, ...(binaries ? { binaries } : {}) });
        } catch {
          /* unreadable: skipped */
        }
      }
      return out;
    },
    async delete(buildId) {
      if (!BUILD_ID_RE.test(buildId)) return;
      await removeDurable(main(buildId));
      await removeDurable(bins(buildId));
    },
  };
}
