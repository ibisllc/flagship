import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Scenario } from "../src/scenario.js";
import { isDestructive } from "../src/scenario.js";
import { selectScenarios, runGym } from "../src/runner.js";
import { guardScenario, ALLOWED_DEMO_USERNAMES } from "../src/guardrail.js";
import { summarize, renderText, runDirName } from "../src/results.js";
import { ALL_SCENARIOS } from "../src/suites.js";
import {
  LIVE_SCENARIOS,
  liveEnvReachable,
  liveTarget,
  GYM_LIVE_DEMO_USERNAME,
  DEFAULT_GYM_CONTROL_APEX,
  DEFAULT_GYM_SERVICES_APEX,
} from "../src/live.js";
import { defaultAiHooks, type AiFinding } from "../src/ai/hooks.js";
import { byokConfigFromEnv, resolveAiHooks } from "../src/ai/byokSeam.js";
import type { SurfaceAdapter, AdapterContext, AdapterOutcome } from "../src/adapters/types.js";

// A fake adapter so the runner is testable with no Xcode / Playwright / AVD.
function fakeAdapter(
  surface: Scenario["surface"],
  opts: { available?: boolean; passed?: boolean; missing?: string[] } = {},
): SurfaceAdapter {
  return {
    surface,
    async available(): Promise<{ ok: boolean; reason?: string }> {
      return opts.available === false ? { ok: false, reason: "fake unavailable" } : { ok: true };
    },
    async run(s, _ctx: AdapterContext): Promise<AdapterOutcome> {
      return {
        passed: opts.passed ?? true,
        durationMs: 1,
        screenshots: [{ point: "p0", path: `screenshots/${s.id}-p0.png` }],
        log: "fake",
        ...(opts.missing ? { missingHandles: opts.missing } : {}),
      };
    },
  };
}

const baseScenario: Scenario = {
  id: "x",
  surface: "web",
  tier: "every-merge",
  backend: "fixture",
  goal: "g",
  steps: [],
  assertions: [],
  screenshotPoints: [],
  harness: "h",
};

describe("scenario selection (tier + surface)", () => {
  const scenarios: Scenario[] = [
    { ...baseScenario, id: "em-web", surface: "web", tier: "every-merge" },
    { ...baseScenario, id: "em-ios", surface: "ios", tier: "every-merge" },
    { ...baseScenario, id: "total-web", surface: "web", tier: "total" },
  ];

  it("every-merge selects only every-merge scenarios", () => {
    const got = selectScenarios(scenarios, "every-merge").map((s) => s.id);
    expect(got).toEqual(["em-web", "em-ios"]);
  });

  it("total selects all scenarios (every-merge is a subset of total)", () => {
    const got = selectScenarios(scenarios, "total").map((s) => s.id).sort();
    expect(got).toEqual(["em-ios", "em-web", "total-web"]);
  });

  it("surface filter narrows the selection", () => {
    const got = selectScenarios(scenarios, "total", ["ios"]).map((s) => s.id);
    expect(got).toEqual(["em-ios"]);
  });
});

describe("demo-only destructive guardrail (§7-G)", () => {
  it("non-destructive scenarios are always allowed", () => {
    expect(guardScenario(baseScenario).allowed).toBe(true);
  });

  it("a destructive scenario targeting a demo username is allowed", () => {
    const s: Scenario = {
      ...baseScenario,
      destructive: { destructive: true, demoUsername: "smoketest" },
    };
    expect(isDestructive(s)).toBe(true);
    expect(guardScenario(s).allowed).toBe(true);
  });

  it("FAIL-CLOSES a destructive scenario targeting a non-demo username", () => {
    const s: Scenario = {
      ...baseScenario,
      destructive: { destructive: true, demoUsername: "realuser" },
    };
    const v = guardScenario(s);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("demo-only guardrail");
  });

  it("the allowed-demo set holds the fixed fixture identities", () => {
    expect(ALLOWED_DEMO_USERNAMES.has("smoketest")).toBe(true);
    expect(ALLOWED_DEMO_USERNAMES.has("realuser")).toBe(false);
  });
});

