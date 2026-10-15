/**
 * iOS adapter — WRAPS XCUITest (§12-G3). The app is launched in demo-fixture
 * mode (the `-smoke-mode` launch arg, wired in FlagshipApp) and the verdict is
 * XCTest's own pass/fail per test.
 *
 * One run = ONE build: `prepare` runs `xcodebuild build-for-testing` once into a DerivedData folder, then runs every
 * selected scenario as one `test-without-building` batch per destination (all
 * iPhone scenarios on the iPhone simulator, then the GymIPad ones on the iPad),
 * booting each simulator before its batch and shutting it down after, so only
 * one is ever up. `run` then reads each scenario's verdict out of the batch's
 * `.xcresult`: every test its `-only-testing:` id names must have run, none may
 * fail, and a harness whose tests all skipped is reported as skipped.
 *
 * Screenshots are the `gym-screenshot:<point>` attachments of the scenario's
 * tests, exported from the `.xcresult` for the advisory judge.
 *
 * Environment:
 *   GYM_IOS_DESTINATION / GYM_IOS_IPAD_DESTINATION — full `-destination` strings
 *   GYM_IOS_DERIVED_DATA — keep the build here (reused next run); default is a
 *     temporary folder deleted when the run ends
 *   GYM_IOS_KEEP_SIMULATOR=1 — leave the simulators booted
 *   DEVELOPER_DIR — the Xcode to use; unset, the newest /Applications/Xcode*.app
 *   GYM_IOS_XCODEGEN=1 — regenerate the project from project.yml first
 *
 * Availability requires macOS + Xcode + a Simulator runtime; on any other host
 * the adapter reports unavailable and the runner SKIPS iOS (it never fails it).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Scenario } from "../scenario.js";
import type { ScreenshotRef } from "../results.js";
import type { AdapterContext, AdapterOutcome, SurfaceAdapter } from "./types.js";
import { liveTarget } from "../live.js";

const IOS_APP_DIR_REL = "apps/mobile/ios/App";
const PROJECT = "FlagshipApp.xcodeproj";
const SCHEME = "FlagshipApp";
const UITEST_TARGET = "FlagshipAppUITests";
/** Simulators the gym prefers when present (iPhone 17 Pro / iPad Pro 13-inch M5). */
const PREFERRED_IPHONE = ["iPhone 17 Pro", "iPhone 16 Pro"];
const PREFERRED_IPAD = ["iPad Pro 13-inch (M5)", "iPad Pro 11-inch (M5)", "iPad Pro 13-inch (M4)", "iPad Pro 11-inch (M4)"];
const BATCH_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

let cachedEnv: NodeJS.ProcessEnv | undefined;

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The environment every Xcode tool runs with: an explicit DEVELOPER_DIR wins,
 * else the newest Xcode in /Applications (xcode-select often still points at
 * an older one that can't build the app).
 */
function xcodeEnv(): NodeJS.ProcessEnv {
  if (cachedEnv) return cachedEnv;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.DEVELOPER_DIR && existsSync("/Applications")) {
    let best: { dir: string; version: number[] } | undefined;
    for (const app of readdirSync("/Applications")) {
      if (!/^Xcode.*\.app$/.test(app)) continue;
      const dir = join("/Applications", app, "Contents", "Developer");
      const v = spawnSync("xcodebuild", ["-version"], { encoding: "utf8", env: { ...env, DEVELOPER_DIR: dir }, timeout: 60_000 });
      const m = /^Xcode (\d+(?:\.\d+)*)/m.exec(v.stdout ?? "");
      if (!m) continue;
      const version = m[1]!.split(".").map(Number);
      const newer = !best || compareVersions(version, best.version) > 0;
      if (newer) best = { dir, version };
    }
    if (best) env.DEVELOPER_DIR = best.dir;
  }
  cachedEnv = env;
  return env;
}

/** iPad scenarios run on an iPad `-destination`; every other iOS scenario on the iPhone (§7-C / D8). */
export function isIPadScenario(harness: string): boolean {
  return harness.includes("GymIPad");
}

