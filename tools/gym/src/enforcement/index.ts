/**
 * Live-enforcement gym gates — public API (docs/ui-test-gym.md).
 *
 * The standing "does the control actually fire on the wire" check. Import the
 * check functions + rollup from a live orchestrator (tools/live-e2e) that supplies
 * the real transport, or from a unit test that supplies a stub.
 */
export * from "./types.js";
export * from "./checks.js";
export * from "./report.js";