describe("summary + artifact rendering", () => {
  it("ok iff every considered scenario passes and at least one ran", () => {
    const now = new Date();
    const pass = summarize({
      startedAt: now,
      finishedAt: now,
      suite: "s",
      tier: "every-merge",
      surfaces: ["web"],
      runDir: "/tmp/x",
      results: [
        {
          id: "a", surface: "web", tier: "every-merge", goal: "g",
          passed: true, skipped: false, durationMs: 1, screenshots: [], aiFindings: [],
        },
      ],
    });
    expect(pass.ok).toBe(true);
    expect(pass.totals).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });

    const fail = summarize({
      startedAt: now, finishedAt: now, suite: "s", tier: "every-merge",
      surfaces: ["web"], runDir: "/tmp/x",
      results: [
        { id: "a", surface: "web", tier: "every-merge", goal: "g", passed: false, skipped: false, durationMs: 1, screenshots: [], aiFindings: [] },
      ],
    });
    expect(fail.ok).toBe(false);
  });

  it("a run with only skipped scenarios is NOT ok (it proves nothing)", () => {
    const now = new Date();
    const s = summarize({
      startedAt: now, finishedAt: now, suite: "s", tier: "every-merge",
      surfaces: ["ios"], runDir: "/tmp/x",
      results: [
        { id: "a", surface: "ios", tier: "every-merge", goal: "g", passed: false, skipped: true, skipReason: "no xcode", durationMs: 0, screenshots: [], aiFindings: [] },
      ],
    });
    expect(s.ok).toBe(false);
    expect(s.totals.skipped).toBe(1);
  });

  it("renderText labels the verdict and marks AI lines advisory", () => {
    const now = new Date();
    const finding: AiFinding = { role: "judge", severity: "info", scenarioId: "a", message: "looks fine" };
    const s = summarize({
      startedAt: now, finishedAt: now, suite: "smoke", tier: "every-merge",
      surfaces: ["web"], runDir: "/tmp/x",
      results: [
        { id: "a", surface: "web", tier: "every-merge", goal: "g", passed: true, skipped: false, durationMs: 5, screenshots: [{ point: "p0", path: "screenshots/a.png" }], aiFindings: [finding] },
      ],
    });
    const txt = renderText(s);
    expect(txt).toContain("[PASS] web/a");
    expect(txt).toContain("ai(judge/info): looks fine [advisory]");
    expect(txt).toContain("verdict: OK");
    expect(txt).toContain("ADVISORY");
  });

  it("runDirName is filesystem-safe (no colons/dots from the ISO timestamp)", () => {
    const name = runDirName(new Date("2026-06-17T08:09:10.123Z"));
    expect(name).not.toMatch(/[:.]/);
    expect(name).toContain("2026-06-17");
  });
});

describe("AI hooks are advisory + default to a deterministic no-op", () => {
  it("default hooks need no provider key and never throw into the gate", async () => {
    const hooks = defaultAiHooks();
    const j = await hooks.judge.judge({ scenarioId: "a", point: "p0", screenshotPath: "/x.png", goal: "g" });
    expect(j.every((f) => f.role === "judge")).toBe(true);
    const n = await hooks.navigator.navigate({ scenarioId: "a", goal: "g", missingHandle: "btn" });
    expect(n.findings[0]!.role).toBe("navigate");
    expect(n.suggestedHandle).toBeUndefined();
  });

  it("BYOK config is null without a key, populated with one (the seam)", () => {
    expect(byokConfigFromEnv({})).toBeNull();
    const cfg = byokConfigFromEnv({ GYM_AI_API_KEY: "k", GYM_AI_PROVIDER: "anthropic" });
    expect(cfg?.provider).toBe("anthropic");
    // resolveAiHooks falls back to the no-op hooks when no key is present.
    expect(resolveAiHooks({}).judge.name).toBe("noop-judge");
    expect(resolveAiHooks({ GYM_AI_API_KEY: "k" }).judge.name).toContain("byok-judge");
  });
});