interface Simulator {
  udid: string;
  name: string;
  state: string;
}

function listSimulators(): Simulator[] {
  const out = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
    env: xcodeEnv(),
    timeout: 30_000,
  });
  if (out.status !== 0 || !out.stdout) return [];
  try {
    const parsed = JSON.parse(out.stdout) as { devices: Record<string, Simulator[]> };
    return Object.values(parsed.devices).flat();
  } catch {
    return [];
  }
}

/**
 * The simulator for one family: the env override wins (a full `-destination`
 * string, booted by xcodebuild itself), else a preferred model, else any of the
 * family, newest runtime first.
 */
function pickDestination(ipad: boolean): { destination: string; udid?: string } | undefined {
  const override = ipad ? process.env.GYM_IOS_IPAD_DESTINATION : process.env.GYM_IOS_DESTINATION;
  if (override) {
    const id = /id=([0-9A-Fa-f-]+)/.exec(override)?.[1];
    return id ? { destination: override, udid: id } : { destination: override };
  }
  const family = listSimulators()
    .filter((d) => d.name.startsWith(ipad ? "iPad" : "iPhone"))
    .reverse();
  const preferred = ipad ? PREFERRED_IPAD : PREFERRED_IPHONE;
  const pick =
    preferred.map((n) => family.find((d) => d.name === n)).find((d) => d !== undefined) ?? family[0];
  return pick ? { destination: `platform=iOS Simulator,id=${pick.udid}`, udid: pick.udid } : undefined;
}

/** One test as the `.xcresult` reports it. */
export interface XcTestCase {
  /** `Class/method` (no parentheses). */
  readonly id: string;
  readonly result: "Passed" | "Failed" | "Skipped" | "Expected Failure" | string;
  readonly durationMs: number;
  readonly messages: readonly string[];
}

/** Flatten `xcresulttool get test-results tests` JSON into its test cases. */
export function parseXcTestCases(json: unknown): XcTestCase[] {
  const out: XcTestCase[] = [];
  type Node = {
    nodeType?: string;
    nodeIdentifier?: string;
    name?: string;
    result?: string;
    durationInSeconds?: number;
    children?: Node[];
  };
  const walk = (n: Node, className: string | undefined): void => {
    if (n.nodeType === "Test Case") {
      const ident = (n.nodeIdentifier ?? `${className ?? "?"}/${n.name ?? "?"}`).replace(/\(\)$/, "");
      const messages: string[] = [];
      const collect = (c: Node): void => {
        if ((c.nodeType === "Failure Message" || c.nodeType === "Skip Message") && c.name) messages.push(c.name);
        for (const k of c.children ?? []) collect(k);
      };
      for (const c of n.children ?? []) collect(c);
      out.push({
        id: ident,
        result: n.result ?? "unknown",
        durationMs: Math.round((n.durationInSeconds ?? 0) * 1000),
        messages,
      });
      return;
    }
    const nextClass = n.nodeType === "Test Suite" ? (n.name ?? className) : className;
    for (const c of n.children ?? []) walk(c, nextClass);
  };
  const root = json as { testNodes?: Node[] };
  for (const n of root.testNodes ?? []) walk(n, undefined);
  return out;
}

/** The test cases a scenario's `-only-testing:` id (`Target/Class[/method]`) selects. */
export function testsForHarness(harness: string, cases: readonly XcTestCase[]): XcTestCase[] {
  const parts = harness.split("/").filter(Boolean);
  const cls = parts[1];
  const method = parts[2];
  if (!cls) return [...cases];
  return cases.filter((c) => {
    const [cCls, cMethod] = c.id.split("/");
    return cCls === cls && (method === undefined || cMethod === method);
  });
}

