/**
 * GET /api/releases?current=<commit> — the endorsed releases, placed relative
 * to a box's running commit, in the same shape a box's own
 * /api/screens/updates returns.
 *
 * A box lists and verifies its releases itself (updateReleases.ts); this is
 * for boxes from before that existed, which answer 404 and would otherwise
 * never show an update. Trusting it costs nothing: it only decides what the
 * phone offers, and the box applies an order only after checking the target's
 * maintainer endorsement and lineage on its own.
 *
 * Newer/older comes from the endorsements themselves: each names the release
 * before it and every first-parent commit between, so together they spell out
 * main's history since the first release. A box commit off that history is
 * "unrelated" and offered nothing.
 *
 * Once the release PQ pin names a key (`RELEASE_PQ_PIN`, docs/architecture-v2/pq-suites.md §12)
 * a release is offered only when its v1 signature AND its hybrid companion under the pinned,
 * bound key verify here; the rest still place commits in the lineage but are not offered.
 */
import {
  classifyReleaseEndorsements,
  RELEASE_PQ_PIN,
  releasePqPinConfigured,
  type ReleasePqPin,
} from "@flagship/protocol";
import type { ReleaseEndorsement } from "@ibisllc/maintainers";

const REPO = "ibisllc/flagship";
const ENDORSEMENTS_DIR = ".maintainers/endorsements";
const PQ_ENDORSEMENTS_DIR = ".maintainers/release-pq/endorsements";
const PQ_BINDINGS_DIR = ".maintainers/release-pq/bindings";
const CACHE_SECONDS = 300;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export const RELEASES_PATH = "/api/releases";

export interface EndorsementSummary {
  releaseId: string;
  semverTag: string;
  commitHash: string;
  previousCommitHash: string | null;
  intermediateCommits: string[];
  issuedAt: string;
  /** False when the PQ pin is set and this release lacks a verified companion: lineage only. */
  eligible?: boolean;
}

export type ReleaseRelation = "current" | "newer" | "older" | "unrelated";

export interface ReleaseEntry {
  commit: string;
  releaseId: string;
  tag: string;
  endorsedAt: string;
  relation: ReleaseRelation;
}

export interface ReleaseCatalog {
  checkedAt: number;
  currentCommit: string | null;
  latest: ReleaseEntry | null;
  releases: ReleaseEntry[];
  /** Listed by flagshipserver.com, not verified by the box. */
  source: "flagship";
}

function summarize(raw: unknown): EndorsementSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.kind !== "ReleaseEndorsement") return null;
  const commit = typeof e.commitHash === "string" ? e.commitHash.toLowerCase() : "";
  if (!COMMIT_RE.test(commit) || typeof e.releaseId !== "string" || typeof e.semverTag !== "string") return null;
  if (typeof e.issuedAt !== "string") return null;
  const prev = typeof e.previousCommitHash === "string" ? e.previousCommitHash.toLowerCase() : null;
  const between = Array.isArray(e.intermediateCommits)
    ? e.intermediateCommits.filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase())
    : [];
  return {
    releaseId: e.releaseId,
    semverTag: e.semverTag,
    commitHash: commit,
    previousCommitHash: prev,
    intermediateCommits: between,
    issuedAt: e.issuedAt,
  };
}

/** main's first-parent order, oldest first, as far as the endorsements say. */
function lineage(endorsements: EndorsementSummary[]): Map<string, number> {
  const byCommit = new Map(endorsements.map((e) => [e.commitHash, e]));
  const roots = endorsements.filter((e) => !e.previousCommitHash || !byCommit.has(e.previousCommitHash));
  const next = new Map<string, EndorsementSummary>();
  for (const e of endorsements) if (e.previousCommitHash) next.set(e.previousCommitHash, e);
  const order = new Map<string, number>();
  if (roots.length !== 1) return order;
  let e: EndorsementSummary | undefined = roots[0];
  while (e) {
    for (const c of [...e.intermediateCommits, e.commitHash]) if (!order.has(c)) order.set(c, order.size);
    e = next.get(e.commitHash);
  }
  return order;
}

