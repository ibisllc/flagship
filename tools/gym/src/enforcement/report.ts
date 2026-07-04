/**
 * Enforcement-phase rollup + verdict (docs/ui-test-gym.md).
 *
 * The STRICT rule that makes this a security gate rather than a smoke test:
 * `fullyEnforced` is true ONLY when every check is `enforced` — a `bypassed`
 * check is RED, and a `skipped` check (couldn't provision / no secret / transport
 * error) is INCONCLUSIVE and is NOT counted as a pass. This is the restricted-mode
 * lesson at the harness level: a silently-skipped security check can never read as
 * green.
 *
 * Exit-code contract (mirrors gym-total's 0/1/3 so gym-weekly folds it in):
 *   0  every check enforced (green).
 *   1  at least one BYPASS (a control did not fire on the wire) — RED, always
 *      blocks the run.
 *   3  no bypass, but at least one check SKIPPED (or nothing ran) — inconclusive.
 *      gym:total treats this as a soft skip; gym:weekly (weekly means FULL) treats
 *      it as a failure, exactly like the cloud half's exit 3.
 */

import type { CheckOutcome } from "./types.js";

export interface EnforcementReport {
  readonly outcomes: readonly CheckOutcome[];
  readonly enforced: number;
  readonly bypassed: number;
  readonly skipped: number;
  /** Checks that produced a verdict (enforced + bypassed) — SKIPPED excluded. */
  readonly considered: number;
  /**
   * The gate verdict. True ⇒ every check enforced AND at least one ran. A single
   * bypass OR a single skip makes this false (skip is not a pass).
   */
  readonly fullyEnforced: boolean;
  /** True iff any check proved a real bypass (RED regardless of skips). */
  readonly anyBypass: boolean;
}

export function rollup(outcomes: readonly CheckOutcome[]): EnforcementReport {
  const enforced = outcomes.filter((o) => o.status === "enforced").length;
  const bypassed = outcomes.filter((o) => o.status === "bypassed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const considered = enforced + bypassed;
  return {
    outcomes,
    enforced,
    bypassed,
    skipped,
    considered,
    anyBypass: bypassed > 0,
    // STRICT: a skip is NOT a pass. Every check must be enforced (and ≥1 ran).
    fullyEnforced: bypassed === 0 && skipped === 0 && enforced > 0,
  };
}

/** 0 = green · 1 = a bypass (RED) · 3 = inconclusive (a skip, no bypass). */
export function verdictExitCode(report: EnforcementReport): 0 | 1 | 3 {
  if (report.anyBypass) return 1;
  if (report.fullyEnforced) return 0;
  return 3;
}

export function renderReport(report: EnforcementReport): string {
  const lines: string[] = [];
  lines.push("Flagship live-enforcement gates");
  lines.push("");
  for (const o of report.outcomes) {
    const mark = o.status === "enforced" ? "ENFORCED" : o.status === "bypassed" ? "BYPASSED" : "SKIPPED";
    lines.push(`[${mark}] ${o.id} — ${o.title}`);
    lines.push(`         control: ${o.control}`);
    if (o.skipReason) lines.push(`         skipped: ${o.skipReason}`);
    if (o.deferred) {
      lines.push(
        `         deferred(${o.deferred.deterministic ? "proven-deterministically" : "not-proven"}): ${o.deferred.reason}`,
      );
      lines.push(`         TODO(live): ${o.deferred.todo}`);
    }
    for (const a of o.assertions) {
      const mark = a.informational ? "· (info, not asserted)" : a.ok ? "✓" : "✗ BYPASS";
      lines.push(`         ${mark} ${a.label} — ${a.detail}`);
    }
  }
  lines.push("");
  lines.push(
    `totals: ${report.enforced} enforced, ${report.bypassed} bypassed, ${report.skipped} skipped ` +
      `(${report.considered} considered)`,
  );
  const exit = verdictExitCode(report);
  const verdict =
    exit === 0
      ? "OK — every control fired on the wire"
      : exit === 1
        ? "FAILED — a control was BYPASSED (does not fire on the wire)"
        : "INCONCLUSIVE — a check was SKIPPED (no box/secret); NOT a pass";
  lines.push(`verdict: ${verdict}`);
  return lines.join("\n");
}
