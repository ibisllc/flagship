/**
 * `maintainers verify` — read .maintainers/ and verify everything.
 * `maintainers status` — read .maintainers/ and print a summary (no exit on partial failure).
 *
 * Both walk the same code path; the difference is verify exits non-zero on
 * any failure, while status reports the same data without failing.
 */

import {
  currentAuthority,
  lastExpiredMandate,
  verifyChainOfEndorsements,
  verifyTrack,
  type TrackPolicy,
  type VerifiedEndorsements,
  type VerifiedTrack,
} from "@maintainers/protocol";
import { CliError, type ParsedArgs, optionalFlag } from "../lib/args.js";
import { readStore } from "../lib/store.js";

export interface VerifyReport {
  rootDir: string;
  rootPolicyPresent: boolean;
  tracks: TrackReport[];
  endorsementsTotal: number;
  endorsementsValid: number;
  endorsementsRejected: number;
  endorsementErrors: { detail?: string; reason: string; releaseId: string }[];
}

export interface TrackReport {
  track: string;
  hasPolicy: boolean;
  totalMandates: number;
  validMandates: number;
  rejections: { mandateId: string; reason: string; detail?: string }[];
  currentHolder: string | null;
  currentMandateExpiresAt: string | null;
  msUntilExpiry: number | null;
  successors: string[];
  lastExpiredHolder: string | null;
}

