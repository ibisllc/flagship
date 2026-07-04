/**
 * INTEGRATION scaffold for the real adapter edge (`ExecTrivyRunner`,
 * `ExecScanRunner`, `HttpReportStore`, `HttpResultPoster`,
 * `HttpQueueSource`).
 *
 * These exercise the ACTUAL git / npm / trivy / semgrep binaries + a
 * network, which are NOT present in CI or the dev sandbox — so the whole
 * suite is SKIPPED unless `FLAGSHIP_SCANNER_INTEGRATION=1` is set (and the
 * binaries are installed on the host). The pure grade/policy/orchestration
 * core is already exhaustively covered by the fake-port unit tests
 * (pipeline / scanner / grade / policy / imageRef); this file is the seam
 * an operator flips on to smoke the real edge on a Docker-equipped box.
 *
 * Run it live from the scanner package on a provisioned host:
 *   FLAGSHIP_SCANNER_INTEGRATION=1 \
 *   FLAGSHIP_SCANNER_TEST_IMAGE=node:18 \
 *   npx vitest run tests/adapters.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { ExecTrivyRunner } from "../src/adapters.js";
import { resolveImageRef } from "../src/imageRef.js";

const LIVE = process.env["FLAGSHIP_SCANNER_INTEGRATION"] === "1";
// A deliberately old image is a good smoke target — it should surface
// findings so the real Trivy path returns a non-empty list.
const TEST_IMAGE = process.env["FLAGSHIP_SCANNER_TEST_IMAGE"] ?? "node:18";

describe.skipIf(!LIVE)("marketplace-scanner real adapters (integration)", () => {
  it("resolves the configured smoke image out of a manifest shape", () => {
    // Pure — always meaningful, even as documentation of the wiring the
    // live run depends on: the drain hands the runner an image ref
    // resolved from `runtime.image`.
    const ref = resolveImageRef({ runtime: { image: TEST_IMAGE, port: 8080 } });
    expect(ref).toBe(TEST_IMAGE);
  });

  it(
    "ExecTrivyRunner.scan(docker://<image>) shells out to trivy and returns findings",
    { timeout: 10 * 60_000 },
    async () => {
      const runner = new ExecTrivyRunner();
      const findings = await runner.scan(`docker://${TEST_IMAGE}`);
      // We don't assert a specific count (the image's CVE tally drifts as
      // the DB updates) — only that the real binary ran and produced a
      // well-shaped list the fold/grade path can consume.
      expect(Array.isArray(findings)).toBe(true);
      for (const f of findings) {
        expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(f.severity);
        expect(typeof f.id).toBe("string");
      }
    },
  );

  // TODO(operator): extend with a live ExecScanRunner run against a small
  // known repo (git clone @ tree hash + npm audit + semgrep), and a
  // HttpReportStore round-trip against a scratch R2 bucket. Both need real
  // creds/binaries and so stay behind the same FLAGSHIP_SCANNER_INTEGRATION
  // gate.
});
