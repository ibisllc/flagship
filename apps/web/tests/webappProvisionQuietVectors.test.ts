// The webapp's install-progress quiet rule (lib/provisionProgress.js provisionQuiet) against the shared
// vectors in packages/protocol/test-vectors/provision-quiet, identical on iOS and Android: an `installing`
// status quiet for 5 minutes reads as "installer finished", any pre-registration phase quiet for 20
// minutes reads as stuck, with advice under the checklist.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PROVISION_INSTALLER_QUIET_AFTER_MS,
  PROVISION_PHASE_TITLES,
  PROVISION_QUIET_COPY,
  PROVISION_STUCK_AFTER_MS,
  PROVISION_STUCK_PHASES,
  provisionQuiet,
  provisionStepStates,
  renderProgressDetail,
  renderStuckAdvice,
} from "../public/webapp/lib/provisionProgress.js";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/provision-quiet/vectors.json"), "utf8"),
);

describe("provision quiet (test-vectors/provision-quiet/vectors.json)", () => {
  it("uses the vectors' thresholds and phases", () => {
    expect(PROVISION_INSTALLER_QUIET_AFTER_MS).toBe(V.installerQuietAfterMs);
    expect(PROVISION_STUCK_AFTER_MS).toBe(V.stuckAfterMs);
    expect([...PROVISION_STUCK_PHASES].sort()).toEqual([...V.stuckPhases].sort());
  });

  it.each(V.cases.map((c: any) => [c.name, c]))("%s", (_n, c: any) => {
    expect(provisionQuiet(c.phase, c.updatedAt, c.nowMs)).toBe(c.quiet);
  });

  it("English copy equals the vectors", () => {
    expect(PROVISION_QUIET_COPY.installerFinished).toBe(V.copy.installerFinished);
    expect(PROVISION_QUIET_COPY.stuck).toBe(V.copy.stuck);
    expect(PROVISION_QUIET_COPY.stuckAdvice).toBe(V.copy.stuckAdvice);
  });

  it("no updatedAt is never judged", () => {
    expect(provisionQuiet("installing", null, Date.now())).toBe("none");
    expect(provisionQuiet("installing", undefined, Date.now())).toBe("none");
  });
});

describe("the ladder of a quiet box", () => {
  const t0 = 1_800_000_000_000;

  it("a stale installing status renders installerFinished on the current row", () => {
    const quiet = provisionQuiet("installing", t0, t0 + 6 * 60_000);
    const steps = provisionStepStates("installing", null, null, quiet);
    const cur = steps.find((s) => s.state === "active")!;
    expect(cur.key).toBe("installing");
    expect(cur.detail).toBe(V.copy.installerFinished);
    const html = renderProgressDetail({ phase: "installing", quiet });
    expect(html).toContain(V.copy.installerFinished.replace(/'/g, "&#39;"));
    expect(html).not.toContain(`demo-step-detail">${PROVISION_PHASE_TITLES.installing}<`);
  });

  it("a 25-minute-old downloading renders stuck on the current row, not an error", () => {
    const quiet = provisionQuiet("downloading", t0, t0 + 25 * 60_000);
    expect(quiet).toBe("stuck");
    const steps = provisionStepStates("downloading", null, null, quiet);
    const cur = steps.find((s) => s.state === "active")!;
    expect(cur.key).toBe("installing");
    expect(cur.detail).toBe(V.copy.stuck);
    expect(steps.some((s) => s.state === "failed")).toBe(false);
    const html = renderProgressDetail({ phase: "downloading", quiet });
    expect(html).toContain(V.copy.stuck.replace(/'/g, "&#39;"));
    expect(html).toContain("demo-step-active");
    expect(renderStuckAdvice()).toContain(V.copy.stuckAdvice.replace(/'/g, "&#39;"));
  });

  it("a fresh status keeps the phase title", () => {
    const steps = provisionStepStates("installing", null, null, provisionQuiet("installing", t0, t0 + 60_000));
    expect(steps.find((s) => s.state === "active")!.detail).toBe(PROVISION_PHASE_TITLES.installing);
  });
});