describe("runGym end-to-end (fake adapters) writes a real artifact", () => {
  it("passes, layers advisory AI, and writes summary.json + summary.txt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      const summary = await runGym([{ ...baseScenario, id: "w", surface: "web" }], {
        repoRoot,
        suite: "smoke",
        tier: "every-merge",
        adapters: { web: fakeAdapter("web"), ios: fakeAdapter("ios"), android: fakeAdapter("android") },
        aiHooks: defaultAiHooks(),
        log: () => {},
      });
      expect(summary.ok).toBe(true);
      expect(summary.results[0]!.passed).toBe(true);
      // The advisory judge ran over the captured screenshot.
      expect(summary.results[0]!.aiFindings.some((f) => f.role === "judge")).toBe(true);
      expect(existsSync(join(summary.runDir, "summary.json"))).toBe(true);
      expect(existsSync(join(summary.runDir, "summary.txt"))).toBe(true);
      const json = JSON.parse(readFileSync(join(summary.runDir, "summary.json"), "utf8"));
      expect(json.totals.passed).toBe(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("SKIPS (never fails) a surface whose toolchain is unavailable", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      const summary = await runGym([{ ...baseScenario, id: "i", surface: "ios" }], {
        repoRoot, suite: "smoke", tier: "every-merge",
        adapters: { web: fakeAdapter("web"), ios: fakeAdapter("ios", { available: false }), android: fakeAdapter("android") },
        log: () => {},
      });
      expect(summary.results[0]!.skipped).toBe(true);
      expect(summary.results[0]!.skipReason).toContain("unavailable");
      // A run where everything skipped is not ok (proves nothing).
      expect(summary.ok).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("the deterministic verdict ignores AI findings (advisory only)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      // Adapter FAILS the scenario but reports a missing handle (navigator
      // would annotate). The verdict must be FAIL regardless of AI output.
      const summary = await runGym([{ ...baseScenario, id: "w", surface: "web" }], {
        repoRoot, suite: "smoke", tier: "every-merge",
        adapters: { web: fakeAdapter("web", { passed: false, missing: ["gone-btn"] }), ios: fakeAdapter("ios"), android: fakeAdapter("android") },
        log: () => {},
      });
      expect(summary.ok).toBe(false);
      expect(summary.results[0]!.passed).toBe(false);
      expect(summary.results[0]!.aiFindings.some((f) => f.role === "navigate")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("the shipped gym suite (§12-G4 every-merge + §12-G5 total tranche)", () => {
  const web = ALL_SCENARIOS.filter((s) => s.surface === "web");
  const ios = ALL_SCENARIOS.filter((s) => s.surface === "ios");
  const android = ALL_SCENARIOS.filter((s) => s.surface === "android");
  const everyMerge = ALL_SCENARIOS.filter((s) => s.tier === "every-merge");
  const total = ALL_SCENARIOS.filter((s) => s.tier === "total");

  it("is entirely fixture-backed (NO-backend; the live Tier-2 slice is G6, not here)", () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThan(0);
    for (const s of ALL_SCENARIOS) {
      expect(s.backend).toBe("fixture");
      expect(s.tier === "every-merge" || s.tier === "total").toBe(true);
    }
  });

  it("the every-merge tranche is the curated cheap subset (web + iOS, ~10+ / ~6+)", () => {
    // G4: core launch + per-tab render + create-server + validation + slivers.
    const emWeb = everyMerge.filter((s) => s.surface === "web");
    const emIos = everyMerge.filter((s) => s.surface === "ios");
    expect(emWeb.length).toBeGreaterThanOrEqual(10);
    expect(emIos.length).toBeGreaterThanOrEqual(6);
  });

  it("the total tranche adds a substantial higher-value batch (§12-G5: 15+ across web + iOS)", () => {
    // G5: the §6 D1/D2/D3/D4/D5 rows a fixture can seed + assert (NO backend).
    const tWeb = total.filter((s) => s.surface === "web");
    const tIos = total.filter((s) => s.surface === "ios");
    expect(tWeb.length).toBeGreaterThanOrEqual(8);
    expect(tIos.length).toBeGreaterThanOrEqual(8);
    expect(total.length).toBeGreaterThanOrEqual(15);
  });

  it("every-merge is a STRICT subset of total (a total run includes every every-merge scenario)", () => {
    // The runner selects every-merge ⊆ total (selectScenarios); the registry
    // must therefore carry every every-merge scenario AND the total-only ones.
    const totalRun = selectScenarios(ALL_SCENARIOS, "total");
    const everyMergeRun = selectScenarios(ALL_SCENARIOS, "every-merge");
    for (const s of everyMergeRun) {
      expect(totalRun.some((t) => t.id === s.id)).toBe(true);
    }
    expect(totalRun.length).toBe(ALL_SCENARIOS.length);
    expect(everyMergeRun.length).toBe(everyMerge.length);
  });

  it("leaves Android stubbed (Phase-5; the adapter SKIPS it, never fails it)", () => {
    expect(android.length).toBe(0);
  });

  it("every scenario id is unique + every web harness grep title is unique", () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The web adapter selects a Playwright spec by its grep title (anchored,
    // escaped), so each web scenario's harness must be a unique title (else the
    // grep matches several). This holds ACROSS both tranches (smoke + total
    // specs share the one gym config's testMatch).
    const webTitles = web.map((s) => s.harness);
    expect(new Set(webTitles).size).toBe(webTitles.length);
    // iOS `-only-testing:` ids must also be unique across tranches.
    const iosIds = ios.map((s) => s.harness);
    expect(new Set(iosIds).size).toBe(iosIds.length);
  });

  it("binds each scenario to a real driver (web grep title / iOS -only-testing id)", () => {
    for (const s of web) {
      expect(s.harness.length).toBeGreaterThan(0);
      // Grep title, not a path — the adapter passes it to `--grep`.
      expect(s.harness).not.toContain("/");
    }
    for (const s of ios) {
      // Target/Class or Target/Class/method.
      expect(s.harness.startsWith("FlagshipAppUITests/")).toBe(true);
    }
    // The total iOS tranche binds specifically into GymTotalTests; the total
    // web tranche binds into the gym-total spec (its titles are prefixed
    // "gym total"), so the adapter never confuses a tranche's specs.
    for (const s of total.filter((x) => x.surface === "ios")) {
      expect(s.harness.startsWith("FlagshipAppUITests/GymTotalTests/")).toBe(true);
    }
    for (const s of total.filter((x) => x.surface === "web")) {
      expect(s.harness.startsWith("gym total ")).toBe(true);
    }
  });

  it("carries deterministic assertions + screenshot points on every scenario", () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.assertions.length).toBeGreaterThan(0);
      expect(s.screenshotPoints.length).toBeGreaterThan(0);
    }
  });

  it("no scenario is destructive — none needs the guardrail to run (Tier-1, fixture-only)", () => {
    // The total tranche's D1 'delete/revoke' rows assert the CONFIRM UI only
    // (the sheet opens), never running a backend delete — so none is flagged
    // destructive. Real demo-only destructive ops land in the live slice (G6).
    expect(ALL_SCENARIOS.some(isDestructive)).toBe(false);
  });
});

describe("the live Tier-2 vertical slice (§12-G6) — separate registry, detect-and-skip", () => {
  it("is NOT in ALL_SCENARIOS (the fixture tranches stay entirely no-backend)", () => {
    const liveIds = new Set(LIVE_SCENARIOS.map((s) => s.id));
    for (const s of ALL_SCENARIOS) expect(liveIds.has(s.id)).toBe(false);
    // And every live scenario is genuinely backend:"live" + demo-guarded.
    expect(LIVE_SCENARIOS.length).toBeGreaterThan(0);
    for (const s of LIVE_SCENARIOS) {
      expect(s.backend).toBe("live");
      expect(s.tier).toBe("total");
      // The slice creates/installs against a demo box → must be guarded (§7-G).
      expect(isDestructive(s)).toBe(true);
    }
  });

  it("the live slice's destructive target is the ALLOWED gym demo user (guardrail passes)", () => {
    expect(ALLOWED_DEMO_USERNAMES.has(GYM_LIVE_DEMO_USERNAME)).toBe(true);
    for (const s of LIVE_SCENARIOS) {
      expect(guardScenario(s).allowed).toBe(true);
    }
  });

  it("the iOS live scenario binds into its own GymLiveTests XCUITest class", () => {
    const iosLive = LIVE_SCENARIOS.filter((s) => s.surface === "ios");
    expect(iosLive.length).toBeGreaterThan(0);
    for (const s of iosLive) {
      expect(s.harness.startsWith("FlagshipAppUITests/GymLiveTests")).toBe(true);
      // Never collides with the fixture iOS tranches (Smoke/EveryMerge/Total).
      expect(ALL_SCENARIOS.some((f) => f.harness === s.harness)).toBe(false);
    }
  });

  it("liveTarget defaults to the gym apex, env-overridable", () => {
    const def = liveTarget({});
    expect(def.controlApex).toBe(DEFAULT_GYM_CONTROL_APEX);
    expect(def.servicesApex).toBe(DEFAULT_GYM_SERVICES_APEX);
    expect(def.healthUrl).toBe(`https://${DEFAULT_GYM_CONTROL_APEX}/api/health`);
    const overridden = liveTarget({ GYM_LIVE_CONTROL_APEX: "gym2.example.com" });
    expect(overridden.healthUrl).toBe("https://gym2.example.com/api/health");
  });
});

describe("liveEnvReachable — SKIPS cleanly when the env is absent (never throws)", () => {
  it("reports unreachable (not an exception) on a network error", async () => {
    const probe = await liveEnvReachable({
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND gym.flagshipserver.com");
      }) as unknown as typeof fetch,
    });
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("unreachable");
  });

  it("reports unreachable on a non-2xx health response", async () => {
    const probe = await liveEnvReachable({
      fetchImpl: (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch,
    });
    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("502");
  });

  it("reports reachable on a 2xx health response", async () => {
    const probe = await liveEnvReachable({
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    });
    expect(probe.reachable).toBe(true);
  });
});

