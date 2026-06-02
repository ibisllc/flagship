import { describe, expect, it } from "vitest";
import {
  certProfileForWindow,
  readCertAutonomy,
  DEFAULT_OFFLINE_WINDOW_DAYS,
} from "../src/certAutonomyMode.js";

describe("readCertAutonomy", () => {
  it("defaults to managed + 90d window when the field is absent", () => {
    expect(readCertAutonomy(undefined)).toEqual({ mode: "managed", offlineWindowDays: 90 });
    expect(readCertAutonomy({})).toEqual({ mode: "managed", offlineWindowDays: 90 });
    expect(DEFAULT_OFFLINE_WINDOW_DAYS).toBe(90);
  });

  it("passes through an explicit managed window", () => {
    expect(readCertAutonomy({ certAutonomy: { mode: "managed", offlineWindowDays: 7 } })).toEqual({
      mode: "managed",
      offlineWindowDays: 7,
    });
    expect(readCertAutonomy({ certAutonomy: { mode: "managed", offlineWindowDays: 3 } })).toEqual({
      mode: "managed",
      offlineWindowDays: 3,
    });
  });

  it("carries the autonomous mode through", () => {
    expect(
      readCertAutonomy({ certAutonomy: { mode: "autonomous", offlineWindowDays: 365 } }),
    ).toEqual({ mode: "autonomous", offlineWindowDays: 365 });
  });

  it("falls back to the default window when offlineWindowDays is unset", () => {
    expect(readCertAutonomy({ certAutonomy: { mode: "managed" } })).toEqual({
      mode: "managed",
      offlineWindowDays: 90,
    });
    // autonomous with no window still reports the default (the field is ignored
    // downstream for autonomous, but readCertAutonomy never emits NaN).
    expect(readCertAutonomy({ certAutonomy: { mode: "autonomous" } })).toEqual({
      mode: "autonomous",
      offlineWindowDays: 90,
    });
  });

  it("rejects non-finite / negative windows, falling back to the default", () => {
    expect(
      readCertAutonomy({ certAutonomy: { mode: "managed", offlineWindowDays: Number.NaN } })
        .offlineWindowDays,
    ).toBe(90);
    expect(
      readCertAutonomy({
        certAutonomy: { mode: "managed", offlineWindowDays: Number.POSITIVE_INFINITY },
      }).offlineWindowDays,
    ).toBe(90);
    expect(
      readCertAutonomy({ certAutonomy: { mode: "managed", offlineWindowDays: -1 } })
        .offlineWindowDays,
    ).toBe(90);
  });

  it("preserves a 0-day window (treat-as-set, not falsy-default)", () => {
    expect(
      readCertAutonomy({ certAutonomy: { mode: "managed", offlineWindowDays: 0 } })
        .offlineWindowDays,
    ).toBe(0);
  });
});

describe("certProfileForWindow", () => {
  it("returns short-lived at or below 6 days", () => {
    for (const d of [0, 1, 3, 5, 6]) {
      expect(certProfileForWindow(d)).toBe("short-lived");
    }
  });

  it("returns standard above 6 days", () => {
    for (const d of [7, 15, 30, 90, 365]) {
      expect(certProfileForWindow(d)).toBe("standard");
    }
  });

  it("treats the 6/7 boundary exactly", () => {
    expect(certProfileForWindow(6)).toBe("short-lived");
    expect(certProfileForWindow(7)).toBe("standard");
  });

  it("composes with the default window → standard profile", () => {
    const { offlineWindowDays } = readCertAutonomy(undefined);
    expect(certProfileForWindow(offlineWindowDays)).toBe("standard");
  });
});
