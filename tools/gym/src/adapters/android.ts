/**
 * Android adapter — WRAPS the Compose-UI-Test + Espresso instrumentation suite
 * (§12-G3 / §10 Phase-5), launching MainActivity in smoke mode (the
 * `flagship.smoke*` Intent extras, wired in MainActivity -> SmokeMode).
 *
 * One run = ONE gradle invocation: `prepare` boots the AVD headless when no
 * device is online (GYM_ANDROID_AVD, else `flagship_gym`, else the first AVD),
 * then runs `:app:connectedDebugAndroidTest` once for every selected scenario
 * (a comma-separated class[#method] list). `run` reads each scenario's verdict
 * from the connected-test JUnit XML: every test it names must have run and
 * passed. `finish` kills the emulator if the gym booted it. Bitmaps captured
 * on-device (`gym-screenshot-<point>-<n>.png`, named by the test) are pulled
 * for the advisory judge.
 *
 * AVAILABILITY (detect-and-skip): needs a JDK 17 (GYM_ANDROID_JAVA_HOME /
 * JAVA_HOME / openjdk@17) and an online device or an AVD to boot. Without
 * either the runner SKIPS Android cleanly (never fails it).
 */

import { spawn, spawnSync } from "node:child_process";
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

function listAvds(androidHome: string | undefined): string[] {
  const emulator = androidHome ? join(androidHome, "emulator", "emulator") : undefined;
  if (!emulator || !existsSync(emulator)) return [];
  const out = spawnSync(emulator, ["-list-avds"], { encoding: "utf8", timeout: 15_000 });
  if (out.status !== 0) return [];
  return (out.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("INFO"));
}

/** The AVD the gym boots: GYM_ANDROID_AVD, else `flagship_gym`, else the first one. */
function pickAvd(androidHome: string | undefined): string | undefined {
  const avds = listAvds(androidHome);
  const wanted = process.env.GYM_ANDROID_AVD;
  if (wanted) return avds.includes(wanted) ? wanted : undefined;
  return avds.includes("flagship_gym") ? "flagship_gym" : avds[0];
}

/** One test as the connected-test XML reports it. */
export interface JUnitCase {
  /** Fully-qualified class name. */
  readonly className: string;
  readonly name: string;
  readonly result: "passed" | "failed" | "skipped";
  readonly durationMs: number;
  readonly message?: string;
}

