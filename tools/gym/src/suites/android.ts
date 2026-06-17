/**
 * Android gym scenarios — the Android lane of the registry.
 *
 * Empty until the on-device instrumentation harness lands (§10 Phase-5): a
 * net-new `apps/mobile/android/app/src/androidTest/` (Compose UI Test + Espresso
 * launching MainActivity on an AVD) + the testTag sweep across the screens so
 * controls are addressable. Until then the AndroidAdapter reports `available:
 * false` and the runner SKIPS Android cleanly.
 *
 * As the harness comes up, add rows here with `android(...)` / `androidTotal(...)`
 * from ./helpers.js, each `harness` = a Compose-UI-Test class[#method] identifier
 * matching a test under app/src/androidTest/ (the adapter passes it to
 * `connectedDebugAndroidTest` via -Pandroid.testInstrumentationRunnerArguments.class).
 * Mirror the iOS lane (ios.ts) cluster-for-cluster.
 */

import type { Scenario } from "../scenario.js";

/** The Android lane of the gym registry. Filled in as the harness lands (§10 Phase-5). */
export const ANDROID_GYM_SCENARIOS: readonly Scenario[] = [];
