/**
 * Release verifier — Flagship's daemon's view of who can authorize a
 * production update of itself. **LOCKED Phase-2 v2 model** (verify
 * FORWARD from a baked pinned-Mandate hash; no policy.json).
 *
 * Why: the maintainers protocol (maintainers/docs/spec) specifies how a
 * project declares its current signing authority + the exact commits
 * that authority has endorsed. Flagship dogfoods that protocol from
 * `.maintainers/` at the repo root. This module closes the loop between
 * "Harry's YubiKey signs a release endorsement" and "Flagship's daemon
 * refuses to apply updates that aren't endorsed."
 *
 * v2 changes vs the prior implementation:
 *   - the trust anchor is the baked **pinned-Mandate canonical hash**
 *     (`MAINTAINER_PINNED_MANDATE_HASH`, #30 generalised); each track's
 *     mandate log is verified FORWARD from it
 *     (`verifyMandateChainFromPin`). There is no `policy.json` (root or
 *     track) — the succession rule is folded INTO each mandate (L2).
 *   - the empty baked pin (pre-Gate-B) ⇒ every chain fails L1 ⇒ no
 *     authority anywhere ⇒ fully fail-closed. Tests inject a non-empty
 *     pin to exercise the post-ceremony state (the maintainerCa.ts
 *     injectable-pin seam, mirrored here).
 *   - endorsements are holder-signed (`verifyChainOfEndorsementsV2`):
 *     the mandate `holder` is the operational authority.
 *
 * What this module does:
 *   - reads `.maintainers/` from disk (a local clone path)
 *   - verifies each track's v2 mandate chain offline (no .com round-trip)
 *   - verifies the release-endorsement chain against the release chain
 *   - exposes the current authority + the set of valid endorsements
 *   - given an endorsement + a local git working tree, walks
 *     `git rev-list --first-parent` and confirms the intermediate
 *     commits match exactly — the protection against hostile-mirror
 *     commit substitution
 *
 * The verifier is intentionally pure-fs + pure-git: a hostile control
 * plane cannot poison a verdict because we never ask it anything.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  currentAuthorityV2,
  verifyChainOfEndorsementsV2,
  verifyMandateChainFromPin,
  type MandateV2,
  type Pubkey,
  type ReleaseEndorsement,
  type TakeoverAlarm,
  type VerifiedChainV2,
  type VerifiedEndorsements,
} from "@maintainers/protocol";
import { MAINTAINER_PINNED_MANDATE_HASH } from "@flagship/protocol";

export type TrackName = "release" | "ca" | "ops" | string;

export interface MaintainersStoreSnapshot {
  rootDir: string;
  /** Whether `${gitRepoPath}/.maintainers/` exists with a tracks dir. */
  rootDirPresent: boolean;
  /** v2 mandates per track, filename-sorted (canonical-log substitute). */
  mandatesByTrack: Map<TrackName, MandateV2[]>;
  endorsements: ReleaseEndorsement[];
}

export interface TrackVerdict {
  track: TrackName;
  /**
   * v2: the track's mandate log anchored a root at the baked pin
   * (`chain.root !== null`). Field name kept for the BFF/mobile wire
   * mirror; the meaning is "the track has a verifiable v2 chain".
   */
  hasPolicy: boolean;
  totalMandates: number;
  validMandates: number;
  currentHolder: Pubkey | null;
  currentMandateExpiresAt: string | null;
  successors: Pubkey[];
  /**
   * The holder of the last valid mandate when no mandate's window
   * contains `now` (its successors hold standing to issue the next).
   */
  lastExpiredHolder: Pubkey | null;
  rejections: { mandateId: string; reason: string; detail?: string }[];
}

