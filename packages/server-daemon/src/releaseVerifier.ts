/**
 * Release verifier — Flagship's daemon's view of who can authorize a
 * production update of itself.
 *
 * Why: the maintainers protocol (see maintainers/docs/spec/v1.md)
 * specifies how a project declares its current signing authority + the
 * exact commits the authority has endorsed. Flagship dogfoods that
 * protocol from .maintainers/ at the repo root. This module is the
 * keystone that closes the loop between "Harry's Yubikey signs a
 * release manifest in the maintainers UI" and "Flagship's daemon
 * refuses to apply updates that aren't endorsed."
 *
 * What this module does:
 *   - reads .maintainers/ from disk (a local clone path)
 *   - verifies each track's mandate chain offline (no .com round-trip)
 *   - verifies the release-endorsement chain against the release track
 *   - exposes the current authority + the set of valid endorsements
 *   - given an endorsement + a local git working tree, walks
 *     `git rev-list --first-parent` and confirms the intermediate
 *     commits match exactly — the protection against hostile-mirror
 *     commit substitution
 *
 * The verifier is intentionally pure-fs + pure-git: a hostile control
 * plane cannot poison a verdict because we never ask it anything. The
 * webapp + phone-app surface the cached result via a BFF endpoint, but
 * that's a render path — the verdict itself is local.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  currentAuthority,
  lastExpiredMandate,
  verifyChainOfEndorsements,
  verifyTrack,
  type Mandate,
  type Pubkey,
  type ReleaseEndorsement,
  type RootPolicy,
  type TakeoverAlarm,
  type TrackPolicy,
  type VerifiedEndorsements,
  type VerifiedTrack,
} from "@maintainers/protocol";

export type TrackName = "release" | "ca" | "ops" | string;

export interface MaintainersStoreSnapshot {
  rootDir: string;
  rootPolicy: RootPolicy | null;
  trackPolicies: Map<TrackName, TrackPolicy>;
  mandatesByTrack: Map<TrackName, Mandate[]>;
  endorsements: ReleaseEndorsement[];
}

export interface TrackVerdict {
  track: TrackName;
  hasPolicy: boolean;
  totalMandates: number;
  validMandates: number;
  currentHolder: Pubkey | null;
  currentMandateExpiresAt: string | null;
  successors: Pubkey[];
  /**
   * The most-recently-expired mandate, only populated when the track
   * is in "expired pending succession" state (i.e. currentHolder is
   * null). Listed successors of this mandate are the ones with
   * standing to take over.
   */
  lastExpiredHolder: Pubkey | null;
  rejections: { mandateId: string; reason: string; detail?: string }[];
}

export interface ReleaseStatus {
  rootDir: string;
  rootPolicyPresent: boolean;
  tracks: TrackVerdict[];
  /** Most recent VALID endorsement, in canonical-log order. */
  currentRelease: ReleaseEndorsement | null;
  validEndorsements: ReleaseEndorsement[];
  endorsementErrors: { releaseId: string; reason: string; detail?: string }[];
  /**
   * Derived (not signed). Surfaces a successor-takeover transition for
   * webapp/phone UI when the most recent valid release-track mandate
   * was signed by a successor rather than by the prior holder.
   */
  pendingTakeoverAlarm: TakeoverAlarm | null;
}

export interface ReleaseVerifierOptions {
  /** Absolute path to a directory that contains `.maintainers/`. */
  gitRepoPath: string;
  /** Treat now as `at` instead of the wall clock — useful in tests. */
  now?: Date;
}

/**
 * Read + verify the maintainers folder at `${gitRepoPath}/.maintainers/`.
 * Returns a JSON-serializable verdict suitable for the daemon's BFF
 * and update gate.
 */
export function verifyMaintainersFolder(opts: ReleaseVerifierOptions): ReleaseStatus {
  const rootDir = path.join(opts.gitRepoPath, ".maintainers");
  const now = opts.now ?? new Date();
  const store = readStoreFromDisk(rootDir);
  return verifyStore(store, now);
}