export function catalogFor(
  endorsements: EndorsementSummary[],
  current: string | null,
  now: number,
): ReleaseCatalog {
  const order = lineage(endorsements);
  const at = current ? order.get(current) : undefined;
  const releases: ReleaseEntry[] = endorsements
    .filter((e) => e.eligible !== false)
    .map((e) => {
      const pos = order.get(e.commitHash);
      const relation: ReleaseRelation =
        at === undefined || pos === undefined
          ? "unrelated"
          : pos === at
            ? "current"
            : pos > at
              ? "newer"
              : "older";
      return { commit: e.commitHash, releaseId: e.releaseId, tag: e.semverTag, endorsedAt: e.issuedAt, relation };
    })
    .sort((a, b) => b.endorsedAt.localeCompare(a.endorsedAt));
  return {
    checkedAt: now,
    currentCommit: current,
    latest: releases.find((r) => r.relation === "newer") ?? null,
    releases,
    source: "flagship",
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Every `*.json` in one folder of main, parsed (null for a file that failed). */
async function listJson(fetchImpl: FetchLike, dir: string, token?: string, missingOk = false): Promise<unknown[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "flagship-com",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/contents/${dir}?ref=main`, { headers });
  if (missingOk && res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const listing = (await res.json()) as Array<{ name?: unknown; download_url?: unknown }>;
  const files = listing.filter(
    (f): f is { name: string; download_url: string } =>
      typeof f.name === "string" && f.name.endsWith(".json") && typeof f.download_url === "string",
  );
  return Promise.all(
    files.map(async (f) => {
      const r = await fetchImpl(f.download_url, { headers: { "user-agent": "flagship-com" } });
      return r.ok ? await r.json().catch(() => null) : null;
    }),
  );
}

/** Every endorsement on main, read from the public repo, marked by the PQ rule. */
export async function loadEndorsements(
  fetchImpl: FetchLike,
  token?: string,
  opts: { pin?: ReleasePqPin; now?: number } = {},
): Promise<EndorsementSummary[]> {
  const raws = await listJson(fetchImpl, ENDORSEMENTS_DIR, token);
  const out: EndorsementSummary[] = [];
  const full = new Map<string, unknown>();
  for (const raw of raws) {
    const s = summarize(raw);
    if (!s) continue;
    out.push(s);
    full.set(s.releaseId, raw);
  }
  const pin = opts.pin ?? RELEASE_PQ_PIN;
  if (!releasePqPinConfigured(pin)) return out;
  const [companions, bindings] = await Promise.all([
    listJson(fetchImpl, PQ_ENDORSEMENTS_DIR, token, true),
    listJson(fetchImpl, PQ_BINDINGS_DIR, token, true),
  ]);
  const ordered = [...out].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt)).map((s) => full.get(s.releaseId) as ReleaseEndorsement);
  const { eligible } = classifyReleaseEndorsements(ordered, companions, bindings, { pin, now: opts.now ?? Date.now() });
  const ok = new Set(eligible.map((e) => e.releaseId));
  return out.map((s) => ({ ...s, eligible: ok.has(s.releaseId) }));
}

export async function handleReleases(
  url: URL,
  deps: { fetch: FetchLike; token?: string; now?: () => number; cache?: Cache; releasePqPin?: ReleasePqPin },
): Promise<Response> {
  const json = (body: unknown, status = 200, maxAge = 0) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      },
    });
  const raw = (url.searchParams.get("current") ?? "").trim().toLowerCase();
  if (raw && !COMMIT_RE.test(raw)) return json({ error: "current must be a full 40-hex commit" }, 400);
  const fresh = url.searchParams.get("refresh") === "1";

  // One cached listing serves every box, whatever commit it runs.
  const cacheKey = `https://flagshipserver.com${RELEASES_PATH}/endorsements-v2`;
  let endorsements: EndorsementSummary[] | null = null;
  if (!fresh && deps.cache) {
    const hit = await deps.cache.match(cacheKey).catch(() => undefined);
    if (hit) endorsements = (await hit.json().catch(() => null)) as EndorsementSummary[] | null;
  }
  if (!endorsements) {
    try {
      endorsements = await loadEndorsements(deps.fetch, deps.token, {
        ...(deps.releasePqPin ? { pin: deps.releasePqPin } : {}),
        now: (deps.now ?? Date.now)(),
      });
    } catch (e) {
      return json({ error: `couldn't list releases: ${(e as Error).message}` }, 502);
    }
    await deps.cache
      ?.put(
        cacheKey,
        new Response(JSON.stringify(endorsements), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
        }),
      )
      .catch(() => {});
  }
  return json(catalogFor(endorsements, raw || null, (deps.now ?? Date.now)()), 200, 60);
}
