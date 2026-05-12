import { describe, expect, it } from "vitest";
import { computeOverlayState, formatDuration } from "../src/verifier-logic.js";
import { buildFixture } from "./fixtures/build-fixture.js";

describe("computeOverlayState — happy path (renewal, no alarms)", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const fx = buildFixture({ takeover: false, recentEmailRotation: false, expiresInDays: 30, now });

  const state = computeOverlayState({
    policy: fx.policy,
    trackPolicies: { release: fx.releasePolicy, ca: fx.caPolicy },
    mandates: fx.mandates,
    keys: fx.keys,
    endorsements: fx.endorsements,
    now,
  });

  it("reports the project name", () => {
    expect(state.projectName).toBe("fixture-project");
  });

  it("returns two tracks", () => {
    expect(state.tracks.map((t) => t.track)).toEqual(["release", "ca"]);
  });

  it("identifies Alice as the current release holder", () => {
    const release = state.tracks.find((t) => t.track === "release")!;
    expect(release.current?.holder.displayName).toBe("Alice");
    expect(release.current?.holder.email).toBe("alice@example.com");
  });

  it("lists Bob + Carol as successors on the release track", () => {
    const release = state.tracks.find((t) => t.track === "release")!;
    expect(release.successors.map((s) => s.displayName)).toEqual(["Bob", "Carol"]);
  });

  it("reports a positive time-to-expiry", () => {
    const release = state.tracks.find((t) => t.track === "release")!;
    expect(release.current?.expiresInMs).toBeGreaterThan(0);
  });

  it("has no red alarms", () => {
    expect(state.alarms.filter((a) => a.level === "red")).toEqual([]);
  });

  it("includes the latest endorsement in recentEndorsements", () => {
    expect(state.recentEndorsements).toHaveLength(1);
    expect(state.recentEndorsements[0]?.semverTag).toBe("v0.1.0");
  });
});

describe("computeOverlayState — takeover triggers a red alarm", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const fx = buildFixture({ takeover: true, recentEmailRotation: false, expiresInDays: 30, now });
  const state = computeOverlayState({
    policy: fx.policy,
    trackPolicies: { release: fx.releasePolicy, ca: fx.caPolicy },
    mandates: fx.mandates,
    keys: fx.keys,
    endorsements: fx.endorsements,
    now,
  });

  it("marks Bob as the current release holder", () => {
    const release = state.tracks.find((t) => t.track === "release")!;
    expect(release.current?.holder.displayName).toBe("Bob");
  });

  it("surfaces a red takeover alarm", () => {
    const takeover = state.alarms.find((a) => a.kind === "takeover");
    expect(takeover).toBeDefined();
    expect(takeover?.level).toBe("red");
    expect(takeover?.detail).toMatch(/Alice.*Bob/);
  });

  it("includes both Alice's and Bob's emails as contact targets", () => {
    const takeover = state.alarms.find((a) => a.kind === "takeover");
    expect(takeover?.contactEmails).toContain("alice@example.com");
    expect(takeover?.contactEmails).toContain("bob@example.com");
  });
});

describe("computeOverlayState — recent email rotation triggers a yellow alarm", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const fx = buildFixture({ takeover: false, recentEmailRotation: true, expiresInDays: 30, now });
  const state = computeOverlayState({
    policy: fx.policy,
    trackPolicies: { release: fx.releasePolicy, ca: fx.caPolicy },
    mandates: fx.mandates,
    keys: fx.keys,
    endorsements: fx.endorsements,
    now,
  });

  it("surfaces a yellow email-rotation alarm for Bob", () => {
    const rot = state.alarms.find((a) => a.kind === "email-rotation");
    expect(rot).toBeDefined();
    expect(rot?.level).toBe("yellow");
    expect(rot?.message).toMatch(/Bob/);
    expect(rot?.detail).toMatch(/bob-old@example.com.*bob-new@example.com/);
  });
});

describe("computeOverlayState — expiring-soon banner", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  const fx = buildFixture({ takeover: false, recentEmailRotation: false, expiresInDays: 3, now });
  const state = computeOverlayState({
    policy: fx.policy,
    trackPolicies: { release: fx.releasePolicy, ca: fx.caPolicy },
    mandates: fx.mandates,
    keys: fx.keys,
    endorsements: fx.endorsements,
    now,
  });
  it("fires when the active mandate expires within 7 days", () => {
    const expiring = state.alarms.find((a) => a.kind === "expiring-soon");
    expect(expiring).toBeDefined();
    expect(expiring?.level).toBe("yellow");
    expect(expiring?.contactEmails).toContain("alice@example.com");
  });
});

describe("computeOverlayState — missing policy", () => {
  it("returns an empty state with policyPresent=false", () => {
    const state = computeOverlayState({
      policy: null,
      trackPolicies: {},
      mandates: {},
      keys: [],
      endorsements: [],
      now: new Date(),
    });
    expect(state.policyPresent).toBe(false);
    expect(state.tracks).toEqual([]);
    expect(state.alarms).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats days", () => {
    expect(formatDuration(3 * 86400000)).toBe("3d");
  });
  it("formats hours", () => {
    expect(formatDuration(5 * 3600 * 1000)).toBe("5h");
  });
  it("formats minutes", () => {
    expect(formatDuration(7 * 60 * 1000)).toBe("7m");
  });
  it("formats seconds", () => {
    expect(formatDuration(15 * 1000)).toBe("15s");
  });
  it("returns 'expired' for negatives", () => {
    expect(formatDuration(-1000)).toBe("expired");
  });
});
