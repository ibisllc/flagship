/**
 * Web adapter — WRAPS the existing Playwright rig (apps/web/e2e), it does not
 * reinvent it (§12-G3). It invokes the gym Playwright config (chromium +
 * self-contained static webapp server, no backend), then maps Playwright's JSON
 * report + attached screenshots into the gym artifact.
 *
 * The deterministic verdict = Playwright's pass/fail for the scenario's spec.
 * Screenshots are pulled from the scenario's `gym-screenshot:<point>`
 * attachments and copied into the run dir.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Scenario } from "../scenario.js";
import type { ScreenshotRef } from "../results.js";
import type { AdapterContext, AdapterOutcome, SurfaceAdapter } from "./types.js";

const GYM_CONFIG_REL = "apps/web/e2e/gym/playwright.gym.config.ts";

/** Minimal shape of the Playwright JSON reporter output we consume. */
interface PwAttachment {
  name: string;
  path?: string;
  contentType?: string;
}
interface PwTestResult {
  status?: string;
  duration?: number;
  attachments?: PwAttachment[];
}
interface PwTest {
  results?: PwTestResult[];
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  stats?: { expected?: number; unexpected?: number; flaky?: number };
}

function walkSpecs(suite: PwSuite, out: PwSpec[]): void {
  for (const s of suite.specs ?? []) out.push(s);
  for (const child of suite.suites ?? []) walkSpecs(child, out);
}

export class WebAdapter implements SurfaceAdapter {
  readonly surface = "web" as const;

  async available(ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    const cfg = join(ctx.repoRoot, GYM_CONFIG_REL);
    if (!existsSync(cfg)) return { ok: false, reason: `gym Playwright config missing at ${GYM_CONFIG_REL}` };
    // The Playwright CLI is a workspace dep; node_modules/.bin/playwright.
    const bin = join(ctx.repoRoot, "node_modules", ".bin", "playwright");
    if (!existsSync(bin)) return { ok: false, reason: "playwright not installed (run npm install)" };
    return { ok: true };
  }

  async run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome> {
    const started = Date.now();
    const pwOutput = mkdtempSync(join(tmpdir(), "gym-pw-"));
    const jsonPath = join(pwOutput, "report.json");

    // Invoke Playwright against the gym config. `scenario.harness` selects the
    // spec by grep title so a single config can host many gym specs later.
    const res = spawnSync(
      "npx",
      [
        "playwright",
        "test",
        "--config",
        GYM_CONFIG_REL,
        "--grep",
        scenario.harness,
      ],
      {
        cwd: ctx.repoRoot,
        encoding: "utf8",
        env: { ...process.env, GYM_PW_OUTPUT: pwOutput, GYM_PW_JSON: jsonPath },
        // Playwright + chromium launch + static server; generous ceiling.
        timeout: 180_000,
      },
    );

    const log = [res.stdout ?? "", res.stderr ?? ""].join("\n").trim();
    const screenshots: ScreenshotRef[] = [];
    let passed = res.status === 0;

    if (existsSync(jsonPath)) {
      try {
        const report = JSON.parse(readFileSync(jsonPath, "utf8")) as PwReport;
        const specs: PwSpec[] = [];
        for (const suite of report.suites ?? []) walkSpecs(suite, specs);
        // The grep narrows to our scenario's spec(s); require all matched ok.
        if (specs.length > 0) passed = specs.every((s) => s.ok !== false);
        // Pull screenshots into the run dir. Prefer the scenario's named
        // `gym-screenshot:<point>` captures; also keep Playwright's own
        // failure screenshot (named "screenshot") so a FAILED scenario still
        // yields a frame for triage + the advisory judge.
        let n = 0;
        for (const spec of specs) {
          for (const t of spec.tests ?? []) {
            for (const r of t.results ?? []) {
              for (const a of r.attachments ?? []) {
                if (!a.path || !existsSync(a.path)) continue;
                let point: string | null = null;
                if (a.name.startsWith("gym-screenshot:")) point = a.name.slice("gym-screenshot:".length);
                else if (a.name === "screenshot" && (a.contentType ?? "").includes("png")) point = "failure";
                if (!point) continue;
                const fname = `${scenario.id}-${point}-web-${n++}.png`;
                const dest = join(ctx.runDir, "screenshots", fname);
                copyFileSync(a.path, dest);
                screenshots.push({ point, path: join("screenshots", fname) });
              }
            }
          }
        }
      } catch {
        // Malformed report: fall back to the exit code as the verdict.
      }
    }

    rmSync(pwOutput, { recursive: true, force: true });
    return {
      passed,
      durationMs: Date.now() - started,
      screenshots,
      log: log.slice(-4000),
    };
  }
}