/**
 * Verify one named track from `${gitRepoPath}/.maintainers/` and hand
 * back the `VerifiedTrack` + its policy. This is the disk→verified
 * bridge link-4 needs: `caTrustChain.makeCaTrustChain` feeds the
 * "ca"-track result (and `policy.approvalRule`) into
 * `@maintainers/protocol`'s `authorizedCaKeys`. `null` when the track
 * has no policy/mandates on disk (⇒ the chain yields no keys ⇒ the
 * #30 chokepoint fail-closes). Clock-free on purpose: `verifyTrack`
 * checks the mandate chain structurally; the `now` gate is applied by
 * `currentAuthority`/`authorizedCaKeys` at the consumer.
 */
export function verifiedTrackFromFolder(
  opts: ReleaseVerifierOptions,
  trackName: TrackName,
): { track: VerifiedTrack; policy: TrackPolicy } | null {
  const rootDir = path.join(opts.gitRepoPath, ".maintainers");
  const store = readStoreFromDisk(rootDir);
  const policy = store.trackPolicies.get(trackName);
  const mandates = store.mandatesByTrack.get(trackName);
  if (!policy || !mandates) return null;
  return { track: verifyTrack(trackName, policy, mandates), policy };
}

/**
 * Walk the local git repo's first-parent chain backward from
 * `endorsement.commitHash` and confirm that the visited commits are
 * exactly `endorsement.intermediateCommits` in the documented order,
 * landing at `endorsement.previousCommitHash` (or with no predecessor
 * for a genesis endorsement).
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` with a
 * brief failure description suitable for logs.
 *
 * Spec §5 step 4. This is what stops a hostile mirror from
 * substituting commits between two known-good endorsements.
 */
