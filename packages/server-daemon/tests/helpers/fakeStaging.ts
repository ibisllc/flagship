import {
  filesDigest,
  type CheckAppRequest,
  type CheckAppResult,
  type StageArgs,
  type StagedCopy,
  type StageResult,
  type StagingHost,
} from "../../src/buildmodes/staging.js";

/**
 * A staging host that runs nothing: it records what it was asked to stage,
 * answers `checkApp` and `logs` from scripts, and tracks the staged copies
 * the way `StagingRunner` does (image + files digest).
 */
export class FakeStaging implements StagingHost {
  readonly stages: StageArgs[] = [];
  readonly checks: Array<{ buildId: string; req: CheckAppRequest }> = [];
  readonly teardowns: string[] = [];
  readonly events: string[] = [];
  /** Results for the next stage() calls, in order; then ok. */
  results: StageResult[] = [];
  check: (req: CheckAppRequest) => CheckAppResult = () => ({
    ok: true,
    status: 200,
    contentType: "text/html",
    body: "<h1>hello</h1>",
    truncated: false,
  });
  logText = "listening on 8080";
  private readonly copies = new Map<string, StagedCopy>();
  private readonly lastImages = new Map<string, string>();
  private readonly up = new Set<string>();
  private n = 0;

  async stage(a: StageArgs): Promise<StageResult> {
    this.stages.push({ ...a, files: { ...a.files } });
    this.events.push(`stage:${a.buildId}`);
    this.copies.delete(a.buildId);
    this.up.add(a.buildId);
    const r = this.results.shift() ?? { ok: true as const, image: `flagship-stg-${a.buildId}:${++this.n}` };
    if (r.ok) {
      this.copies.set(a.buildId, { image: r.image, filesDigest: filesDigest(a.files), slug: a.slug });
      this.lastImages.set(a.buildId, r.image);
    }
    return r;
  }

  async checkApp(buildId: string, req: CheckAppRequest): Promise<CheckAppResult> {
    this.checks.push({ buildId, req });
    if (!this.up.has(buildId)) return { ok: false, reason: "nothing is running yet: call deploy first" };
    return this.check(req);
  }

  async logs(buildId: string): Promise<string | null> {
    return this.up.has(buildId) ? this.logText : null;
  }

  async teardown(buildId: string): Promise<void> {
    this.teardowns.push(buildId);
    this.events.push(`teardown:${buildId}`);
    this.up.delete(buildId);
  }

  staged(buildId: string): StagedCopy | null {
    const c = this.copies.get(buildId);
    return c ? { ...c } : null;
  }

  forget(buildId: string): void {
    this.events.push(`forget-copy:${buildId}`);
    this.copies.delete(buildId);
  }

  /** The image the build last staged successfully, even after `forget`. */
  lastImage(buildId: string): string | undefined {
    return this.lastImages.get(buildId);
  }
}