/** Parse every <testcase> of a JUnit XML document. */
export function parseJUnitCases(xml: string): JUnitCase[] {
  const out: JUnitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? "";
    const body = m[3] ?? "";
    const attr = (k: string): string => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const failure = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const message = failure
      ? /\bmessage="([^"]*)"/.exec(failure[2] ?? "")?.[1] || (failure[4] ?? "").split("\n")[0] || "failed"
      : undefined;
    out.push({
      className: attr("classname"),
      name: attr("name"),
      result: failure ? "failed" : skipped ? "skipped" : "passed",
      durationMs: Math.round(Number(attr("time") || "0") * 1000),
      ...(message !== undefined ? { message: decodeXml(message) } : {}),
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The cases a `class[#method]` harness selects. */
export function casesForHarness(harness: string, cases: readonly JUnitCase[]): JUnitCase[] {
  const [cls, method] = harness.split("#");
  return cases.filter((c) => c.className === cls && (method === undefined || c.name === method));
}

export class AndroidAdapter implements SurfaceAdapter {
  readonly surface = "android" as const;

  private cases: JUnitCase[] = [];
  private batchError: string | undefined;
  private batchLog = "";
  private bootedSerial: string | undefined;
  private emulatorPid: number | undefined;

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
    if (!adb) return { ok: false, reason: "no adb (install the Android SDK platform-tools)" };
    if (hasOnlineDevice(adb)) return { ok: true };
    if (pickAvd(androidHome)) return { ok: true };
    return {
      ok: false,
      reason:
        "no Android device online and no AVD to boot — create one (e.g. `flagship_gym`) " +
        "or run the compile gate `:app:assembleDebugAndroidTest` instead.",
    };
  }

  async prepare(scenarios: readonly Scenario[], ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    const androidDir = join(ctx.repoRoot, ANDROID_DIR_REL);
    const androidHome = resolveAndroidHome();
    const adb = adbPath(androidHome)!;
    const env: NodeJS.ProcessEnv = { ...process.env };
    const javaHome = resolveJavaHome();
    if (javaHome) env.JAVA_HOME = javaHome;
    if (androidHome) env.ANDROID_HOME = androidHome;

    if (!hasOnlineDevice(adb)) {
      const booted = this.bootEmulator(androidHome, adb);
      if (!booted.ok) return booted;
    }
    // Animations make Compose idling flaky on a cold emulator.
    for (const k of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
      spawnSync(adb, ["shell", "settings", "put", "global", k, "0"], { encoding: "utf8", timeout: 30_000 });
    }
    spawnSync(adb, ["shell", "run-as", APP_ID, "rm", "-rf", `files/${ON_DEVICE_SHOT_SUBDIR}`], {
      encoding: "utf8",
      timeout: 30_000,
    });

    const resultsDir = join(androidDir, "app", "build", "outputs", "androidTest-results", "connected");
    rmSync(resultsDir, { recursive: true, force: true });
    const classes = [...new Set(scenarios.map((s) => s.harness))].join(",");
    const gradle = spawnSync(
      "./gradlew",
      [
        ":app:connectedDebugAndroidTest",
        `-Pandroid.testInstrumentationRunnerArguments.class=${classes}`,
        "--console=plain",
      ],
      { cwd: androidDir, encoding: "utf8", env, timeout: 4 * 60 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 },
    );
    const out = (gradle.stdout ?? "") + (gradle.stderr ?? "");
    this.batchLog = out
      .split("\n")
      .filter((l) => /FAILED|failed|error:|BUILD|Tests? on/.test(l))
      .slice(-80)
      .join("\n");
    this.cases = [];
    if (existsSync(resultsDir)) {
      for (const f of this.findXml(resultsDir)) {
        try {
          this.cases.push(...parseJUnitCases(readFileSync(f, "utf8")));
        } catch {
          // An unreadable report leaves its tests unmatched, which fails them.
        }
      }
    }
    if (this.cases.length === 0) {
      this.batchError = `connectedDebugAndroidTest produced no test results (exit ${gradle.status})`;
    }
    this.pullShots(adb, ctx);
    return { ok: true };
  }

  async run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome> {
    if (this.batchError) {
      return { passed: false, durationMs: 0, screenshots: [], log: `[gym] ${this.batchError}\n${this.batchLog}`.slice(-6000) };
    }
    const tests = casesForHarness(scenario.harness, this.cases);
    const durationMs = tests.reduce((a, t) => a + t.durationMs, 0);
    const lines: string[] = [];
    let passed: boolean;
    let skipped = false;
    if (tests.length === 0) {
      passed = false;
      lines.push(`[gym] \`${scenario.harness}\` matched no test (missing/misnamed harness?) — NOT claiming a pass`);
    } else if (tests.some((t) => t.result === "failed")) {
      passed = false;
      lines.push(`[gym] ${tests.filter((t) => t.result === "failed").length} test(s) failed`);
    } else if (tests.every((t) => t.result === "skipped")) {
      passed = false;
      skipped = true;
      lines.push("[gym] every test skipped");
    } else {
      passed = true;
      lines.push(`[gym] ${tests.length} test(s) passed`);
    }
    for (const t of tests) {
      lines.push(`  ${t.result.padEnd(8)} ${t.className.split(".").pop()}#${t.name} (${t.durationMs}ms)`);
      if (t.message) lines.push(`      ${t.message.slice(0, 600)}`);
    }
    const screenshots = this.screenshotsFor(scenario, tests, ctx);
    return {
      passed,
      ...(skipped ? { skipped: true, skipReason: "every test skipped" } : {}),
      durationMs,
      screenshots,
      log: lines.join("\n").slice(-6000),
    };
  }

  async finish(): Promise<void> {
    const adb = adbPath(resolveAndroidHome());
    if (adb && this.bootedSerial && process.env.GYM_ANDROID_KEEP_EMULATOR !== "1") {
      spawnSync(adb, ["-s", this.bootedSerial, "emu", "kill"], { encoding: "utf8", timeout: 60_000 });
      for (let i = 0; i < 30 && hasOnlineDevice(adb); i++) spawnSync("sleep", ["2"]);
      if (this.emulatorPid) {
        try {
          process.kill(this.emulatorPid);
        } catch {
          // Already gone.
        }
      }
    }
    this.bootedSerial = undefined;
    this.emulatorPid = undefined;
    this.cases = [];
    this.batchError = undefined;
    this.shotFiles = new Map();
    if (this.shotTmp) rmSync(this.shotTmp, { recursive: true, force: true });
    this.shotTmp = undefined;
  }

  /** Boot the AVD headless and wait for Android to finish booting (≤ 6 min). */
  private bootEmulator(androidHome: string | undefined, adb: string): { ok: boolean; reason?: string } {
    const avd = pickAvd(androidHome);
    if (!avd || !androidHome) return { ok: false, reason: "no AVD to boot (set GYM_ANDROID_AVD)" };
    const emulator = join(androidHome, "emulator", "emulator");
    const child = spawn(
      emulator,
      ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-gpu", "swiftshader_indirect"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    this.emulatorPid = child.pid;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      const serial = this.onlineEmulatorSerial(adb);
      if (serial) {
        const prop = spawnSync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
          encoding: "utf8",
          timeout: 15_000,
        });
        if ((prop.stdout ?? "").trim() === "1") {
          this.bootedSerial = serial;
          return { ok: true };
        }
      }
      spawnSync("sleep", ["3"]);
    }
    return { ok: false, reason: `the ${avd} emulator did not finish booting within 6 minutes` };
  }

  private onlineEmulatorSerial(adb: string): string | undefined {
    const out = spawnSync(adb, ["devices"], { encoding: "utf8", timeout: 15_000 });
    for (const line of (out.stdout ?? "").split("\n").slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial?.startsWith("emulator-") && state === "device") return serial;
    }
    return undefined;
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

  /** `<Class>.<method>` → [{point, local file}] pulled off the device. */
  private shotFiles = new Map<string, Array<{ point: string; file: string }>>();
  private shotTmp: string | undefined;

  /**
   * Pull every `gym-screenshot-<Class>.<method>--<point>-<n>.png` the suite
   * wrote under the app's filesDir/gym-shots. `exec-out run-as … cat` works on
   * a debuggable app without storage permissions and streams binary cleanly.
   */
  private pullShots(adb: string, ctx: AdapterContext): void {
    void ctx;
    const rel = `files/${ON_DEVICE_SHOT_SUBDIR}`;
    const ls = spawnSync(adb, ["shell", "run-as", APP_ID, "ls", "-1", rel], { encoding: "utf8", timeout: 30_000 });
    if (ls.status !== 0 || !ls.stdout) return;
    this.shotTmp = mkdtempSync(join(tmpdir(), "gym-android-shots-"));
    for (const raw of ls.stdout.split("\n")) {
      const fname = raw.trim();
      const m = /^gym-screenshot-(.+?)--(.+)-\d+\.png$/.exec(fname);
      if (!m) continue;
      const cat = spawnSync(adb, ["exec-out", "run-as", APP_ID, "cat", `${rel}/${fname}`], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (cat.status !== 0 || !cat.stdout) continue;
      const local = join(this.shotTmp, fname);
      writeFileSync(local, cat.stdout);
      const list = this.shotFiles.get(m[1]!) ?? [];
      list.push({ point: m[2]!, file: local });
      this.shotFiles.set(m[1]!, list);
    }
  }

  private screenshotsFor(scenario: Scenario, tests: readonly JUnitCase[], ctx: AdapterContext): ScreenshotRef[] {
    const out: ScreenshotRef[] = [];
    let n = 0;
    for (const t of tests) {
      const key = `${t.className.split(".").pop()}.${t.name}`;
      for (const shot of this.shotFiles.get(key) ?? []) {
        const destName = `${scenario.id}-${shot.point}-android-${n++}.png`;
        copyFileSync(shot.file, join(ctx.runDir, "screenshots", destName));
        out.push({ point: shot.point, path: join("screenshots", destName) });
      }
    }
    return out;
  }
}
