/**
 * Android adapter — WRAPS the Compose-UI-Test + Espresso instrumentation suite
 * (§12-G3 / §10 Phase-5). It shells `./gradlew :app:connectedDebugAndroidTest`
 * for the scenario's class[#method], launching MainActivity on an AVD in
 * smoke mode (the `flagship.smoke*` Intent extras, wired in MainActivity ->
 * SmokeMode). The deterministic verdict = gradle's per-test pass/fail parsed
 * from the connected-test XML; bitmaps captured on-device (the `gym-screenshot-`
 * shot dir) are pulled into the run dir for the advisory judge.
 *
 * AVAILABILITY (detect-and-skip): the on-device suite needs (a) a JDK 17 (the
 * gym CLI runs on a Mac with no system Java — JAVA_HOME must point at
 * openjdk@17), and (b) a REACHABLE device — an `adb devices` online entry, or
 * an installed AVD. On a machine with NO emulator binary + NO AVD (e.g. this
 * dev Mac), `available()` returns `ok:false` with a clear reason, so the runner
 * SKIPS Android cleanly (never fails it) and `gym:total` stays green. The
 * `assembleDebugAndroidTest` compile gate is independent — it runs in CI / on
 * the Mac and proves the harness compiles even when no AVD exists.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Scenario } from "../scenario.js";
import type { ScreenshotRef } from "../results.js";
import type { AdapterContext, AdapterOutcome, SurfaceAdapter } from "./types.js";

const ANDROID_DIR_REL = "apps/mobile/android";
/** The app id (used to pull on-device shots via run-as). */
const APP_ID = "com.flagshipserver.app";
/** Where the androidTest suite writes bitmaps on-device (relative to filesDir). */
const ON_DEVICE_SHOT_SUBDIR = "gym-shots";
/** Default JDK 17 home on this Mac (overridable via GYM_ANDROID_JAVA_HOME / JAVA_HOME). */
const DEFAULT_JAVA_HOME = "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";

/** Resolve the JAVA_HOME the gradle invocation should use. GYM_ANDROID_JAVA_HOME
 *  wins, then an inherited JAVA_HOME, then the default openjdk@17 path. */
function resolveJavaHome(): string | undefined {
  const explicit = process.env.GYM_ANDROID_JAVA_HOME ?? process.env.JAVA_HOME;
  if (explicit && existsSync(explicit)) return explicit;
  if (existsSync(DEFAULT_JAVA_HOME)) return DEFAULT_JAVA_HOME;
  return undefined;
}

/** Resolve ANDROID_HOME / ANDROID_SDK_ROOT, defaulting to the standard Mac path. */
function resolveAndroidHome(): string | undefined {
  const explicit = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.HOME;
  if (home) {
    const def = join(home, "Library", "Android", "sdk");
    if (existsSync(def)) return def;
  }
  return undefined;
}

/** Path to `adb` under the resolved SDK, if present. */
function adbPath(androidHome: string | undefined): string | undefined {
  if (!androidHome) return undefined;
  const p = join(androidHome, "platform-tools", "adb");
  return existsSync(p) ? p : undefined;
}

/** True iff `adb devices` lists at least one device in the `device` (online) state. */
function hasOnlineDevice(adb: string): boolean {
  const out = spawnSync(adb, ["devices"], { encoding: "utf8", timeout: 15_000 });
  if (out.status !== 0 || !out.stdout) return false;
  // Lines after the header: "<serial>\t<state>". A bootable emulator/device
  // shows state `device`; `offline`/`unauthorized` don't count as runnable.
  for (const line of out.stdout.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === "device") return true;
  }
  return false;
}

/** True iff at least one AVD exists (so the runner COULD boot an emulator). */
function hasAvd(androidHome: string | undefined): boolean {
  const emulator = androidHome ? join(androidHome, "emulator", "emulator") : undefined;
  if (!emulator || !existsSync(emulator)) return false;
  const out = spawnSync(emulator, ["-list-avds"], { encoding: "utf8", timeout: 15_000 });
  return out.status === 0 && (out.stdout ?? "").trim().length > 0;
}

export class AndroidAdapter implements SurfaceAdapter {
  readonly surface = "android" as const;

  async available(ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    if (!existsSync(join(ctx.repoRoot, ANDROID_DIR_REL))) {
      return { ok: false, reason: `Android app dir missing at ${ANDROID_DIR_REL}` };
    }
    if (!resolveJavaHome()) {
      return {
        ok: false,
        reason:
          "no JDK 17 found (set GYM_ANDROID_JAVA_HOME / JAVA_HOME to an openjdk@17 home — " +
          `tried ${DEFAULT_JAVA_HOME})`,
      };
    }
    const androidHome = resolveAndroidHome();
    const adb = adbPath(androidHome);
    // A booted emulator/device is what `connectedDebugAndroidTest` needs.
    if (adb && hasOnlineDevice(adb)) return { ok: true };
    // No online device — is there at least an AVD the owner could boot? Either
    // way we SKIP (we don't auto-boot an emulator here), but the reason tells
    // the owner which case they're in.
    if (hasAvd(androidHome)) {
      return {
        ok: false,
        reason:
          "an AVD exists but no emulator is booted — start it " +
          "(`emulator -avd <name>` + `adb wait-for-device`) then re-run the gym",
      };
    }
    return {
      ok: false,
      reason:
        "no Android emulator/AVD on this machine — `connectedDebugAndroidTest` " +
        "needs a booted device. Create + boot an AVD (see the gym owner notes), " +
        "or run the compile gate `:app:assembleDebugAndroidTest` instead.",
    };
  }

