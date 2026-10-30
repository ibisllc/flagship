#!/usr/bin/env -S npx tsx
/**
 * Build `releases.json` for a directory of published box artifacts. The index is
 * advice for the "Update to latest" button only (packages/server-daemon
 * artifactCatalog.ts): it is unsigned, and every release it names is verified from
 * its own manifest before a box installs it.
 *
 *   npx tsx tools/box-artifact/release-index.ts <dir> [--tags commit=tag,...]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ReleaseIndexEntry {
  commit: string;
  sequence: number;
  tag?: string;
  endorsedAt?: string;
  arch: string[];
}

export function buildReleaseIndex(dir: string, tags: Record<string, string> = {}): { releases: ReleaseIndexEntry[] } {
  const byCommit = new Map<string, ReleaseIndexEntry>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".manifest.json")) continue;
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).manifest;
    if (!m || !/^[0-9a-f]{40}$/.test(m.commit) || !Number.isInteger(m.sequence)) continue;
    const e = byCommit.get(m.commit) ?? { commit: m.commit, sequence: m.sequence, arch: [] as string[] };
    if (e.sequence !== m.sequence) throw new Error(`${m.commit}: architectures disagree about the sequence`);
    if (!e.arch.includes(m.arch)) e.arch.push(m.arch);
    e.endorsedAt = new Date(m.issuedAt).toISOString();
    if (tags[m.commit]) e.tag = tags[m.commit];
    byCommit.set(m.commit, e);
  }
  const releases = [...byCommit.values()].map((e) => ({ ...e, arch: e.arch.sort() })).sort((a, b) => b.sequence - a.sequence);
  return { releases };
}

/** The new index plus every release an earlier index named whose commit is not in it (the gym keeps its older artifacts in the bucket). */
export function mergeReleaseIndex(current: { releases: ReleaseIndexEntry[] }, earlier: { releases?: unknown } | null): { releases: ReleaseIndexEntry[] } {
  const byCommit = new Map(current.releases.map((e) => [e.commit, e]));
  const old = Array.isArray(earlier?.releases) ? (earlier!.releases as ReleaseIndexEntry[]) : [];
  for (const e of old) {
    if (e && /^[0-9a-f]{40}$/.test(e.commit) && Number.isInteger(e.sequence) && Array.isArray(e.arch) && !byCommit.has(e.commit)) byCommit.set(e.commit, e);
  }
  return { releases: [...byCommit.values()].sort((a, b) => b.sequence - a.sequence) };
}

if (process.argv[1] && /release-index\.(ts|js)$/.test(process.argv[1])) {
  const dir = resolve(process.argv[2] ?? ".");
  const tagArg = process.argv.indexOf("--tags");
  const tags = Object.fromEntries((tagArg > 0 ? process.argv[tagArg + 1] ?? "" : "").split(",").filter(Boolean).map((p) => p.split("=") as [string, string]));
  const mergeArg = process.argv.indexOf("--merge");
  let earlier: { releases?: unknown } | null = null;
  if (mergeArg > 0) {
    try {
      const src = process.argv[mergeArg + 1] ?? "";
      earlier = JSON.parse(/^https?:/.test(src) ? await (await fetch(src)).text() : readFileSync(src, "utf8"));
    } catch {
      earlier = null;
    }
  }
  writeFileSync(join(dir, "releases.json"), JSON.stringify(mergeReleaseIndex(buildReleaseIndex(dir, tags), earlier), null, 2) + "\n");
  console.log(`wrote ${join(dir, "releases.json")}`);
}
