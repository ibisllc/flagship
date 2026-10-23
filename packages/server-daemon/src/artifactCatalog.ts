import { BOX_RELEASE } from "@flagship/protocol";
import type { ReleaseCatalog, ReleaseCatalogSource, ReleaseEntry } from "./updateReleases.js";
import { nodeArch, readInstalledRelease } from "./artifactUpdate.js";

/**
 * The releases this box could move to, from the release index published beside
 * the artifacts (`<artifactBase>/releases.json`). The index is advice only: it
 * is not signed, and nothing in it can make the box run anything. Every
 * release the owner picks is downloaded and verified from its own manifest
 * (k-of-n signatures, digest, sequence) before it is installed, so a hostile
 * or stale index can at worst offer a release that is then refused.
 * The manifest sequence orders releases: higher is newer.
 */
export interface ReleaseIndexEntry {
  commit: string;
  sequence: number;
  tag?: string;
  endorsedAt?: string;
  arch: string[];
}

export interface ArtifactCatalogOptions {
  artifactBase?: string;
  stateDir?: string;
  arch?: string;
  maxAgeMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

const COMMIT = /^[0-9a-f]{40}$/;

export function buildArtifactCatalog(opts: ArtifactCatalogOptions = {}): ReleaseCatalogSource {
  const base = opts.artifactBase ?? BOX_RELEASE.artifactBase;
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  let cached: ReleaseCatalog | null = null;
  let inFlight: Promise<ReleaseCatalog> | null = null;

  async function build(): Promise<ReleaseCatalog> {
    const installed = await readInstalledRelease(opts.stateDir);
    let arch: string;
    try {
      arch = nodeArch(opts.arch);
    } catch {
      return { checkedAt: now(), currentCommit: installed?.commit ?? null, latest: null, releases: [], stale: true };
    }
    let entries: ReleaseIndexEntry[] = [];
    let fetched = true;
    try {
      const res = await fetchImpl(`${base}/releases.json`, { redirect: "follow" });
      if (!res.ok) throw new Error(`index ${res.status}`);
      const text = await res.text();
      if (text.length > 1 << 20) throw new Error("index too large");
      const j = JSON.parse(text) as { releases?: ReleaseIndexEntry[] };
      entries = (j.releases ?? []).filter(
        (e) => COMMIT.test(e.commit) && Number.isInteger(e.sequence) && Array.isArray(e.arch) && e.arch.includes(arch),
      );
    } catch (e) {
      fetched = false;
      log(`[updates] release index unavailable: ${(e as Error).message}`);
    }
    const releases: ReleaseEntry[] = entries
      .map((e) => ({
        commit: e.commit,
        releaseId: `seq-${e.sequence}`,
        tag: e.tag ?? `release ${e.sequence}`,
        endorsedAt: e.endorsedAt ?? "",
        relation:
          !installed ? ("unrelated" as const)
          : e.commit === installed.commit ? ("current" as const)
          : e.sequence > installed.sequence ? ("newer" as const)
          : ("older" as const),
        sequence: e.sequence,
      }))
      .sort((a, b) => b.sequence - a.sequence)
      .map(({ sequence: _s, ...r }) => r);
    return {
      checkedAt: now(),
      currentCommit: installed?.commit ?? null,
      latest: releases.find((r) => r.relation === "newer") ?? null,
      releases,
      ...(fetched ? {} : { stale: true }),
    };
  }

  return {
    async get({ refresh = false } = {}) {
      if (!refresh && cached && now() - cached.checkedAt < maxAge) return cached;
      if (!inFlight) {
        inFlight = build()
          .then((c) => (cached = c))
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}
