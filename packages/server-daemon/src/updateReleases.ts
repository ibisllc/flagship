import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseEndorsement } from "@ibisllc/maintainers";
import { MAINTAINER_PINNED_MANDATE_HASH } from "@flagship/protocol";
import { verifyEndorsementChainAgainstGit, verifyMaintainersFolder, type ReleaseStatus } from "./releaseVerifier.js";
import { maintainersStatusFromRef } from "./selfUpdateReleaseGate.js";
import { outboundNet } from "./outboundProxy/outboundNet.js";

/**
 * The releases this box could move to, worked out by the box itself so the
 * owner's "Update to latest" never trusts GitHub or `.com`: after a fetch it
 * verifies the maintainer endorsements against the baked pin (the same check
 * the update gate runs before applying) and places each one relative to the
 * commit it is running. The owner still signs an order naming one exact
 * commit; "latest" is only how the phone picks which.
 */
export type ReleaseRelation = "current" | "newer" | "older" | "unrelated";

export interface ReleaseEntry {
  commit: string;
  releaseId: string;
  tag: string;
  /** ISO 8601 issue time of the endorsement. */
  endorsedAt: string;
  relation: ReleaseRelation;
}

export interface ReleaseCatalog {
  /** Unix ms of the last successful look. */
  checkedAt: number;
  currentCommit: string | null;
  /** Newest endorsed release that descends from the running commit. */
  latest: ReleaseEntry | null;
  /** Newest first. */
  releases: ReleaseEntry[];
  /** Set when the fetch failed; the list is then from the local clone. */
  stale?: boolean;
}

type Git = (args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string }>;

export interface ReleaseCatalogOptions {
  repoPath: string;
  pinnedMandateHash?: string;
  /** How long a catalog is reused before the next fetch. */
  maxAgeMs?: number;
  now?: () => number;
  git?: Git;
  statusForRef?: (ref: string) => ReleaseStatus | null;
  statusForWorktree?: () => ReleaseStatus | null;
  verifyWalk?: (e: ReleaseEndorsement) => { ok: boolean };
  onLog?: (m: string) => void;
}

export interface ReleaseCatalogSource {
  get(opts?: { refresh?: boolean }): Promise<ReleaseCatalog>;
}

const execFileP = promisify(execFile);

export function buildReleaseCatalog(opts: ReleaseCatalogOptions): ReleaseCatalogSource {
  const pin = opts.pinnedMandateHash ?? MAINTAINER_PINNED_MANDATE_HASH;
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.onLog ?? (() => {});
  const git: Git =
    opts.git ??
    (async (args, timeoutMs = 30_000) => {
      try {
        const { stdout } = await execFileP("git", ["-C", opts.repoPath, ...args], {
          env: outboundNet.childEnv(),
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { ok: true, stdout };
      } catch {
        return { ok: false, stdout: "" };
      }
    });
  const statusForRef =
    opts.statusForRef ??
    ((ref: string) => maintainersStatusFromRef({ repoPath: opts.repoPath, ref, pinnedMandateHash: pin }));
  const statusForWorktree =
    opts.statusForWorktree ??
    (() => {
      try {
        return verifyMaintainersFolder({ gitRepoPath: opts.repoPath, pinnedMandateHash: pin });
      } catch {
        return null;
      }
    });
  const verifyWalk =
    opts.verifyWalk ?? ((e: ReleaseEndorsement) => verifyEndorsementChainAgainstGit(e, opts.repoPath));

  let cached: ReleaseCatalog | null = null;
  let inFlight: Promise<ReleaseCatalog> | null = null;

  async function relationOf(commit: string, head: string | null): Promise<ReleaseRelation> {
    if (!head) return "unrelated";
    if (commit === head) return "current";
    if ((await git(["merge-base", "--is-ancestor", head, commit])).ok) return "newer";
    if ((await git(["merge-base", "--is-ancestor", commit, head])).ok) return "older";
    return "unrelated";
  }

  async function build(): Promise<ReleaseCatalog> {
    const fetched = (await git(["fetch", "--quiet", "origin"], 90_000)).ok;
    // A shallow clone can't answer ancestry past its graft; the update path
    // deepens it before applying anyway.
    const shallow = (await git(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
    if (fetched && shallow) await git(["fetch", "--quiet", "--unshallow", "origin"], 180_000);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim().toLowerCase() || null;

    const byCommit = new Map<string, ReleaseEndorsement>();
    for (const status of [statusForWorktree(), statusForRef("FETCH_HEAD"), statusForRef("origin/main")]) {
      for (const e of status?.validEndorsements ?? []) byCommit.set(e.commitHash.toLowerCase(), e);
    }

    const releases: ReleaseEntry[] = [];
    for (const [commit, e] of byCommit) {
      const relation = await relationOf(commit, head);
      // A newer release is only offered if it would pass the gate's lineage
      // walk; older ones are shown as-is under the downgrade warning.
      if (relation === "newer" && !verifyWalk(e).ok) {
        log(`[updates] skipping ${e.semverTag}: lineage walk failed`);
        continue;
      }
      releases.push({ commit, releaseId: e.releaseId, tag: e.semverTag, endorsedAt: e.issuedAt, relation });
    }
    releases.sort((a, b) => b.endorsedAt.localeCompare(a.endorsedAt));
    return {
      checkedAt: now(),
      currentCommit: head,
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
