/**
 * Fetcher: pulls the `.maintainers/` tree from a raw-content URL with
 * a 30-second extension-storage cache. Layered on injectable
 * KV-storage and fetch interfaces for testability.
 *
 * NOTE: Repo providers (github, codeberg, gitea, gitlab) do not expose
 * a uniform "list files in a directory" API on raw content. For
 * mandates and key files we therefore rely on a small index file at
 * `.maintainers/index.json` that the adopting project commits with each
 * change. If that file is missing we fall back to fetching the canonical
 * `policy.json` and the per-track `policy.json` only — the overlay
 * degrades to "no chain history available" rather than crashing.
 *
 * The index file format (versioned for forward-compat):
 *   {
 *     "version": 1,
 *     "tracks": { "<track>": ["<rel-path>", ...] },
 *     "keys":   ["<rel-path>", ...],
 *     "endorsements": ["<rel-path>", ...]
 *   }
 *
 * Paths are relative to the repo root and MUST start with
 * `.maintainers/`. We reject anything else to prevent a malicious index
 * from redirecting us off-tree.
 */
import type { Mandate, KeyFile, ReleaseEndorsement, RootPolicy, TrackPolicy } from "@maintainers/protocol";
import type { RepoLocation } from "./repo-detect.js";

export interface KVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface FetcherDeps {
  fetch: typeof fetch;
  storage: KVStore;
  now(): number;
}

export interface MaintainersData {
  policy: RootPolicy | null;
  trackPolicies: Record<string, TrackPolicy>;
  mandates: Record<string, Mandate[]>;
  keys: KeyFile[];
  endorsements: ReleaseEndorsement[];
  /** Branch we successfully fetched policy.json from. */
  branch: string | null;
  /** Errors encountered per path (for diagnostics). */
  errors: { path: string; error: string }[];
  /** ms since epoch when this snapshot was materialized. */
  fetchedAt: number;
}

export interface MaintainersIndexFile {
  version: 1;
  tracks: Record<string, string[]>;
  keys: string[];
  endorsements: string[];
}

const CACHE_TTL_MS = 30_000;

function cacheKey(repo: RepoLocation): string {
  return `maintainers:cache:${repo.host}/${repo.owner}/${repo.repo}`;
}

export async function fetchMaintainers(
  repo: RepoLocation,
  deps: FetcherDeps,
): Promise<MaintainersData> {
  const cached = await readCache(repo, deps);
  if (cached) return cached;

  const data = await fetchFresh(repo, deps);
  await writeCache(repo, data, deps);
  return data;
}

