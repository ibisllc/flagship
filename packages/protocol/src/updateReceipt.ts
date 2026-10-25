/**
 * Canary update receipts (architecture v2 V02; SECURITY-HARDENING-PLAN.md 18.13 "track verified
 * artifact/config running on consenting boxes").
 *
 * After an update reaches a verdict, a box whose owner agreed to share update results sends ONE receipt to
 * `.com`. A receipt says only: which release, which rollout cohort the box sat in for it, whether the boot
 * health gate passed, whether the box rolled back, the CPU architecture and the container stack. It never
 * carries the server's name, the account, a key, an address, the release the box came from, a time finer
 * than the day `.com` stamps on arrival, or anything an app holds. `.com` keeps counts per release, cohort,
 * profile and day, never a row per box (docs/runbooks/canary.md).
 *
 * The cohort comes from the box's own secret rollout salt, the same salt the catalog gate uses to decide
 * whether this box may take a release yet (`rolloutBucket`). The salt never leaves the box, and the bucket is
 * a different hash for every release, so `.com` cannot tell which box is in which cohort and cohorts of two
 * releases cannot be linked to one box.
 */
import { rolloutBucket } from "./releaseMetadata.js";

export const UPDATE_RECEIPT_FORMAT = 1;

/** Where a box sends a receipt on `.com` (anonymous POST, metered per network). */
export const UPDATE_RECEIPT_PATH = "/api/update-receipts";

/** The rollout ladder the canary widens along, in percent. The catalog may hold any 0..100; cohorts use these. */
export const CANARY_STAGES = [1, 5, 20, 50, 100] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];
export type CanaryCohort = "1" | "5" | "20" | "50" | "100";

export type ReceiptArch = "amd64" | "arm64" | "other";
export type ReceiptStack = "classic" | "arch-v2";

export interface UpdateReceipt {
  format: 1;
  /** The 40-hex commit the box tried to move to. */
  release: string;
  cohort: CanaryCohort;
  healthGate: "pass" | "fail";
  rolledBack: boolean;
  arch: ReceiptArch;
  stack: ReceiptStack;
  /** 32 random hex, new for every receipt: lets `.com` drop a resend. Links nothing. */
  nonce: string;
}

/** What a receipt means for the canary: kept, rolled back, or failed and could not roll back. */
export type ReceiptOutcome = "passed" | "rolled-back" | "stuck";

const KEYS = ["format", "release", "cohort", "healthGate", "rolledBack", "arch", "stack", "nonce"].sort().join(",");
const COMMIT = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const COHORTS: readonly string[] = CANARY_STAGES.map(String);

/** The smallest ladder stage that already includes this box for this release. */
export function canaryCohort(boxSalt: string, commit: string): CanaryCohort {
  const bucket = rolloutBucket(boxSalt, commit);
  for (const s of CANARY_STAGES) if (bucket < s * 100) return String(s) as CanaryCohort;
  return "100";
}

export function receiptOutcome(r: Pick<UpdateReceipt, "healthGate" | "rolledBack">): ReceiptOutcome {
  if (r.healthGate === "pass") return "passed";
  return r.rolledBack ? "rolled-back" : "stuck";
}

/** Exact keys, exact values; anything else is refused (an extra field is a leak, not a version). */
export function parseUpdateReceipt(v: unknown): UpdateReceipt | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== KEYS) return null;
  if (o.format !== UPDATE_RECEIPT_FORMAT) return null;
  if (typeof o.release !== "string" || !COMMIT.test(o.release)) return null;
  if (typeof o.cohort !== "string" || !COHORTS.includes(o.cohort)) return null;
  if (o.healthGate !== "pass" && o.healthGate !== "fail") return null;
  if (typeof o.rolledBack !== "boolean") return null;
  // A box that passed its health gate kept the release; "passed and rolled back" is not a state.
  if (o.healthGate === "pass" && o.rolledBack) return null;
  if (o.arch !== "amd64" && o.arch !== "arm64" && o.arch !== "other") return null;
  if (o.stack !== "classic" && o.stack !== "arch-v2") return null;
  if (typeof o.nonce !== "string" || !NONCE.test(o.nonce)) return null;
  return o as unknown as UpdateReceipt;
}

