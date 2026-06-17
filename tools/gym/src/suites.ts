/**
 * The scenario registry. This run ships ONE smoke scenario per surface for web
 * + iOS (§12-G3 "prove it"), tagged `every-merge` so they run in both gyms. The
 * full §6 70×4 matrix fills in here incrementally — each scenario is a small
 * additive entry whose `harness` points at a real per-surface spec.
 */

import type { Scenario } from "./scenario.js";

/** Web smoke — cold launch → the bootstrap shell renders (no backend). */
const WEB_SMOKE_COLD_LAUNCH: Scenario = {
  id: "web-smoke-cold-launch",
  surface: "web",
  tier: "every-merge",
  backend: "fixture",
  goal: "Cold launch renders the bootstrap shell with the brand title + a primary create-account action.",
  steps: [
    { kind: "launch", describe: "Open the webapp at / (static-served, no backend)." },
    { kind: "assert", describe: "Bootstrap view is visible.", handle: "#view-bootstrap" },
    { kind: "screenshot", describe: "Capture the cold-launch frame." },
    { kind: "assert", describe: "Brand title contains 'Flagship'.", handle: "header h1#title" },
    { kind: "assert", describe: "Primary action is present + enabled.", handle: "#bootstrap-go" },
    { kind: "screenshot", describe: "Capture the bootstrap-ready frame." },
  ],
  assertions: [
    { describe: "Bootstrap view present", handle: "#view-bootstrap", expect: "present" },
    { describe: "Brand title text", handle: "header h1#title", expect: "text", text: "Flagship" },
    { describe: "Create-account action enabled", handle: "#bootstrap-go", expect: "enabled" },
  ],
  screenshotPoints: [
    { id: "cold-launch", describe: "Immediately after the shell paints." },
    { id: "bootstrap-ready", describe: "After the primary action is confirmed present." },
  ],
  // Playwright grep title — matches the gym-smoke.spec.ts describe/test text.
  harness: "gym webapp smoke",
};

/** iOS smoke — cold launch in smoke-mode → seeded Home shell renders. */
const IOS_SMOKE_COLD_LAUNCH: Scenario = {
  id: "ios-smoke-cold-launch",
  surface: "ios",
  tier: "every-merge",
  backend: "fixture",
  goal: "Cold launch in -smoke-mode lands on the seeded Home shell (DemoFixtures pods rendered).",
  steps: [
    { kind: "launch", describe: "Launch with -smoke-mode -smoke-tab home (DemoFixtures seeded, no backend)." },
    { kind: "screenshot", describe: "Capture the cold-launch frame." },
    { kind: "assert", describe: "Home renders the add-server affordance (present only with pods).", handle: "home-add-server" },
    { kind: "screenshot", describe: "Capture the home-ready frame." },
  ],
  assertions: [
    { describe: "Seeded Home shell present", handle: "home-add-server", expect: "present" },
  ],
  screenshotPoints: [
    { id: "cold-launch", describe: "Immediately after launch." },
    { id: "home-ready", describe: "After Home renders with seeded pods." },
  ],
  // xcodebuild -only-testing identifier: Target/Class.
  harness: "FlagshipAppUITests/GymSmokeTests",
};

/** Every scenario known to the gym. */
export const ALL_SCENARIOS: readonly Scenario[] = [
  WEB_SMOKE_COLD_LAUNCH,
  IOS_SMOKE_COLD_LAUNCH,
];