describe("runGym gates live scenarios on the live-env check (§12-G6)", () => {
  const liveScenario: Scenario = {
    ...baseScenario,
    id: "live-x",
    surface: "web",
    tier: "total",
    backend: "live",
    destructive: { destructive: true, demoUsername: "gymdemo" },
  };

  it("SKIPS (never fails) a live scenario when the env is unreachable, and a fixture pass keeps the run green", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      const summary = await runGym(
        [{ ...baseScenario, id: "fix", surface: "web" }, liveScenario],
        {
          repoRoot,
          suite: "total",
          tier: "total",
          adapters: { web: fakeAdapter("web"), ios: fakeAdapter("ios"), android: fakeAdapter("android") },
          liveEnvCheck: async () => ({ reachable: false, reason: "gym env unreachable (test)" }),
          log: () => {},
        },
      );
      const live = summary.results.find((r) => r.id === "live-x")!;
      const fix = summary.results.find((r) => r.id === "fix")!;
      expect(live.skipped).toBe(true);
      expect(live.passed).toBe(false);
      expect(live.skipReason).toContain("unreachable");
      // The fixture scenario still ran + passed → the run is OK (green today).
      expect(fix.passed).toBe(true);
      expect(summary.ok).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("RUNS the live scenario when the env IS reachable", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      let checked = 0;
      const summary = await runGym([liveScenario], {
        repoRoot,
        suite: "live",
        tier: "total",
        adapters: { web: fakeAdapter("web"), ios: fakeAdapter("ios"), android: fakeAdapter("android") },
        liveEnvCheck: async () => {
          checked++;
          return { reachable: true, reason: "gym env healthy (test)" };
        },
        log: () => {},
      });
      expect(checked).toBe(1); // resolved once
      expect(summary.results[0]!.skipped).toBe(false);
      expect(summary.results[0]!.passed).toBe(true);
      expect(summary.ok).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does NOT call the live-env check when no live scenario is selected (pure-fixture run makes no network call)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "gym-root-"));
    try {
      let checked = 0;
      await runGym([{ ...baseScenario, id: "fix", surface: "web" }], {
        repoRoot,
        suite: "every-merge",
        tier: "every-merge",
        adapters: { web: fakeAdapter("web"), ios: fakeAdapter("ios"), android: fakeAdapter("android") },
        liveEnvCheck: async () => {
          checked++;
          return { reachable: true, reason: "should not be called" };
        },
        log: () => {},
      });
      expect(checked).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
