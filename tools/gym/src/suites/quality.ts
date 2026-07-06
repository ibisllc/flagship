/**
 * D7 QUALITY gym scenarios — the quality lane of the registry.
 *
 * These are the AUTOMATABLE D7 gates (§6 D7, §7-B/D/E), distinct from
 * feature-flow scenarios: token-conformance (the rendered palette matches the
 * brand tokens — teal accent / warm canvas, no legacy `#3B5BFF`), nav-graph
 * (no orphan/dead-end routes), and the every-interactive-control "dead control"
 * sweep (every visible button is addressable + enabled). They are deterministic
 * Layer-1 gates — separate from the ADVISORY AI judge (which is a review aid,
 * never a gate; see ai/byokSeam.ts).
 *
 * Each row's `harness` is the Playwright test TITLE under
 * apps/web/e2e/gym/gym-quality.spec.ts (its OWN spec file, so it never collides
 * with the feature-flow web specs). Titles are anchored by the web adapter, so
 * each must be unique. These are `total`-tier (run only in `gym:total`) and
 * tagged dimension "D7" for coverage reporting.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

/** The D7-quality lane of the gym registry (token/nav/dead-control gates). */
export const QUALITY_GYM_SCENARIOS: readonly Scenario[] = [
  webTotal(
    "web-quality-token-conformance",
    "the booted shell renders the brand teal/Geist tokens on a warm canvas with NO legacy blue #3B5BFF anywhere",
    "gym quality token-conformance brand palette fonts and no legacy blue",
    {
      steps: [
        { kind: "launch", describe: "cold-launch the webapp shell" },
        { kind: "assert", describe: "--teal / --teal-bright resolve to the brand values; --accent is not legacy blue" },
        { kind: "assert", describe: "the canvas is warm (not pure #000/#FFF) and the body renders the Geist stack" },
        { kind: "assert", describe: "no element computes the legacy blue #3B5BFF on any color-bearing property" },
      ],
      assertions: [
        { describe: "the brand accent resolves to teal, not the legacy blue", handle: "--accent", expect: "present" },
        { describe: "no element renders #3B5BFF", expect: "absent" },
      ],
      screenshots: [shot("token-conformance", "the booted shell at the brand palette")],
      dimension: "D7",
    },
  ),
  webTotal(
    "web-quality-nav-graph",
    "from Home every one of the 4 tab targets reaches a known view and the back edge returns home",
    "gym quality nav-graph reaches each tab and returns home",
    {
      steps: [
        { kind: "launch", describe: "reach the Home shell" },
        { kind: "tap", describe: "visit Settings / Activity / Services / Home in turn", handle: "[data-tab-target]" },
        { kind: "assert", describe: "each tab renders its known view (no orphan/dead-end) and Home is reachable again" },
      ],
      assertions: [
        { describe: "the Settings tab renders", handle: "#view-settings-tab", expect: "present" },
        { describe: "the Activity tab renders", handle: "#view-activity", expect: "present" },
        { describe: "the Services tab renders", handle: "#view-services-list", expect: "present" },
        { describe: "Home is reachable after each tab", handle: "#view-home", expect: "present" },
      ],
      screenshots: [shot("nav-graph", "the tab-graph fully traversed")],
      dimension: "D7",
    },
  ),
  webTotal(
    "web-quality-dead-control-sweep",
    "every visible interactive control on the build chooser is addressable (has an id) and enabled — no dead control",
    "gym quality dead-control sweep on the build chooser",
    {
      steps: [
        { kind: "launch", describe: "reach the build chooser (Services → build a service)" },
        { kind: "assert", describe: "enumerate the visible controls; each has an id and is visible + enabled" },
        { kind: "assert", describe: "the named load-bearing controls (scratch / git / mcp / back) are addressable" },
      ],
      assertions: [
        { describe: "the scratch tile is addressable", handle: "#build-src-scratch", expect: "present" },
        { describe: "the git tile is addressable", handle: "#build-src-git", expect: "present" },
        { describe: "the mcp tile is addressable", handle: "#build-src-mcp", expect: "present" },
        { describe: "the back control is addressable", handle: "#build-source-back", expect: "present" },
      ],
      screenshots: [shot("dead-control-swept", "the chooser after the control sweep")],
      dimension: "D7",
    },
  ),
];
