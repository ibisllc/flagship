import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { UpdateConsumeOutcome } from "./updateConsumer.js";

/**
 * The verdict of the most recent update order, kept so the owner can see it.
 *
 * Both terminal paths end in a daemon restart (a staged update restarts into
 * the new code; a rollback restarts into the old one), so an in-memory alert
 * would be lost before any client polled. The record lives under
 * /var/flagship, which the code swap never touches, and the authenticated
 * server-detail screen reports it.
 */
export type UpdateOutcomeKind = "applied" | "rolled-back" | "refused";

export interface UpdateOutcomeRecord {
  outcome: UpdateOutcomeKind;
  /** Unix ms when the verdict was reached. */
  at: number;
  /** Present for applied / rolled-back; a refusal may precede decoding. */
  targetCommit?: string;
  previousCommit?: string;
  /** Boots the new code got before its verdict. */
  bootAttempts?: number;
  /** Why the box refused the order (an UpdateConsumeOutcome reason). */
  reason?: RefusalReason;
}

export type RefusalReason = Extract<
  UpdateConsumeOutcome,
  { applied: false }
>["reason"];

/**
 * Refusals the owner can act on. Transient states (no order, network error, an
 * update already staged) are not verdicts, and a replayed nonce is the expected
 * echo of an order already applied or rolled back — recording it would hide
 * the real verdict.
 */
const OWNER_VISIBLE_REFUSALS: ReadonlySet<RefusalReason> = new Set<RefusalReason>([
  "rejected",
  "wrong-domain",
  "stale",
  "from-commit-mismatch",
  "unendorsed",
  "apply-failed",
]);

export function refusalRecord(
  outcome: UpdateConsumeOutcome,
  now: number,
): UpdateOutcomeRecord | null {
  if (outcome.applied || !OWNER_VISIBLE_REFUSALS.has(outcome.reason)) return null;
  return { outcome: "refused", reason: outcome.reason, at: now };
}

export interface UpdateOutcomeStore {
  write(record: UpdateOutcomeRecord): Promise<void>;
  /** Synchronous so the server-detail screen can stay synchronous. */
  readSync(): UpdateOutcomeRecord | null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const KINDS: ReadonlySet<string> = new Set(["applied", "rolled-back", "refused"]);

export function parseUpdateOutcome(raw: unknown): UpdateOutcomeRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.outcome !== "string" || !KINDS.has(r.outcome)) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  const out: UpdateOutcomeRecord = { outcome: r.outcome as UpdateOutcomeKind, at: r.at };
  if (typeof r.targetCommit === "string" && COMMIT.test(r.targetCommit)) out.targetCommit = r.targetCommit;
  if (typeof r.previousCommit === "string" && COMMIT.test(r.previousCommit)) {
    out.previousCommit = r.previousCommit;
  }
  if (typeof r.bootAttempts === "number" && Number.isInteger(r.bootAttempts)) {
    out.bootAttempts = r.bootAttempts;
  }
  if (typeof r.reason === "string" && OWNER_VISIBLE_REFUSALS.has(r.reason as RefusalReason)) {
    out.reason = r.reason as RefusalReason;
  }
  return out;
}

export function fileUpdateOutcomeStore(path: string): UpdateOutcomeStore {
  return {
    async write(record) {
      await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    },
    readSync() {
      try {
        return parseUpdateOutcome(JSON.parse(readFileSync(path, "utf-8")));
      } catch {
        return null;
      }
    },
  };
}
