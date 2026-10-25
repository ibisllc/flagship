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

/** The body as text, or null past `max` bytes: read chunk by chunk and abandoned at the cap, never buffered whole. */
export async function readBodyCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

/** A document over the cap: the whole refresh stops (whoever serves one oversized file serves the others). */
class CatalogTooLarge extends Error {}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readBodyCapped(res, MAX_DOC);
    if (text === null) throw new CatalogTooLarge(url);
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof CatalogTooLarge) throw e;
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
  try {
    return await refreshOnce(o);
  } catch (e) {
    if (e instanceof CatalogTooLarge) return "catalog not reachable";
    throw e;
  }
}

async function refreshOnce(o: { base: string; roots: TrustedRootStore; gate: ReleaseCatalogGate; fetchImpl?: typeof fetch }): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const base = `${o.base.replace(/\/+$/, "")}/catalog`;
  const newest = await fetchJson<Signed<RootMeta>>(f, `${base}-root.json`);
  if (newest && newest.signed?.version > o.roots.current().version) {
    for (let v = o.roots.current().version + 1; v <= newest.signed.version && v <= o.roots.current().version + 64; v++) {
      const step = v === newest.signed.version ? newest : await fetchJson<Signed<RootMeta>>(f, `${base}-root-${v}.json`);
      if (!step || !(await o.roots.advance(step))) return `root chain broke at version ${v}`;
    }
  }
  // One at a time: at most one capped body is held while it is read.
  const timestamp = await fetchJson<Signed<TimestampMeta>>(f, `${base}-timestamp.json`);
  const snapshot = await fetchJson<Signed<SnapshotMeta>>(f, `${base}-snapshot.json`);
  const targets = await fetchJson<Signed<TargetsMeta>>(f, `${base}-targets.json`);
  if (!timestamp || !snapshot || !targets) return "catalog not reachable";
  const r = await o.gate.accept({ timestamp, snapshot, targets });
  return r.ok ? `catalog accepted (targets v${r.catalog.targets.version}${r.catalog.stale ? ", stale" : ""})` : `catalog refused: ${r.reason}`;
}