export function verifyEndorsementChainAgainstGit(
  endorsement: ReleaseEndorsement,
  gitRepoPath: string,
  opts?: { gitBinary?: string },
): { ok: true } | { ok: false; reason: string; detail?: string } {
  const git = opts?.gitBinary ?? "git";
  const runGit = (args: string[]): string => {
    return execFileSync(git, ["-C", gitRepoPath, ...args], { encoding: "utf8" });
  };

  // Confirm every intermediate exists locally.
  for (const c of endorsement.intermediateCommits) {
    try {
      runGit(["cat-file", "-e", c]);
    } catch {
      return {
        ok: false,
        reason: "intermediate-missing-locally",
        detail: `commit ${c} not present in local clone`,
      };
    }
  }
  try {
    runGit(["cat-file", "-e", endorsement.commitHash]);
  } catch {
    return {
      ok: false,
      reason: "head-commit-missing-locally",
      detail: `endorsement.commitHash ${endorsement.commitHash} not present locally`,
    };
  }

  // Walk first-parent from commitHash backward; collect either to the
  // previous endorsement's commit (exclusive) for non-genesis, or to
  // the root for genesis.
  //
  // Per spec §3.5: intermediateCommits is ordered oldest-first; the
  // first-parent walk from commitHash backward visits newest-first; so
  // we walk and reverse.
  const range = endorsement.previousCommitHash
    ? `${endorsement.previousCommitHash}..${endorsement.commitHash}`
    : endorsement.commitHash;
  let raw: string;
  try {
    raw = runGit(["rev-list", "--first-parent", "--reverse", range]);
  } catch (err) {
    return {
      ok: false,
      reason: "rev-list-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const walk = raw
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);

  if (walk.length !== endorsement.intermediateCommits.length) {
    return {
      ok: false,
      reason: "intermediate-count-mismatch",
      detail: `git walk visited ${walk.length} commits but endorsement carries ${endorsement.intermediateCommits.length}`,
    };
  }
  for (let i = 0; i < walk.length; i++) {
    if (walk[i] !== endorsement.intermediateCommits[i]?.toLowerCase()) {
      return {
        ok: false,
        reason: "intermediate-order-mismatch",
        detail: `at index ${i}: git walk has ${walk[i]} but endorsement has ${endorsement.intermediateCommits[i]}`,
      };
    }
  }
  return { ok: true };
}

// ---- internal -----------------------------------------------------------

function verifyStore(store: MaintainersStoreSnapshot, now: Date): ReleaseStatus {
  const tracks: TrackVerdict[] = [];
  const verifiedTracks = new Map<TrackName, { track: VerifiedTrack; policy: TrackPolicy }>();

  for (const [name, mandates] of store.mandatesByTrack.entries()) {
    const policy = store.trackPolicies.get(name);
    if (!policy) {
      tracks.push({
        track: name,
        hasPolicy: false,
        totalMandates: mandates.length,
        validMandates: 0,
        currentHolder: null,
        currentMandateExpiresAt: null,
        successors: [],
        lastExpiredHolder: null,
        rejections: [],
      });
      continue;
    }
    const verified = verifyTrack(name, policy, mandates);
    verifiedTracks.set(name, { track: verified, policy });
    const auth = currentAuthority(verified, now);
    const expired = lastExpiredMandate(verified, now);
    tracks.push({
      track: name,
      hasPolicy: true,
      totalMandates: mandates.length,
      validMandates: verified.validMandates.length,
      currentHolder: auth?.holder ?? null,
      currentMandateExpiresAt: auth?.mandate.expiresAt ?? null,
      successors: auth ? auth.successors : (expired?.successors ?? []),
      lastExpiredHolder: !auth && expired ? expired.holder : null,
      rejections: verified.rejections.map((r) => ({
        mandateId: r.mandate.mandateId,
        reason: r.reason,
        detail: r.detail,
      })),
    });
  }

  let validEndorsements: ReleaseEndorsement[] = [];
  let endorsementErrors: ReleaseStatus["endorsementErrors"] = [];
  if (store.endorsements.length > 0) {
    const releaseTrack = verifiedTracks.get("release");
    if (!releaseTrack) {
      endorsementErrors = store.endorsements.map((e) => ({
        releaseId: e.releaseId,
        reason: "no-release-track-policy",
        detail: "endorsements present but no tracks/release/policy.json",
      }));
    } else {
      const result: VerifiedEndorsements = verifyChainOfEndorsements(
        store.endorsements,
        releaseTrack.track,
        releaseTrack.policy.approvalRule,
      );
      validEndorsements = result.validEndorsements;
      endorsementErrors = result.rejections.map((r) => ({
        releaseId: r.endorsement.releaseId,
        reason: r.reason,
        detail: r.detail,
      }));
    }
  }

  const currentRelease =
    validEndorsements.length > 0
      ? validEndorsements[validEndorsements.length - 1] ?? null
      : null;

  const pendingTakeoverAlarm = deriveTakeoverAlarm(verifiedTracks.get("release")?.track, store);

  return {
    rootDir: store.rootDir,
    rootPolicyPresent: store.rootPolicy !== null,
    tracks,
    currentRelease,
    validEndorsements,
    endorsementErrors,
    pendingTakeoverAlarm,
  };
}

/**
 * Mirror of the cli's lib/store.ts but inlined here so the daemon
 * doesn't take a dep on the cli. The cli isn't published; reusing the
 * file would force flagship to ingest the whole cli subtree's
 * dependencies (yargs etc.) for ~100 lines of JSON I/O.
 */
function readStoreFromDisk(rootDir: string): MaintainersStoreSnapshot {
  const out: MaintainersStoreSnapshot = {
    rootDir,
    rootPolicy: null,
    trackPolicies: new Map(),
    mandatesByTrack: new Map(),
    endorsements: [],
  };
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return out;
  }
  const rootPolicyPath = path.join(rootDir, "policy.json");
  if (fs.existsSync(rootPolicyPath)) {
    out.rootPolicy = readJson(rootPolicyPath) as RootPolicy;
  }
  const tracksDir = path.join(rootDir, "tracks");
  if (fs.existsSync(tracksDir) && fs.statSync(tracksDir).isDirectory()) {
    for (const name of fs.readdirSync(tracksDir).sort()) {
      const trackDir = path.join(tracksDir, name);
      if (!fs.statSync(trackDir).isDirectory()) continue;
      const policyPath = path.join(trackDir, "policy.json");
      if (fs.existsSync(policyPath)) {
        out.trackPolicies.set(name, readJson(policyPath) as TrackPolicy);
      }
      const mandatesDir = path.join(trackDir, "mandates");
      const arr: Mandate[] = [];
      if (fs.existsSync(mandatesDir) && fs.statSync(mandatesDir).isDirectory()) {
        for (const f of fs.readdirSync(mandatesDir).sort()) {
          if (!f.endsWith(".json")) continue;
          const parsed = readJson(path.join(mandatesDir, f));
          if (isMandate(parsed)) arr.push(parsed);
        }
      }
      out.mandatesByTrack.set(name, arr);
    }
  }
  const endorsementsDir = path.join(rootDir, "endorsements");
  if (fs.existsSync(endorsementsDir) && fs.statSync(endorsementsDir).isDirectory()) {
    for (const f of fs.readdirSync(endorsementsDir).sort()) {
      if (!f.endsWith(".json")) continue;
      const parsed = readJson(path.join(endorsementsDir, f));
      if (isReleaseEndorsement(parsed)) out.endorsements.push(parsed);
    }
    out.endorsements.sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  }
  return out;
}