/** The verdict for one scenario from its test cases (a 0-test match is a FAIL, never a pass). */
export function verdictFor(
  harness: string,
  cases: readonly XcTestCase[],
): { passed: boolean; skipped: boolean; reason: string; durationMs: number; tests: XcTestCase[] } {
  const tests = testsForHarness(harness, cases);
  const durationMs = tests.reduce((a, t) => a + t.durationMs, 0);
  if (tests.length === 0) {
    return {
      passed: false,
      skipped: false,
      reason: `\`-only-testing:${harness}\` matched no test (missing/misnamed harness?) — NOT claiming a pass`,
      durationMs,
      tests,
    };
  }
  const failed = tests.filter((t) => t.result === "Failed");
  const ran = tests.filter((t) => t.result !== "Skipped");
  if (failed.length > 0) {
    return { passed: false, skipped: false, reason: `${failed.length} test(s) failed`, durationMs, tests };
  }
  if (ran.length === 0) {
    const why = tests.flatMap((t) => t.messages)[0] ?? "every test skipped";
    return { passed: false, skipped: true, reason: why, durationMs, tests };
  }
  return { passed: true, skipped: false, reason: `${ran.length} test(s) passed`, durationMs, tests };
}

interface Batch {
  cases: XcTestCase[];
  /** Exported attachments: test id → [{point, file}] (absolute paths in `exportDir`). */
  shots: Map<string, Array<{ point: string; file: string }>>;
  log: string;
  /** Set when the batch produced no readable result at all. */
  error?: string;
}

export class IosAdapter implements SurfaceAdapter {
  readonly surface = "ios" as const;

  private derivedData: string | undefined;
  private ownsDerivedData = false;
  private workDir: string | undefined;
  private readonly batches = new Map<string, Batch>();
  private readonly bootedByUs = new Set<string>();

