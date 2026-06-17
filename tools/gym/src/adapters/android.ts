/**
 * Android adapter — INTERFACE + STUB only (§12-G3, deliberately deferred).
 *
 * The full Android UI gym is a separate, larger phase (§10 Phase-5): it needs
 *   1. a net-new on-device instrumentation harness — `src/androidTest/` with
 *      Compose UI Test + Espresso launching MainActivity on an AVD (today there
 *      is no `androidTest` source dir; the Compose tests run as Robolectric JVM
 *      unit tests), and
 *   2. the ~43-screen `testTag` sweep so Android controls are addressable at
 *      all (today: 12 tags on 2 screens vs iOS's ~217).
 * plus an emulator boot in the runner and screenshot/bitmap extraction.
 *
 * That is out of scope for this run. This adapter reports `available: false`
 * with that reason, so the runner cleanly SKIPS Android (never fails it) and
 * the seam is in place: implementing `run()` here (shell
 * `./gradlew :app:connectedDebugAndroidTest`, parse the test XML, pull the
 * captured bitmaps) is the whole future lift, with no change above this line.
 */

import type { Scenario } from "../scenario.js";
import type { AdapterContext, AdapterOutcome, SurfaceAdapter } from "./types.js";

export class AndroidAdapter implements SurfaceAdapter {
  readonly surface = "android" as const;

  async available(_ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }> {
    return {
      ok: false,
      reason:
        "Android UI gym not built yet (§10 Phase-5): needs an emulator " +
        "instrumentation harness (src/androidTest/) + the ~43-screen testTag " +
        "sweep. Adapter seam is in place; see tools/gym/src/adapters/android.ts.",
    };
  }

  async run(_scenario: Scenario, _ctx: AdapterContext): Promise<AdapterOutcome> {
    // Unreachable while available() is false; the runner guards on availability.
    throw new Error(
      "AndroidAdapter.run is a stub — the Compose-UI-Test/emulator harness is a " +
        "later phase (§10 Phase-5). Implement gradle connectedDebugAndroidTest here.",
    );
  }
}