export interface ReleaseStatus {
  rootDir: string;
  /**
   * v2: whether a usable `.maintainers/` root is present on disk. Field
   * name kept for the BFF/mobile wire mirror (there is no policy.json
   * in v2 — the prior "policy.json readable" meaning is obsolete).
   */
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
  /**
   * The baked pinned-Mandate canonical hash (#30 generalised L1
   * anchor). Defaults to `@flagship/protocol`'s
   * `MAINTAINER_PINNED_MANDATE_HASH` (EMPTY until Gate B ⇒ fail-closed).
   * Overridable so tests can exercise the post-ceremony configured path.
   */
  pinnedMandateHash?: string;
}

/**
 * Read + verify the maintainers folder at `${gitRepoPath}/.maintainers/`.
 * Returns a JSON-serializable verdict suitable for the daemon's BFF
 * and update gate.
 */
export function verifyMaintainersFolder(opts: ReleaseVerifierOptions): ReleaseStatus {
  const rootDir = path.join(opts.gitRepoPath, ".maintainers");
  const now = opts.now ?? new Date();
  const pin = opts.pinnedMandateHash ?? MAINTAINER_PINNED_MANDATE_HASH;
  const store = readStoreFromDisk(rootDir);
  return verifyStore(store, now, pin);
}

/**
 * Verify one named track from `${gitRepoPath}/.maintainers/` and hand
 * back its v2 forward-verified chain. This is the disk→verified bridge
 * link-4 needs: `caTrustChain.makeCaTrustChain` feeds the "ca"-track
 * chain into `authorizedCaKeysV2`. `null` when the track has no v2
 * mandates on disk (⇒ the chain yields no keys ⇒ the #30 chokepoint
 * fail-closes). The pin is applied here: an empty/forked pin yields a
 * chain with `validMandates: []` (fail-closed), not null.
 */
export function verifiedTrackFromFolder(
  opts: ReleaseVerifierOptions,
  trackName: TrackName,
): { chain: VerifiedChainV2 } | null {
  const rootDir = path.join(opts.gitRepoPath, ".maintainers");
  const pin = opts.pinnedMandateHash ?? MAINTAINER_PINNED_MANDATE_HASH;
  const store = readStoreFromDisk(rootDir);
  const mandates = store.mandatesByTrack.get(trackName);
  if (!mandates || mandates.length === 0) return null;
  return { chain: verifyMandateChainFromPin(pin, mandates) };
}

/**
 * Walk the local git repo's first-parent chain backward from
 * `endorsement.commitHash` and confirm that the visited commits are
 * exactly `endorsement.intermediateCommits` in the documented order,
 * landing at `endorsement.previousCommitHash` (or with no predecessor
 * for a genesis endorsement).
 *
 * Spec §5 step 4. This is what stops a hostile mirror from substituting
 * commits between two known-good endorsements. Unchanged by v2 (the
 * ReleaseEndorsement envelope + git-walk are identical).
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

function verifyStore(
  store: MaintainersStoreSnapshot,
  now: Date,
  pin: string,
): ReleaseStatus {
  const tracks: TrackVerdict[] = [];
  const chainsByTrack = new Map<TrackName, VerifiedChainV2>();

  for (const [name, mandates] of store.mandatesByTrack.entries()) {
    const chain = verifyMandateChainFromPin(pin, mandates);
    chainsByTrack.set(name, chain);
    const auth = currentAuthorityV2(chain, now);
    const lastValid = chain.validMandates[chain.validMandates.length - 1];

    const rejections: TrackVerdict["rejections"] = [];
    // Surface the L1 fail-closed cause (no-pin / pin-not-in-log / a
    // malformed root) so diagnosis is possible — it is WHY there is no
    // authority, not a per-mandate rejection.
    if (chain.rootError) {
      rejections.push({ mandateId: "(root)", reason: chain.rootError });
    }
    for (const r of chain.rejections) {
      rejections.push({
        mandateId: r.mandate.mandateId,
        reason: r.reason,
        detail: r.detail,
      });
    }

    tracks.push({
      track: name,
      hasPolicy: chain.root !== null,
      totalMandates: mandates.length,
      validMandates: chain.validMandates.length,
      currentHolder: auth?.holder ?? null,
      currentMandateExpiresAt: auth?.mandate.expiresAt ?? null,
      successors: auth ? auth.successors : (lastValid?.successors ?? []),
      lastExpiredHolder: !auth ? (lastValid?.holder ?? null) : null,
      rejections,
    });
  }

  let validEndorsements: ReleaseEndorsement[] = [];
  let endorsementErrors: ReleaseStatus["endorsementErrors"] = [];
  if (store.endorsements.length > 0) {
    const releaseChain = chainsByTrack.get("release");
    if (!releaseChain || releaseChain.validMandates.length === 0) {
      endorsementErrors = store.endorsements.map((e) => ({
        releaseId: e.releaseId,
        reason: "no-release-track-authority",
        detail: "endorsements present but no verifiable release-track v2 chain",
      }));
    } else {
      const result: VerifiedEndorsements = verifyChainOfEndorsementsV2(
        store.endorsements,
        releaseChain,
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

  const pendingTakeoverAlarm = deriveTakeoverAlarm(
    chainsByTrack.get("release"),
    store,
  );

  return {
    rootDir: store.rootDir,
    rootPolicyPresent: store.rootDirPresent,
    tracks,
    currentRelease,
    validEndorsements,
    endorsementErrors,
    pendingTakeoverAlarm,
  };
}

/**
 * Mirror of the cli's lib/store.ts `readMandatesV2` but inlined here so
 * the daemon doesn't take a dep on the cli (which isn't published and
 * would drag yargs etc. for ~100 lines of JSON I/O). v2 on-disk
 * convention: `tracks/<track>/mandates/*.json`, filename-sorted as the
 * canonical-log substitute, filtered to `version === 2`. No policy.json.
 */
