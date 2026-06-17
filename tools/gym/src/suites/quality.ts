/**
 * D7 QUALITY gym scenarios — the quality lane of the registry.
 *
 * These are the AUTOMATABLE D7 gates (§6 D7, §7-B/D/E), distinct from
 * feature-flow scenarios: token-conformance (the rendered palette matches the
 * brand tokens — teal accent / dark canvas, no legacy `#3B5BFF`), nav-graph
 * (no orphan/dead-end routes), and the every-interactive-control "dead control"
 * sweep (every button is addressable + firing it has an effect). They are
 * deterministic Layer-1 gates — separate from the ADVISORY AI judge (which is a
 * review aid, never a gate; see ai/byokSeam.ts).
 *
 * Add rows with `web(...)` / `webTotal(...)` (and later ios/android) from
 * ./helpers.js; each `harness` = a Playwright grep TITLE under
 * apps/web/e2e/gym/gym-quality.spec.ts (its own spec file, so it never collides
 * with the feature-flow web specs).
 */

import type { Scenario } from "../scenario.js";

/** The D7-quality lane of the gym registry (token/nav/dead-control gates). */
export const QUALITY_GYM_SCENARIOS: readonly Scenario[] = [];