export function buildReport(rootDir: string, now: Date): VerifyReport {
  const store = readStore(rootDir);
  const tracks: TrackReport[] = [];
  let endorsementsTotal = 0;
  let endorsementsValid = 0;
  let endorsementsRejected = 0;
  const endorsementErrors: VerifyReport["endorsementErrors"] = [];

  const verifiedTracks = new Map<string, { track: VerifiedTrack; policy: TrackPolicy }>();

  for (const [name, mandates] of store.mandatesByTrack.entries()) {
    const policy = store.trackPolicies.get(name);
    if (!policy) {
      tracks.push({
        track: name,
        hasPolicy: false,
        totalMandates: mandates.length,
        validMandates: 0,
        rejections: [],
        currentHolder: null,
        currentMandateExpiresAt: null,
        msUntilExpiry: null,
        successors: [],
        lastExpiredHolder: null,
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
      rejections: verified.rejections.map((r) => ({
        mandateId: r.mandate.mandateId,
        reason: r.reason,
        detail: r.detail,
      })),
      currentHolder: auth ? auth.holder : null,
      currentMandateExpiresAt: auth ? auth.mandate.expiresAt : null,
      msUntilExpiry: auth ? Date.parse(auth.mandate.expiresAt) - now.getTime() : null,
      successors: auth ? auth.successors : (expired ? expired.successors : []),
      lastExpiredHolder: expired && !auth ? expired.holder : null,
    });
  }

  // Endorsements verify against the release track if present.
  if (store.endorsements.length > 0) {
    const releaseTrack = verifiedTracks.get("release");
    if (!releaseTrack) {
      endorsementsTotal = store.endorsements.length;
      endorsementsRejected = store.endorsements.length;
      for (const e of store.endorsements) {
        endorsementErrors.push({
          releaseId: e.releaseId,
          reason: "no-release-track-policy",
          detail: "endorsements present but no tracks/release/policy.json",
        });
      }
    } else {
      const result: VerifiedEndorsements = verifyChainOfEndorsements(
        store.endorsements,
        releaseTrack.track,
        releaseTrack.policy.approvalRule,
      );
      endorsementsTotal = result.endorsements.length;
      endorsementsValid = result.validEndorsements.length;
      endorsementsRejected = result.rejections.length;
      for (const r of result.rejections) {
        endorsementErrors.push({
          releaseId: r.endorsement.releaseId,
          reason: r.reason,
          detail: r.detail,
        });
      }
    }
  }

  return {
    rootDir,
    rootPolicyPresent: store.rootPolicy !== null,
    tracks,
    endorsementsTotal,
    endorsementsValid,
    endorsementsRejected,
    endorsementErrors,
  };
}

export interface VerifyCmdEnv {
  now: () => Date;
  println: (line: string) => void;
}

export function runVerify(args: ParsedArgs, env: VerifyCmdEnv): number {
  const rootDir = optionalFlag(args, "path") ?? ".maintainers";
  const asOfFlag = optionalFlag(args, "as-of");
  const now = parseAsOf(asOfFlag, env.now());
  const report = buildReport(rootDir, now);
  printReport(report, env.println);
  let ok = true;
  for (const t of report.tracks) {
    if (!t.hasPolicy) {
      env.println(`error: track "${t.track}" has mandates but no policy.json`);
      ok = false;
    }
    if (t.rejections.length > 0) ok = false;
  }
  if (report.endorsementsRejected > 0) ok = false;
  if (!ok) {
    env.println("verify: FAIL");
    return 1;
  }
  env.println("verify: OK");
  return 0;
}

export function runStatus(args: ParsedArgs, env: VerifyCmdEnv): number {
  const rootDir = optionalFlag(args, "path") ?? ".maintainers";
  const asOfFlag = optionalFlag(args, "as-of");
  const now = parseAsOf(asOfFlag, env.now());
  const report = buildReport(rootDir, now);
  printReport(report, env.println);
  return 0;
}

function printReport(r: VerifyReport, println: (l: string) => void): void {
  println(`maintainers store at ${r.rootDir}`);
  println(`  root policy: ${r.rootPolicyPresent ? "present" : "missing"}`);
  if (r.tracks.length === 0) {
    println("  no tracks discovered");
  }
  for (const t of r.tracks) {
    println("");
    println(`  track: ${t.track}`);
    println(`    policy:           ${t.hasPolicy ? "present" : "MISSING"}`);
    println(`    mandates (total): ${t.totalMandates}`);
    println(`    mandates (valid): ${t.validMandates}`);
    if (t.rejections.length > 0) {
      println(`    rejections:`);
      for (const rej of t.rejections) {
        println(`      - ${rej.mandateId.slice(0, 8)}… ${rej.reason}${rej.detail ? ` (${rej.detail})` : ""}`);
      }
    }
    if (t.currentHolder) {
      println(`    current holder:   ${t.currentHolder}`);
      println(`    expires at:       ${t.currentMandateExpiresAt}`);
      if (t.msUntilExpiry !== null) {
        const days = Math.floor(t.msUntilExpiry / (24 * 60 * 60 * 1000));
        const hours = Math.floor((t.msUntilExpiry % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        println(`    time remaining:   ${days}d ${hours}h`);
      }
      println(`    successors:       ${t.successors.length === 0 ? "(none)" : t.successors.map((s) => s.slice(0, 16) + "…").join(", ")}`);
    } else {
      println(`    current holder:   (none — track expired pending succession)`);
      if (t.lastExpiredHolder) {
        println(`    last holder:      ${t.lastExpiredHolder}`);
        println(`    successors:       ${t.successors.length === 0 ? "(none)" : t.successors.map((s) => s.slice(0, 16) + "…").join(", ")}`);
      }
    }
  }
  println("");
  println(`  endorsements: ${r.endorsementsValid}/${r.endorsementsTotal} valid`);
  if (r.endorsementsRejected > 0) {
    println(`  endorsement errors:`);
    for (const e of r.endorsementErrors) {
      println(`    - ${e.releaseId.slice(0, 8)}… ${e.reason}${e.detail ? ` (${e.detail})` : ""}`);
    }
  }
}

function parseAsOf(spec: string | undefined, fallback: Date): Date {
  if (!spec || spec === "now") return fallback;
  const t = Date.parse(spec);
  if (!Number.isFinite(t)) {
    throw new CliError(`invalid --as-of "${spec}"; expected RFC3339 or "now"`);
  }
  return new Date(t);
}

export const _internal = { parseAsOf, printReport };
