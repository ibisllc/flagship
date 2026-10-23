/**
 * Feeds the signed release catalog (protocol releaseMetadata.ts, SECURITY-HARDENING-PLAN.md 18.13) to
 * the box's gate. The trusted root starts as the one pinned in the release this box runs
 * (`release/catalog-root.json`) and moves only along a chain each step of which the previous root
 * signed (`advanceRoot`). The catalog lives beside the artifacts:
 *
 *   <artifactBase>/catalog-root.json              the newest root, signed by the one before it
 *   <artifactBase>/catalog-root-<version>.json    every root in the chain
 *   <artifactBase>/catalog-{timestamp,snapshot,targets}.json
 *
 * (Flat names: `.com` serves only flat file names from the artifact bucket.)
 *
 * A release with no pinned root runs without the catalog, as before it existed. Any failure leaves
 * the last accepted state in force: a stale catalog blocks new updates, never what already runs.
 */
import { readFile } from "node:fs/promises";
import { advanceRoot, type RootMeta, type Signed, type SnapshotMeta, type TargetsMeta, type TimestampMeta } from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "./durableFile.js";
import type { ReleaseCatalogGate } from "./releaseCatalogGate.js";

const MAX_DOC = 1 << 20;

export class TrustedRootStore {
  private root: RootMeta | null = null;

  constructor(private readonly o: { pinnedPath: string; statePath: string }) {}

  /** The pinned root, or the newest one a verified chain reached since. Null: no catalog for this release. */
  async load(): Promise<RootMeta | null> {
    let pinned: RootMeta;
    try {
      pinned = JSON.parse(await readFile(this.o.pinnedPath, "utf8")) as RootMeta;
      if (pinned?.role !== "root" || typeof pinned.version !== "number") return null;
    } catch {
      return null;
    }
    const kept = await readStateFile(this.o.statePath);
    let cur = pinned;
    if (kept.kind === "ok") {
      try {
        const k = JSON.parse(kept.text) as RootMeta;
        // A kept root only counts if it is newer than the pinned one; a release that pins a newer root wins.
        if (k?.role === "root" && k.version > pinned.version) cur = k;
      } catch {
        cur = pinned;
      }
    }
    this.root = cur;
    return cur;
  }

  current(): RootMeta {
    if (!this.root) throw new Error("no trusted catalog root");
    return this.root;
  }

  async advance(next: Signed<RootMeta>): Promise<boolean> {
    const r = advanceRoot(this.current(), next);
    if (!r.ok) return false;
    this.root = r.value;
    await writeFileDurable(this.o.statePath, JSON.stringify(r.value));
    return true;
  }
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_DOC) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** One fetch: follow the root chain, then hand the newest view to the gate. Returns what happened, for the log. */
export async function refreshReleaseCatalog(o: {
  base: string;
  roots: TrustedRootStore;
  gate: ReleaseCatalogGate;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const base = `${o.base.replace(/\/+$/, "")}/catalog`;
  const newest = await fetchJson<Signed<RootMeta>>(f, `${base}-root.json`);
  if (newest && newest.signed?.version > o.roots.current().version) {
    for (let v = o.roots.current().version + 1; v <= newest.signed.version && v <= o.roots.current().version + 64; v++) {
      const step = v === newest.signed.version ? newest : await fetchJson<Signed<RootMeta>>(f, `${base}-root-${v}.json`);
      if (!step || !(await o.roots.advance(step))) return `root chain broke at version ${v}`;
    }
  }
  const [timestamp, snapshot, targets] = await Promise.all([
    fetchJson<Signed<TimestampMeta>>(f, `${base}-timestamp.json`),
    fetchJson<Signed<SnapshotMeta>>(f, `${base}-snapshot.json`),
    fetchJson<Signed<TargetsMeta>>(f, `${base}-targets.json`),
  ]);
  if (!timestamp || !snapshot || !targets) return "catalog not reachable";
  const r = await o.gate.accept({ timestamp, snapshot, targets });
  return r.ok ? `catalog accepted (targets v${r.catalog.targets.version}${r.catalog.stale ? ", stale" : ""})` : `catalog refused: ${r.reason}`;
}