  async run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome> {
    const started = Date.now();
    const androidDir = join(ctx.repoRoot, ANDROID_DIR_REL);
    const logParts: string[] = [];
    const javaHome = resolveJavaHome();
    const androidHome = resolveAndroidHome();
    const adb = adbPath(androidHome);

    // Clear the on-device shot dir before the run so we only pull THIS
    // scenario's bitmaps (best-effort; ignore failures).
    if (adb) {
      spawnSync(adb, ["shell", "run-as", APP_ID, "rm", "-rf", `files/${ON_DEVICE_SHOT_SUBDIR}`], {
        encoding: "utf8",
        timeout: 30_000,
      });
    }

    // `scenario.harness` is the Compose-UI-Test class[#method] identifier (no
    // "/"), passed to AndroidJUnitRunner via the class arg.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (javaHome) env.JAVA_HOME = javaHome;
    if (androidHome) env.ANDROID_HOME = androidHome;

    const gradle = spawnSync(
      "./gradlew",
      [
        ":app:connectedDebugAndroidTest",
        `-Pandroid.testInstrumentationRunnerArguments.class=${scenario.harness}`,
        "--stacktrace",
      ],
      { cwd: androidDir, encoding: "utf8", env, timeout: 1_200_000 },
    );
    logParts.push("[gradle]\n" + (gradle.stdout ?? "") + (gradle.stderr ?? ""));

    // The deterministic verdict. Gradle's exit code is the primary signal; the
    // connected-test XML refines it (a 0-test run is NOT a pass — it proves
    // nothing, the same rule as the runner's empty-selection guard).
    const xml = this.parseConnectedResults(androidDir, logParts);
    let passed: boolean;
    if (xml.total > 0) passed = gradle.status === 0 && xml.failures === 0 && xml.errors === 0;
    else {
      passed = false;
      logParts.push(
        "[gym] connectedDebugAndroidTest produced no parseable test XML — not claiming a pass",
      );
    }

    const screenshots = adb ? this.pullScreenshots(adb, scenario, ctx, logParts) : [];

    return {
      passed,
      durationMs: Date.now() - started,
      screenshots,
      log: logParts.join("\n").slice(-6000),
    };
  }

  /**
   * Parse the connected-test JUnit XML
   * (app/build/outputs/androidTest-results/connected/<dir>/*.xml) into a
   * tests/failures/errors tally. AGP writes one file per device; we sum them.
   */
  private parseConnectedResults(
    androidDir: string,
    logParts: string[],
  ): { total: number; failures: number; errors: number } {
    const tally = { total: 0, failures: 0, errors: 0 };
    const base = join(androidDir, "app", "build", "outputs", "androidTest-results", "connected");
    if (!existsSync(base)) return tally;
    for (const f of this.findXml(base)) {
      try {
        const txt = readFileSync(f, "utf8");
        // <testsuite ... tests="N" failures="N" errors="N" ...>
        const ts = /<testsuite\b[^>]*>/.exec(txt)?.[0] ?? "";
        const num = (attr: string): number => {
          const m = new RegExp(`\\b${attr}="(\\d+)"`).exec(ts);
          return m ? Number(m[1]) : 0;
        };
        tally.total += num("tests");
        tally.failures += num("failures");
        tally.errors += num("errors");
      } catch (e) {
        logParts.push("[gym] failed to read connected-test XML " + f + ": " + String(e));
      }
    }
    return tally;
  }

  private findXml(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.findXml(p));
      else if (entry.name.toLowerCase().endsWith(".xml")) out.push(p);
    }
    return out;
  }

  /**
   * Pull the on-device `gym-screenshot-<point>-<n>.png` bitmaps the androidTest
   * suite wrote (under the app's filesDir/gym-shots) into the run dir. Uses
   * `adb exec-out run-as <app> cat` so it works on a debuggable app without
   * external-storage permissions. A missing shot never changes the verdict.
   */
  private pullScreenshots(
    adb: string,
    scenario: Scenario,
    ctx: AdapterContext,
    logParts: string[],
  ): ScreenshotRef[] {
    const out: ScreenshotRef[] = [];
    const rel = `files/${ON_DEVICE_SHOT_SUBDIR}`;
    const ls = spawnSync(adb, ["shell", "run-as", APP_ID, "ls", "-1", rel], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (ls.status !== 0 || !ls.stdout) {
      logParts.push("[gym] no on-device gym-shots dir (ok — screenshots are advisory)");
      return out;
    }
    const tmp = mkdtempSync(join(tmpdir(), "gym-android-shots-"));
    let n = 0;
    for (const raw of ls.stdout.split("\n")) {
      const fname = raw.trim();
      if (!fname.toLowerCase().endsWith(".png")) continue;
      // `gym-screenshot-<point>-<n>.png` → recover the point name.
      const m = /^gym-screenshot-(.+)-\d+\.png$/.exec(fname);
      const point = m?.[1] ?? "shot";
      // exec-out streams binary cleanly (a plain `shell` would corrupt it).
      const cat = spawnSync(adb, ["exec-out", "run-as", APP_ID, "cat", `${rel}/${fname}`], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (cat.status !== 0 || !cat.stdout) continue;
      try {
        const localTmp = join(tmp, fname);
        writeFileSync(localTmp, cat.stdout);
        const destName = `${scenario.id}-${point}-android-${n++}.png`;
        copyFileSync(localTmp, join(ctx.runDir, "screenshots", destName));
        out.push({ point, path: join("screenshots", destName) });
      } catch (e) {
        logParts.push("[gym] failed to write pulled screenshot " + fname + ": " + String(e));
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    return out;
  }
}
