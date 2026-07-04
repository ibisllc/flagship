import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReleaseEndorsement } from "@ibisllc/maintainers";
import {
  MAINTAINER_PINNED_MANDATE_HASH,
  maintainerPinConfigured,
} from "@flagship/protocol";
import {
  verifyEndorsementChainAgainstGit,
  verifyMaintainersFolder,
  type ReleaseStatus,
} from "./releaseVerifier.js";
import type { ReleaseGate } from "./updateClient.js";

/**
 * The AUTHENTICITY half of the 2-of-2 self-update gate
 * (docs/server-update-mechanism.md): a real `ReleaseGate` (the seam declared in
 * updateClient.ts) that confirms a target commit is maintainer-ENDORSED before
 * the update consumer will move the box's own code to it. It is INDEPENDENT of
 * the admin-authorization gate (`authorizeSensitiveOrder`) — neither alone can
 * push code.
 *
 * What "endorsed" means here (the LOCKED v2 model, all verified OFFLINE — a
 * hostile `.com` cannot poison a verdict because we never ask it anything):
 *   1. the release-track mandate chain verifies FORWARD from the baked
 *      `MAINTAINER_PINNED_MANDATE_HASH` (empty pin ⇒ EVERYTHING rejected,
 *      fail closed);
 *   2. a holder-signed `ReleaseEndorsement` whose `commitHash` IS the target
 *      commit exists in a verifiable `.maintainers/` snapshot;
 *   3. the endorsement's declared first-parent lineage matches the LOCAL git
 *      walk (`verifyEndorsementChainAgainstGit`) — the spec §5 step-4 defense
 *      against hostile-mirror commit substitution. This is why the consumer
 *      runs `git fetch` BEFORE consulting the gate: the target's objects must
 *      be local for the walk (fetch only downloads objects — nothing is
 *      checked out or executed before BOTH gates pass).
 *
 * Where the `.maintainers/` snapshot comes from: the endorsement for a NEW
 * release is typically committed AFTER the endorsed commit, so the box's
 * CURRENT checkout usually doesn't contain it yet. The gate therefore checks
 * the live worktree first and then falls back to reading `.maintainers/` out
 * of freshly-FETCHED refs (`FETCH_HEAD`, `origin/main`, …) — which is safe
 * because trust is anchored in the baked pin + the holder signatures, never in
 * which tree the folder bytes came from.
 *
 * TODO(update-packs): this is the spec's v0 posture (git-ref + on-box build).
 * v1 replaces it with maintainer-signed, hash-pinned prebuilt packs
 * (`UpdateManifest.artifactHash`) + an append-only transparency log; the gate
 * then verifies the pack hash instead of walking git. Until then this is the
 * strongest endorsement check available on-box, and it fails CLOSED on every
 * missing/ambiguous input.
 */

export interface MaintainersReleaseGateOptions {
  /** The box's own code checkout (production: /opt/flagship). */
  repoPath: string;
  /**
   * Refs whose `.maintainers/` folder is ALSO consulted when the worktree
   * snapshot doesn't carry the target's endorsement (a new release's
   * endorsement usually lands after the endorsed commit). Checked in order.
   */
  refCandidates?: string[];
  /** Baked pin override (tests). Empty string ⇒ fail closed, never a bypass. */
  pinnedMandateHash?: string;
  /** Test seam — replace the worktree `.maintainers/` read+verify. */
  statusForWorktree?: () => ReleaseStatus | null;
  /** Test seam — replace the per-ref `.maintainers/` extraction+verify. */
  statusForRef?: (ref: string) => ReleaseStatus | null;
  /** Test seam — replace the local git first-parent lineage walk. */
  verifyWalk?: (
    endorsement: ReleaseEndorsement,
  ) => { ok: true } | { ok: false; reason: string; detail?: string };
  gitBinary?: string;
  onLog?: (m: string) => void;
}