function deriveTakeoverAlarm(
  releaseTrack: VerifiedTrack | undefined,
  store: MaintainersStoreSnapshot,
): TakeoverAlarm | null {
  if (!releaseTrack) return null;
  const vm = releaseTrack.validMandates;
  if (vm.length < 2) return null;
  const newest = vm[vm.length - 1]!;
  const prior = vm[vm.length - 2]!;
  // Takeover = newest mandate signedBy is NOT the prior holder, and
  // newest.issuedAt >= prior.expiresAt (succession path).
  const newestIssuedAt = Date.parse(newest.issuedAt);
  const priorExpiry = Date.parse(prior.expiresAt);
  if (newest.signedBy === prior.holder) return null;
  if (newestIssuedAt < priorExpiry) return null;
  return {
    kind: "TakeoverAlarm",
    project: "Flagship",
    track: "release",
    previousMandate: prior.mandateId,
    newMandate: newest.mandateId,
    previousHolder: lookupHolderForUi(prior.holder, store),
    newHolder: lookupHolderForUi(newest.holder, store),
    detectedAt: new Date().toISOString(),
  };
}

function lookupHolderForUi(
  pubkey: Pubkey,
  store: MaintainersStoreSnapshot,
): TakeoverAlarm["previousHolder"] {
  const keysDir = path.join(store.rootDir, "keys");
  if (fs.existsSync(keysDir) && fs.statSync(keysDir).isDirectory()) {
    for (const f of fs.readdirSync(keysDir)) {
      if (!f.endsWith(".json")) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = readJson(path.join(keysDir, f)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        parsed.kind === "KeyFile" &&
        typeof parsed.pubkey === "string" &&
        parsed.pubkey === pubkey
      ) {
        return {
          displayName: typeof parsed.displayName === "string" ? parsed.displayName : pubkey,
          email: typeof parsed.currentEmail === "string" ? parsed.currentEmail : "",
          pubkey,
        };
      }
    }
  }
  return { displayName: pubkey, email: "", pubkey };
}

function readJson(p: string): unknown {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function isMandate(x: unknown): x is Mandate {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.kind === "Mandate" &&
    o.version === 1 &&
    typeof o.mandateId === "string" &&
    typeof o.track === "string" &&
    typeof o.holder === "string" &&
    typeof o.issuedAt === "string" &&
    typeof o.expiresAt === "string" &&
    Array.isArray(o.successors) &&
    typeof o.signedBy === "string" &&
    Array.isArray(o.signatures)
  );
}

function isReleaseEndorsement(x: unknown): x is ReleaseEndorsement {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.kind === "ReleaseEndorsement" &&
    o.version === 1 &&
    typeof o.releaseId === "string" &&
    typeof o.commitHash === "string" &&
    typeof o.intermediateMerkleRoot === "string" &&
    typeof o.issuedAt === "string" &&
    Array.isArray(o.signatures) &&
    Array.isArray(o.intermediateCommits)
  );
}
