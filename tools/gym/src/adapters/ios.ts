/**
 * iOS adapter — WRAPS XCUITest (§12-G3). It shells `xcodebuild test` for the
 * scenario's `-only-testing:` identifier against the iOS Simulator, launching
 * the app in demo-fixture mode (the `-smoke-mode` launch arg, wired in
 * FlagshipApp). The deterministic verdict = xcodebuild's pass/fail; screenshots
 * are extracted from the emitted `.xcresult` (the `gym-screenshot:<point>`
 * attachments) into the run dir for the advisory judge.
 *
 * Running this also BUILDS the FlagshipApp + UITest target, so a green iOS
 * smoke validates the full app build (and the G2 launch-arg seam) end-to-end.
 *
 * Availability requires macOS + Xcode + a Simulator runtime; on any other host
 * the adapter reports unavailable and the runner SKIPS iOS (it never fails it).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Scenario } from "../scenario.js";
import type { ScreenshotRef } from "../results.js";
import type { AdapterContext, AdapterOutcome, SurfaceAdapter } from "./types.js";

const IOS_APP_DIR_REL = "apps/mobile/ios/App";
const SCHEME = "FlagshipApp";
/** Fallback Simulator name when no iPhone UDID can be resolved; overridable via GYM_IOS_DESTINATION. */
const FALLBACK_DESTINATION = "platform=iOS Simulator,name=iPhone 16 Pro";
/** Fallback iPad Simulator name (the D8 iPad pass); overridable via GYM_IOS_IPAD_DESTINATION. */
const FALLBACK_IPAD_DESTINATION = "platform=iOS Simulator,name=iPad Pro 11-inch (M4)";

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

/**
 * iPad scenarios run on an iPad `-destination`; every other iOS scenario runs
 * on the iPhone. We detect them by harness id (the GymIPadTests class) rather
 * than a new Surface type, so the iPad pass stays inside the single "ios"
 * surface (no scenario-model change). §7-C / D8.
 */
function isIPadScenario(harness: string): boolean {
  return harness.includes("GymIPad");
}

/**
 * Resolve a stable test destination for a scenario. iPad scenarios prefer an
 * iPad simulator; all others prefer an iPhone. The env overrides win
 * (`GYM_IOS_IPAD_DESTINATION` for iPad, `GYM_IOS_DESTINATION` for iPhone).
 * Otherwise prefer a BOOTED simulator of the right family's UDID (the most
 * reliable matcher — `name=` matching is brittle across runtimes); fall back
 * to the first available of that family, then to the literal name.
 */
function resolveDestination(harness: string): string {
  const ipad = isIPadScenario(harness);
  const override = ipad ? process.env.GYM_IOS_IPAD_DESTINATION : process.env.GYM_IOS_DESTINATION;
  if (override) return override;
  try {
    const out = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (out.status === 0 && out.stdout) {
      const parsed = JSON.parse(out.stdout) as {
        devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
      };
      const all = Object.values(parsed.devices).flat();
      const family = all.filter((d) => d.name.startsWith(ipad ? "iPad" : "iPhone"));
      const booted = family.find((d) => d.state === "Booted");
      const pick = booted ?? family[0];
      if (pick) return `platform=iOS Simulator,id=${pick.udid}`;
    }
  } catch {
    // Fall through to the literal name.
  }
  return ipad ? FALLBACK_IPAD_DESTINATION : FALLBACK_DESTINATION;
}

export class IosAdapter implements SurfaceAdapter {
  readonly surface = "ios" as const;