function readStoreFromDisk(rootDir: string): MaintainersStoreSnapshot {
  const out: MaintainersStoreSnapshot = {
    rootDir,
    rootDirPresent: false,
    mandatesByTrack: new Map(),
    endorsements: [],
  };
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return out;
  }
  const tracksDir = path.join(rootDir, "tracks");
  if (fs.existsSync(tracksDir) && fs.statSync(tracksDir).isDirectory()) {
    out.rootDirPresent = true;
    for (const name of fs.readdirSync(tracksDir).sort()) {
      const trackDir = path.join(tracksDir, name);
      if (!fs.statSync(trackDir).isDirectory()) continue;
      const mandatesDir = path.join(trackDir, "mandates");
      const arr: MandateV2[] = [];
      if (fs.existsSync(mandatesDir) && fs.statSync(mandatesDir).isDirectory()) {
        for (const f of fs.readdirSync(mandatesDir).sort()) {
          if (!f.endsWith(".json")) continue;
          const parsed = readJson(path.join(mandatesDir, f));
          if (isMandateV2(parsed)) arr.push(parsed);
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
  releaseChain: VerifiedChainV2 | undefined,
  store: MaintainersStoreSnapshot,
): TakeoverAlarm | null {
  if (!releaseChain) return null;
  const vm = releaseChain.validMandates;
  if (vm.length < 2) return null;
  const newest = vm[vm.length - 1]!;
  const prior = vm[vm.length - 2]!;
  // Takeover = newest mandate signedBy is NOT the prior holder, and
  // newest.issuedAt >= prior.expiresAt (a successor took over rather
  // than the holder renewing in-window).
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

function isMandateV2(x: unknown): x is MandateV2 {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.kind === "Mandate" &&
    o.version === 2 &&
    typeof o.mandateId === "string" &&
    typeof o.track === "string" &&
    typeof o.holder === "string" &&
    typeof o.issuedAt === "string" &&
    typeof o.expiresAt === "string" &&
    Array.isArray(o.successors) &&
    typeof o.approvalRule === "object" &&
    o.approvalRule !== null &&
    typeof o.minSuccessors === "number" &&
    typeof o.maxDurationSeconds === "number" &&
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
