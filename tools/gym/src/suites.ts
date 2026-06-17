/**
 * The scenario registry — an AGGREGATOR over the per-surface lanes. Each surface
 * (and the D7-quality concern) owns its OWN module under suites/, so parallel
 * authors never collide on one file; this aggregator just concatenates them and
 * re-exports `ALL_SCENARIOS` (the stable import the cli/runner/tests rely on).
 *
 * The two tranches sharing one harness (§0):
 *   1. The every-merge gym's curated, fast, DETERMINISTIC, NO-BACKEND Tier-1
 *      subset (§12-G4): "does the app still launch, render its core screens, and
 *      navigate without a broken edge." Every such scenario is `every-merge` +
 *      `fixture` (so it runs in BOTH gyms) and non-destructive.
 *   2. The total-gym Tier-1 TRANCHE (§12-G5 / §6 matrix) — the higher-value,
 *      fixture-feasible, NO-BACKEND scenarios beyond the every-merge subset.
 *      These are `total` + `fixture` (they run ONLY in `gym:total`).
 *
 * The LIVE vertical slice (Tier-2, D6 action→effect against a real box) lives in
 * live.ts (NOT this registry) — it is `backend:"live"` and detect-and-skips.
 *
 * Lane modules:
 *   - suites/web.ts      → WEB_GYM_SCENARIOS      (Playwright)
 *   - suites/ios.ts      → IOS_GYM_SCENARIOS      (XCUITest; iPad = same classes, iPad destination)
 *   - suites/android.ts  → ANDROID_GYM_SCENARIOS  (Compose UI Test; empty until §10 Phase-5)
 *   - suites/quality.ts  → QUALITY_GYM_SCENARIOS  (D7 token/nav/dead-control gates)
 */

import type { Scenario } from "./scenario.js";
import { WEB_GYM_SCENARIOS } from "./suites/web.js";
import { IOS_GYM_SCENARIOS } from "./suites/ios.js";
import { ANDROID_GYM_SCENARIOS } from "./suites/android.js";
import { QUALITY_GYM_SCENARIOS } from "./suites/quality.js";

/** Every scenario known to the gym (every-merge subset + the total tranche, all surfaces). */
export const ALL_SCENARIOS: readonly Scenario[] = [
  ...WEB_GYM_SCENARIOS,
  ...IOS_GYM_SCENARIOS,
  ...ANDROID_GYM_SCENARIOS,
  ...QUALITY_GYM_SCENARIOS,
];