  async available(ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "darwin") return { ok: false, reason: "iOS gym requires macOS" };
    if (!which("xcodebuild")) return { ok: false, reason: "xcodebuild not on PATH (install Xcode)" };
    if (!which("xcrun")) return { ok: false, reason: "xcrun not on PATH" };
    if (!existsSync(join(ctx.repoRoot, IOS_APP_DIR_REL))) {
      return { ok: false, reason: `iOS app dir missing at ${IOS_APP_DIR_REL}` };
    }
    return { ok: true };
  }

  async run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome> {
    const started = Date.now();
    const appDir = join(ctx.repoRoot, IOS_APP_DIR_REL);
    const logParts: string[] = [];

    // 1. Regenerate the Xcode project from project.yml (xcodegen) so a fresh
    //    checkout / a new UITest file is always reflected. Best-effort: if
    //    xcodegen is absent we proceed with the committed .xcodeproj.
    if (which("xcodegen")) {
      const gen = spawnSync("xcodegen", ["generate"], { cwd: appDir, encoding: "utf8", timeout: 120_000 });
      logParts.push("[xcodegen]\n" + (gen.stdout ?? "") + (gen.stderr ?? ""));
    }

    // 2. Run the scenario's UITest. `scenario.harness` is the
    //    `-only-testing:` identifier (e.g. FlagshipAppUITests/GymSmokeTests).
    const resultBundle = mkdtempSync(join(tmpdir(), "gym-xcresult-")) + "/run.xcresult";
    const destination = resolveDestination(scenario.harness);
    logParts.push("[gym] destination: " + destination);
    const xcb = spawnSync(
      "xcodebuild",
      [
        "test",
        "-scheme",
        SCHEME,
        "-destination",
        destination,
        "-only-testing:" + scenario.harness,
        "-resultBundlePath",
        resultBundle,
        "-quiet",
        // Build + UITest signing on the Simulator does not need a real cert.
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: appDir, encoding: "utf8", timeout: 1_200_000 },
    );
    logParts.push("[xcodebuild]\n" + (xcb.stdout ?? "") + (xcb.stderr ?? ""));

    const passed = xcb.status === 0;
    const screenshots = this.extractScreenshots(resultBundle, scenario, ctx, logParts);

    rmSync(resultBundle, { recursive: true, force: true });
    return {
      passed,
      durationMs: Date.now() - started,
      screenshots,
      log: logParts.join("\n").slice(-6000),
    };
  }

  /**
   * Pull the `gym-screenshot:<point>` attachments out of the .xcresult via
   * `xcrun xcresulttool`. The export API differs across Xcode versions, so we
   * try the modern `export attachments` form and fall back gracefully — a
   * missing screenshot never changes the verdict.
   */
  private extractScreenshots(
    resultBundle: string,
    scenario: Scenario,
    ctx: AdapterContext,
    logParts: string[],
  ): ScreenshotRef[] {
    const out: ScreenshotRef[] = [];
    if (!existsSync(resultBundle)) return out;
    const dump = mkdtempSync(join(tmpdir(), "gym-shots-"));
    // Xcode 15+: `xcresulttool export attachments` writes files + a manifest.
    const exp = spawnSync(
      "xcrun",
      ["xcresulttool", "export", "attachments", "--path", resultBundle, "--output-path", dump],
      { encoding: "utf8", timeout: 120_000 },
    );
    logParts.push("[xcresulttool]\n" + (exp.stdout ?? "") + (exp.stderr ?? ""));

    const manifestPath = join(dump, "manifest.json");
    try {
      if (existsSync(manifestPath)) {
        // The manifest maps exported filenames → suggested human names.
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{
          attachments?: Array<{ exportedFileName?: string; suggestedHumanReadableName?: string }>;
        }>;
        let n = 0;
        for (const test of manifest) {
          for (const a of test.attachments ?? []) {
            const name = a.suggestedHumanReadableName ?? "";
            // XCUITest STRIPS the colon from the attachment name and appends
            // `_<index>_<uuid>.png`, so `gym-screenshot:cold-launch` lands as
            // `gym-screenshotcold-launch_0_<uuid>.png`. Match that shape and
            // recover the point name from between the prefix and the suffix.
            const m = /^gym-screenshot(.+?)_\d+_[0-9A-Fa-f-]+\.png$/.exec(name);
            if (!m || !a.exportedFileName) continue;
            const src = join(dump, a.exportedFileName);
            if (!existsSync(src)) continue;
            const point = m[1]!;
            const fname = `${scenario.id}-${point}-ios-${n++}.png`;
            copyFileSync(src, join(ctx.runDir, "screenshots", fname));
            out.push({ point, path: join("screenshots", fname) });
          }
        }
      }
    } catch (e) {
      logParts.push("[gym] screenshot manifest parse failed: " + String(e));
    }

    // Fallback: if the manifest path wasn't produced, copy any exported PNGs.
    if (out.length === 0 && existsSync(dump)) {
      let n = 0;
      for (const f of readdirSync(dump)) {
        if (!f.toLowerCase().endsWith(".png")) continue;
        const fname = `${scenario.id}-shot-ios-${n++}.png`;
        copyFileSync(join(dump, f), join(ctx.runDir, "screenshots", fname));
        out.push({ point: "shot", path: join("screenshots", fname) });
      }
    }

    rmSync(dump, { recursive: true, force: true });
    return out;
  }
}