export function buildMaintainersReleaseGate(
  opts: MaintainersReleaseGateOptions,
): ReleaseGate {
  const pin = opts.pinnedMandateHash ?? MAINTAINER_PINNED_MANDATE_HASH;
  const git = opts.gitBinary ?? "git";
  const refCandidates = opts.refCandidates ?? ["FETCH_HEAD", "origin/main", "origin/HEAD"];
  const log = opts.onLog ?? (() => {});

  const statusForWorktree =
    opts.statusForWorktree ??
    ((): ReleaseStatus | null => {
      // Same read as FsReleaseStatusProvider, but honoring the pin override; a
      // busted folder yields null ⇒ "no endorsement here", never a crash.
      try {
        return verifyMaintainersFolder({
          gitRepoPath: opts.repoPath,
          pinnedMandateHash: pin,
        });
      } catch {
        return null;
      }
    });

  const statusForRef =
    opts.statusForRef ??
    ((ref: string): ReleaseStatus | null =>
      maintainersStatusFromRef({
        repoPath: opts.repoPath,
        ref,
        pinnedMandateHash: pin,
        gitBinary: git,
      }));

  const verifyWalk =
    opts.verifyWalk ??
    ((e: ReleaseEndorsement) =>
      verifyEndorsementChainAgainstGit(e, opts.repoPath, { gitBinary: git }));

  return {
    assertCommitEndorsed(commitHash: string): void {
      // Link-1 fail-closed invariant: no baked pin ⇒ no update, ever.
      if (!maintainerPinConfigured(pin)) {
        throw new Error(
          "self-update refused: maintainer pinned-mandate hash is unconfigured (fail closed)",
        );
      }
      if (typeof commitHash !== "string" || commitHash.length === 0) {
        throw new Error("self-update refused: empty target commit");
      }
      const target = commitHash.toLowerCase();

      const searched: string[] = [];
      let endorsement = findEndorsement(statusForWorktree(), target);
      searched.push("worktree");
      if (!endorsement) {
        for (const ref of refCandidates) {
          const status = statusForRef(ref);
          if (!status) continue;
          searched.push(ref);
          endorsement = findEndorsement(status, target);
          if (endorsement) break;
        }
      }
      if (!endorsement) {
        throw new Error(
          `self-update refused: commit ${commitHash} carries no valid maintainer ` +
            `release endorsement (searched .maintainers/ in: ${searched.join(", ")})`,
        );
      }

      // §5 step 4 — the endorsement's declared lineage must match OUR clone's
      // first-parent walk (post-fetch, so the objects are local). A mismatch or
      // a missing object is a hard reject, never a downgrade.
      const walk = verifyWalk(endorsement);
      if (!walk.ok) {
        throw new Error(
          `self-update refused: endorsement ${endorsement.releaseId} for ` +
            `${commitHash} failed the local git lineage walk: ${walk.reason}` +
            (walk.detail ? ` (${walk.detail})` : ""),
        );
      }
      log(
        `[self-update] commit ${commitHash} is maintainer-endorsed ` +
          `(release ${endorsement.releaseId})`,
      );
    },
  };
}

function findEndorsement(
  status: ReleaseStatus | null,
  targetLower: string,
): ReleaseEndorsement | null {
  if (!status) return null;
  for (const e of status.validEndorsements) {
    if (e.commitHash.toLowerCase() === targetLower) return e;
  }
  return null;
}

/**
 * Materialize `.maintainers/` out of a git REF (not the worktree) into a temp
 * dir and run the normal offline verifier over it. Used post-`git fetch` so a
 * brand-new release's endorsement (committed after the endorsed commit, hence
 * absent from the box's current checkout) is still verifiable. Reading from an
 * as-yet-untrusted ref is safe: the verifier anchors at the baked pin and the
 * endorsements are holder-signed — the folder bytes carry no authority of
 * their own. Returns null on ANY defect (unknown ref, no folder, fs trouble).
 */
export function maintainersStatusFromRef(args: {
  repoPath: string;
  ref: string;
  pinnedMandateHash?: string;
  gitBinary?: string;
}): ReleaseStatus | null {
  const git = args.gitBinary ?? "git";
  const run = (a: string[]): string =>
    execFileSync(git, ["-C", args.repoPath, ...a], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  let fileList: string;
  try {
    fileList = run(["ls-tree", "-r", "--name-only", args.ref, ".maintainers"]);
  } catch {
    return null;
  }
  const files = fileList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (f) =>
        f.startsWith(".maintainers/") &&
        f.endsWith(".json") &&
        // A crafted tree entry must not escape the temp dir.
        !f.split("/").some((seg) => seg === ".." || seg === "" || seg.includes("\\")),
    );
  if (files.length === 0) return null;

  let tmp: string | null = null;
  try {
    tmp = fs.mkdtempSync(join(tmpdir(), "flagship-maintainers-"));
    for (const f of files) {
      const content = run(["show", `${args.ref}:${f}`]);
      const dest = join(tmp, f);
      fs.mkdirSync(dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    return verifyMaintainersFolder({
      gitRepoPath: tmp,
      ...(args.pinnedMandateHash !== undefined
        ? { pinnedMandateHash: args.pinnedMandateHash }
        : {}),
    });
  } catch {
    return null;
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
