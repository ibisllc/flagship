/**
 * The private test copy without Docker: a `StagingHost` (the interface the
 * box's staged chat deploy and fix loop use) whose `stage` is the static
 * build check. Its answers mirror `StagingRunner`'s: a build failure leaves
 * nothing running; a start failure leaves a stopped copy whose "logs" are
 * the failure output; a copy that passes is "running".
 *
 * A copy that passes is never actually started, so `check_app` answers a
 * plain note with status 200 and `get_logs` says it wasn't started. The
 * data tools (`query_db`, …) are absent, which the box answers as "not
 * available on this server". See the README's list of deviations.
 */

import type {
  CheckAppRequest,
  CheckAppResult,
  StageArgs,
  StageResult,
  StagedCopy,
  StagingHost,
} from "../../../../packages/server-daemon/src/buildmodes/staging.js";
import { filesDigest } from "../../../../packages/server-daemon/src/buildmodes/staging.js";
import { staticBuildCheck, type CheckResult, type StaticCheckOptions } from "./staticCheck.js";

export const STATIC_CHECK_BODY =
  "(build-eval: this test copy passed the static build check; it was not started, so this is not the app's answer)";
export const STATIC_LOGS = "(build-eval: the test copy passed the static build check and was not started, so it has no output)";

/** What a staging attempt ended with, for the run's accounting. */
export interface StageOutcome {
  buildId: string;
  ok: boolean;
  reason?: string;
}

interface Copy {
  ok: boolean;
  output?: string;
}

export class StaticStaging implements StagingHost {
  private readonly copies = new Map<string, Copy>();
  private readonly stagedCopies = new Map<string, StagedCopy>();
  private n = 0;

  constructor(
    private readonly opts: StaticCheckOptions & { onStage?: (o: StageOutcome) => void } = {},
    private readonly check: (files: Record<string, string>) => Promise<CheckResult> = (f) => staticBuildCheck(f, opts),
  ) {}

  async stage(a: StageArgs): Promise<StageResult> {
    this.stagedCopies.delete(a.buildId);
    this.copies.delete(a.buildId);
    const r = await this.check(a.files);
    if (!r.ok) {
      if (r.started) this.copies.set(a.buildId, { ok: false, output: r.output ?? "" });
      this.opts.onStage?.({ buildId: a.buildId, ok: false, reason: r.reason });
      return { ok: false, reason: r.reason };
    }
    const image = `flagship-stg-${a.buildId}:${++this.n}`;
    this.copies.set(a.buildId, { ok: true });
    this.stagedCopies.set(a.buildId, { image, filesDigest: filesDigest(a.files), slug: a.slug });
    this.opts.onStage?.({ buildId: a.buildId, ok: true });
    return { ok: true, image };
  }

  async checkApp(buildId: string, req: CheckAppRequest): Promise<CheckAppResult> {
    const c = this.copies.get(buildId);
    if (!c) return { ok: false, reason: "nothing is running yet: call deploy first" };
    if (typeof req.path !== "string" || !req.path.startsWith("/")) return { ok: false, reason: "path must start with / and contain no spaces" };
    if (!c.ok) return { ok: false, reason: "connect ECONNREFUSED: the test copy isn't running" };
    return { ok: true, status: 200, contentType: "text/plain; charset=utf-8", body: STATIC_CHECK_BODY, truncated: false };
  }

  async logs(buildId: string): Promise<string | null> {
    const c = this.copies.get(buildId);
    if (!c) return null;
    return c.ok ? STATIC_LOGS : c.output ?? "";
  }

  async teardown(buildId: string): Promise<void> {
    this.copies.delete(buildId);
  }

  staged(buildId: string): StagedCopy | null {
    const s = this.stagedCopies.get(buildId);
    return s ? { ...s } : null;
  }

  forget(buildId: string): void {
    this.stagedCopies.delete(buildId);
  }
}