export function receiptArch(nodeArch: string): ReceiptArch {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  return "other";
}

// ---------------------------------------------------------------- the canary decision

export interface OutcomeCounts {
  passed: number;
  rolledBack: number;
  stuck: number;
}

export interface CanaryPolicy {
  /** Receipts the release needs in total before the next stage opens. */
  minReceipts: number;
  /** Hours a stage stays open before it may widen (the plan asks for at least 48, more for boot changes). */
  minHours: number;
  /** Rollbacks at which the canary stops outright (one rollback holds it for a look). */
  stopRollbacks: number;
  /** Rollback share at which it stops outright, once there are receipts. */
  stopRollbackRate: number;
}

export const DEFAULT_CANARY_POLICY: CanaryPolicy = { minReceipts: 3, minHours: 48, stopRollbacks: 2, stopRollbackRate: 0.05 };

/** Below this many receipts a rollback share is noise; the absolute bound and the hold decide. */
const RATE_MIN_RECEIPTS = 20;

export type CanaryAction = "stop" | "hold" | "wait" | "widen" | "complete";

export interface CanaryVerdict {
  action: CanaryAction;
  /** The stage to widen to, for "widen". */
  next?: CanaryStage;
  reason: string;
}

export function nextCanaryStage(percent: number): CanaryStage | null {
  for (const s of CANARY_STAGES) if (s > percent) return s;
  return null;
}

export function totalReceipts(c: OutcomeCounts): number {
  return c.passed + c.rolledBack + c.stuck;
}

/**
 * Stop, hold, wait or widen, from one release's counts and how long its current stage has been open.
 * Stop beats everything: a box that failed and could not go back, or rollbacks past the bound. Every
 * profile (architecture x stack) is judged on its own as well, so a small profile cannot hide behind a big
 * healthy one.
 */
export function canaryVerdict(input: {
  percent: number;
  openedAt: number | null;
  now: number;
  totals: OutcomeCounts;
  byProfile?: Record<string, OutcomeCounts>;
  policy?: CanaryPolicy;
}): CanaryVerdict {
  const p = input.policy ?? DEFAULT_CANARY_POLICY;
  const groups: [string, OutcomeCounts][] = [["all boxes", input.totals], ...Object.entries(input.byProfile ?? {})];
  for (const [name, c] of groups) {
    if (c.stuck > 0) {
      return { action: "stop", reason: `${name}: ${c.stuck} box(es) failed the health gate and could not roll back (below the security floor)` };
    }
    const n = totalReceipts(c);
    // The share only counts once there are enough receipts for it to mean something.
    if (c.rolledBack >= p.stopRollbacks || (n >= RATE_MIN_RECEIPTS && c.rolledBack / n > p.stopRollbackRate)) {
      return { action: "stop", reason: `${name}: ${c.rolledBack} of ${n} updates rolled back` };
    }
  }
  if (input.totals.rolledBack > 0) {
    return { action: "hold", reason: `${input.totals.rolledBack} update rolled back: find out why before widening (docs/runbooks/canary.md)` };
  }
  if (input.percent >= 100) return { action: "complete", reason: "every box may take this release" };
  if (input.openedAt === null) return { action: "wait", reason: "the stage's opening time is unknown: record it before widening" };
  const hours = (input.now - input.openedAt) / 3_600_000;
  if (hours < p.minHours) {
    return { action: "wait", reason: `the stage has been open ${hours.toFixed(1)} h of ${p.minHours} h` };
  }
  const n = totalReceipts(input.totals);
  if (n < p.minReceipts) return { action: "wait", reason: `${n} receipt(s) of the ${p.minReceipts} needed` };
  const next = nextCanaryStage(input.percent);
  if (next === null) return { action: "complete", reason: "every box may take this release" };
  return { action: "widen", next, reason: `${n} receipts, none rolled back, stage open ${hours.toFixed(0)} h` };
}