  async available(ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "darwin") return { ok: false, reason: "iOS gym requires macOS" };
    if (!which("xcodebuild")) return { ok: false, reason: "xcodebuild not on PATH (install Xcode)" };
    if (!which("xcrun")) return { ok: false, reason: "xcrun not on PATH" };
    if (!existsSync(join(ctx.repoRoot, IOS_APP_DIR_REL))) {
      return { ok: false, reason: `iOS app dir missing at ${IOS_APP_DIR_REL}` };
    }
    if (!pickDestination(false) && !process.env.GYM_IOS_DESTINATION) {
      return { ok: false, reason: "no iPhone simulator installed (Xcode → Settings → Platforms)" };
    }
    return { ok: true };
  }

  async prepare(scenarios: readonly Scenario[], ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    const appDir = join(ctx.repoRoot, IOS_APP_DIR_REL);
    this.workDir = mkdtempSync(join(tmpdir(), "gym-ios-"));
    const keep = process.env.GYM_IOS_DERIVED_DATA;
    if (keep) {
      mkdirSync(keep, { recursive: true });
      this.derivedData = keep;
    } else {
      this.derivedData = join(this.workDir, "DerivedData");
      this.ownsDerivedData = true;
    }

    // The committed project is the source of truth (a test file missing from
    // it fails its scenario as "matched no test"). Regenerating rewrites the
    // project with fresh ids on every run, so only do it when asked.
    if (process.env.GYM_IOS_XCODEGEN === "1" && which("xcodegen")) {
      spawnSync("xcodegen", ["generate", "--quiet"], { cwd: appDir, encoding: "utf8", env: xcodeEnv(), timeout: 120_000 });
    }

    const build = spawnSync(
      "xcodebuild",
      [
        "build-for-testing",
        "-project", PROJECT,
        "-scheme", SCHEME,
        "-destination", "generic/platform=iOS Simulator",
        "-derivedDataPath", this.derivedData,
        "-quiet",
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: appDir, encoding: "utf8", env: xcodeEnv(), timeout: 90 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 },
    );
    if (build.status !== 0) {
      const tail = ((build.stdout ?? "") + (build.stderr ?? "")).split("\n").filter((l) => /error/.test(l));
      return { ok: false, reason: "build-for-testing failed:\n" + tail.slice(-20).join("\n") };
    }

    const iphone = scenarios.filter((s) => !isIPadScenario(s.harness));
    const ipad = scenarios.filter((s) => isIPadScenario(s.harness));
    for (const [group, isPad] of [[iphone, false], [ipad, true]] as const) {
      if (group.length === 0) continue;
      const dest = pickDestination(isPad);
      if (!dest) {
        const batch: Batch = { cases: [], shots: new Map(), log: "", error: `no ${isPad ? "iPad" : "iPhone"} simulator installed` };
        for (const s of group) this.batches.set(s.id, batch);
        continue;
      }
      const batch = this.runBatch(appDir, dest, group);
      for (const s of group) this.batches.set(s.id, batch);
    }
    return { ok: true };
  }

  async run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome> {
    const batch = this.batches.get(scenario.id);
    if (!batch) {
      return { passed: false, durationMs: 0, screenshots: [], log: "[gym] scenario was not part of the prepared batch" };
    }
    if (batch.error) {
      return { passed: false, durationMs: 0, screenshots: [], log: `[gym] ${batch.error}\n${batch.log}`.slice(-6000) };
    }
    const v = verdictFor(scenario.harness, batch.cases);
    const lines = [`[gym] ${v.reason}`];
    for (const t of v.tests) {
      lines.push(`  ${t.result.padEnd(8)} ${t.id} (${t.durationMs}ms)`);
      for (const m of t.messages) lines.push(`      ${m}`);
    }
    const screenshots = this.copyShots(scenario, v.tests, ctx);
    return {
      passed: v.passed,
      ...(v.skipped ? { skipped: true, skipReason: v.reason } : {}),
      durationMs: v.durationMs,
      screenshots,
      log: lines.join("\n").slice(-6000),
    };
  }

  async finish(): Promise<void> {
    if (process.env.GYM_IOS_KEEP_SIMULATOR !== "1") {
      for (const udid of this.bootedByUs) {
        spawnSync("xcrun", ["simctl", "shutdown", udid], { encoding: "utf8", env: xcodeEnv(), timeout: 120_000 });
      }
    }
    this.bootedByUs.clear();
    this.batches.clear();
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    if (this.ownsDerivedData && this.derivedData) rmSync(this.derivedData, { recursive: true, force: true });
    this.workDir = undefined;
    this.derivedData = undefined;
    this.ownsDerivedData = false;
  }

  /** Boot (if needed), run the group as one test-without-building, shut the simulator down. */
  private runBatch(appDir: string, dest: { destination: string; udid?: string }, group: readonly Scenario[]): Batch {
    const log: string[] = [`[gym] destination: ${dest.destination}`];
    // Only one simulator up at a time: shut down any other booted one first.
    for (const sim of listSimulators()) {
      if (sim.state === "Booted" && sim.udid !== dest.udid) {
        spawnSync("xcrun", ["simctl", "shutdown", sim.udid], { encoding: "utf8", env: xcodeEnv(), timeout: 120_000 });
      }
    }
    if (dest.udid) {
      const state = listSimulators().find((d) => d.udid === dest.udid)?.state;
      if (state !== "Booted") {
        spawnSync("xcrun", ["simctl", "boot", dest.udid], { encoding: "utf8", env: xcodeEnv(), timeout: 300_000 });
        this.bootedByUs.add(dest.udid);
      }
      spawnSync("xcrun", ["simctl", "bootstatus", dest.udid, "-b"], { encoding: "utf8", env: xcodeEnv(), timeout: 600_000 });
    }

    const resultBundle = join(this.workDir!, `batch-${Date.now()}.xcresult`);
    const env: NodeJS.ProcessEnv = { ...xcodeEnv() };
    // Live scenarios get the apex the runner probed; without it GymLiveTests skips.
    if (group.some((s) => s.backend === "live")) {
      env.TEST_RUNNER_GYM_LIVE_CONTROL_APEX = liveTarget().controlApex;
    }
    const harnesses = [...new Set(group.map((s) => s.harness))];
    const xcb = spawnSync(
      "xcodebuild",
      [
        "test-without-building",
        "-project", PROJECT,
        "-scheme", SCHEME,
        "-destination", dest.destination,
        "-derivedDataPath", this.derivedData!,
        "-resultBundlePath", resultBundle,
        "-parallel-testing-enabled", "NO",
        ...harnesses.map((h) => "-only-testing:" + h),
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: appDir, encoding: "utf8", env, timeout: BATCH_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 },
    );
    const out = (xcb.stdout ?? "") + (xcb.stderr ?? "");
    log.push(out.split("\n").filter((l) => /error:|Test Case .*(failed|skipped)|\*\* TEST/.test(l)).join("\n"));

    if (dest.udid && this.bootedByUs.has(dest.udid) && process.env.GYM_IOS_KEEP_SIMULATOR !== "1") {
      spawnSync("xcrun", ["simctl", "shutdown", dest.udid], { encoding: "utf8", env: xcodeEnv(), timeout: 120_000 });
      this.bootedByUs.delete(dest.udid);
    }

    if (!existsSync(resultBundle)) {
      return { cases: [], shots: new Map(), log: log.join("\n"), error: `xcodebuild produced no result bundle (exit ${xcb.status})` };
    }
    const tests = spawnSync(
      "xcrun",
      ["xcresulttool", "get", "test-results", "tests", "--path", resultBundle, "--format", "json"],
      { encoding: "utf8", env: xcodeEnv(), timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
    );
    let cases: XcTestCase[] = [];
    try {
      cases = parseXcTestCases(JSON.parse(tests.stdout ?? "{}"));
    } catch (e) {
      return { cases: [], shots: new Map(), log: log.join("\n"), error: "could not read the test results: " + String(e) };
    }
    const shots = this.exportShots(resultBundle, log);
    return { cases, shots, log: log.join("\n") };
  }

  /**
   * Export the `gym-screenshot:<point>` attachments. XCUITest strips the colon
   * and appends `_<index>_<uuid>.png`, so `gym-screenshot:cold-launch` lands as
   * `gym-screenshotcold-launch_0_<uuid>.png`.
   */
  private exportShots(resultBundle: string, log: string[]): Batch["shots"] {
    const shots: Batch["shots"] = new Map();
    const dump = join(this.workDir!, `shots-${Date.now()}`);
    mkdirSync(dump, { recursive: true });
    const exp = spawnSync(
      "xcrun",
      ["xcresulttool", "export", "attachments", "--path", resultBundle, "--output-path", dump],
      { encoding: "utf8", env: xcodeEnv(), timeout: 600_000 },
    );
    if (exp.status !== 0) log.push("[gym] attachment export failed: " + (exp.stderr ?? "").slice(0, 300));
    const manifestPath = join(dump, "manifest.json");
    if (!existsSync(manifestPath)) return shots;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{
        testIdentifier?: string;
        attachments?: Array<{ exportedFileName?: string; suggestedHumanReadableName?: string }>;
      }>;
      for (const test of manifest) {
        const id = (test.testIdentifier ?? "").replace(/\(\)$/, "");
        for (const a of test.attachments ?? []) {
          const m = /^gym-screenshot(.+?)_\d+_[0-9A-Fa-f-]+\.png$/.exec(a.suggestedHumanReadableName ?? "");
          if (!m || !a.exportedFileName) continue;
          const list = shots.get(id) ?? [];
          list.push({ point: m[1]!, file: join(dump, a.exportedFileName) });
          shots.set(id, list);
        }
      }
    } catch (e) {
      log.push("[gym] screenshot manifest parse failed: " + String(e));
    }
    return shots;
  }

  private copyShots(scenario: Scenario, tests: readonly XcTestCase[], ctx: AdapterContext): ScreenshotRef[] {
    const out: ScreenshotRef[] = [];
    const batch = this.batches.get(scenario.id);
    if (!batch) return out;
    let n = 0;
    for (const t of tests) {
      for (const shot of batch.shots.get(t.id) ?? []) {
        if (!existsSync(shot.file)) continue;
        const fname = `${scenario.id}-${shot.point}-ios-${n++}.png`;
        copyFileSync(shot.file, join(ctx.runDir, "screenshots", fname));
        out.push({ point: shot.point, path: join("screenshots", fname) });
      }
    }
    return out;
  }
}