async function readCache(
  repo: RepoLocation,
  deps: FetcherDeps,
): Promise<MaintainersData | null> {
  const raw = await deps.storage.get(cacheKey(repo));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MaintainersData;
    if (deps.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(
  repo: RepoLocation,
  data: MaintainersData,
  deps: FetcherDeps,
): Promise<void> {
  await deps.storage.set(cacheKey(repo), JSON.stringify(data));
}

/** Public for tests; treats no cache as a forced refresh. */
export async function fetchFresh(
  repo: RepoLocation,
  deps: FetcherDeps,
): Promise<MaintainersData> {
  const errors: MaintainersData["errors"] = [];

  // Try each branch in order; the first one that has policy.json wins.
  let policy: RootPolicy | null = null;
  let usedBranch: string | null = null;
  for (const branch of repo.branches) {
    const result = await fetchJson<RootPolicy>(
      repo.rawUrl(".maintainers/policy.json", branch),
      deps,
    );
    if (result.ok) {
      policy = result.value;
      usedBranch = branch;
      break;
    }
  }
  if (!policy || !usedBranch) {
    return {
      policy: null,
      trackPolicies: {},
      mandates: {},
      keys: [],
      endorsements: [],
      branch: null,
      errors: [
        {
          path: ".maintainers/policy.json",
          error: "not found on any candidate branch",
        },
      ],
      fetchedAt: deps.now(),
    };
  }

  // Try to load the index. Soft-fallback if missing.
  const indexResult = await fetchJson<MaintainersIndexFile>(
    repo.rawUrl(".maintainers/index.json", usedBranch),
    deps,
  );
  const index = indexResult.ok ? sanitizeIndex(indexResult.value, errors) : null;

  // Per-track policy + mandates
  const trackPolicies: Record<string, TrackPolicy> = {};
  const mandates: Record<string, Mandate[]> = {};
  for (const track of policy.tracks) {
    const tp = await fetchJson<TrackPolicy>(
      repo.rawUrl(`.maintainers/tracks/${track}/policy.json`, usedBranch),
      deps,
    );
    if (tp.ok) trackPolicies[track] = tp.value;
    else errors.push({ path: `.maintainers/tracks/${track}/policy.json`, error: tp.error });

    const mandatePaths = index?.tracks[track] ?? [];
    const trackMandates: Mandate[] = [];
    for (const p of mandatePaths) {
      const r = await fetchJson<Mandate>(repo.rawUrl(p, usedBranch), deps);
      if (r.ok) trackMandates.push(r.value);
      else errors.push({ path: p, error: r.error });
    }
    mandates[track] = trackMandates;
  }

  // Keys + endorsements
  const keys: KeyFile[] = [];
  for (const p of index?.keys ?? []) {
    const r = await fetchJson<KeyFile>(repo.rawUrl(p, usedBranch), deps);
    if (r.ok && r.value.kind === "KeyFile") keys.push(r.value);
    else if (!r.ok) errors.push({ path: p, error: r.error });
  }

  const endorsements: ReleaseEndorsement[] = [];
  for (const p of index?.endorsements ?? []) {
    const r = await fetchJson<ReleaseEndorsement>(repo.rawUrl(p, usedBranch), deps);
    if (r.ok) endorsements.push(r.value);
    else errors.push({ path: p, error: r.error });
  }

  return {
    policy,
    trackPolicies,
    mandates,
    keys,
    endorsements,
    branch: usedBranch,
    errors,
    fetchedAt: deps.now(),
  };
}

function sanitizeIndex(
  raw: MaintainersIndexFile,
  errors: MaintainersData["errors"],
): MaintainersIndexFile {
  const safe: MaintainersIndexFile = { version: 1, tracks: {}, keys: [], endorsements: [] };
  if (typeof raw !== "object" || raw === null) return safe;
  if (raw.version !== 1) return safe;

  const isSafePath = (p: unknown): p is string =>
    typeof p === "string" &&
    p.startsWith(".maintainers/") &&
    !p.includes("..") &&
    !p.includes("\\");

  if (raw.tracks && typeof raw.tracks === "object") {
    for (const [track, paths] of Object.entries(raw.tracks)) {
      if (!Array.isArray(paths)) continue;
      const safePaths: string[] = [];
      for (const p of paths) {
        if (isSafePath(p)) safePaths.push(p);
        else errors.push({ path: String(p), error: "rejected: unsafe path in index.json" });
      }
      safe.tracks[track] = safePaths;
    }
  }
  if (Array.isArray(raw.keys)) {
    for (const p of raw.keys) {
      if (isSafePath(p)) safe.keys.push(p);
      else errors.push({ path: String(p), error: "rejected: unsafe key path in index.json" });
    }
  }
  if (Array.isArray(raw.endorsements)) {
    for (const p of raw.endorsements) {
      if (isSafePath(p)) safe.endorsements.push(p);
      else errors.push({ path: String(p), error: "rejected: unsafe endorsement path in index.json" });
    }
  }
  return safe;
}

type FetchJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function fetchJson<T>(url: string, deps: FetcherDeps): Promise<FetchJsonResult<T>> {
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length > 1_000_000) return { ok: false, error: "response too large" };
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
