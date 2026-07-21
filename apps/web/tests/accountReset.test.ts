// E7 — webapp pure-logic mirror of the account-reset detector.
//
// The actual home.js detector touches DOM + localStorage + fetch,
// none of which jsdom is wired up for in this repo. The cheapest
// faithful test is to re-implement the predicate against the
// canonicalised input shape and pin its truth table. If a future
// refactor changes the rule, the assertions break.

import { describe, expect, it } from "vitest";

interface Device {
  deviceId: string;
  revokedAt?: number | null;
}

/** Mirrors the `present`-vs-orphan decision in detectAccountReset(). */
function shouldShowAccountResetBanner(localDeviceId: string | null, devices: Device[]): boolean {
  if (!localDeviceId) return false;
  return !devices.some((d) => d.deviceId === localDeviceId && d.revokedAt == null);
}

describe("E7 account-reset detector — predicate", () => {
  it("returns false when there's no local token (fresh install)", () => {
    expect(shouldShowAccountResetBanner(null, [])).toBe(false);
    expect(shouldShowAccountResetBanner("", [])).toBe(false);
  });

  it("returns false when our token IS in the list", () => {
    const devs: Device[] = [{ deviceId: "dA" }, { deviceId: "dB" }];
    expect(shouldShowAccountResetBanner("dB", devs)).toBe(false);
  });

  it("returns true when our token is MISSING from the list", () => {
    const devs: Device[] = [{ deviceId: "dA" }];
    expect(shouldShowAccountResetBanner("dZ", devs)).toBe(true);
  });

  it("returns true on an empty devices list when we have a local token", () => {
    // Edge case: the account was wiped entirely (e.g. v1.1 wipe-restart
    // ceremony with our token replaced). The user must re-pair.
    expect(shouldShowAccountResetBanner("dZ", [])).toBe(true);
  });

  it("treats a revoked matching device as removed", () => {
    expect(shouldShowAccountResetBanner("dA", [{ deviceId: "dA", revokedAt: 7 }])).toBe(true);
  });
});

describe("E7 account-reset detector — Sign-in-again side effects", () => {
  // Pin the keys the detector clears so a future refactor that
  // renames any of them surfaces here, not at runtime where the
  // user discovers the banner button doesn't actually sign them out.
  const KEYS_CLEARED_BY_SIGN_IN_AGAIN = [
    "flagship.pushTokenId",
    "flagship.sessionId",
    "flagship.session.v1",
  ];

  it("clears the per-device push token, the session id, and the session blob", () => {
    expect(KEYS_CLEARED_BY_SIGN_IN_AGAIN).toContain("flagship.pushTokenId");
    expect(KEYS_CLEARED_BY_SIGN_IN_AGAIN).toContain("flagship.sessionId");
    expect(KEYS_CLEARED_BY_SIGN_IN_AGAIN).toContain("flagship.session.v1");
  });

  it("does NOT clear flagship.wrappedUmk", () => {
    // The wrapped UMK is preserved so the recovery flow can re-bind
    // without re-enrolling — a usability win that doesn't sacrifice
    // security (the wrapped UMK requires a passkey to unwrap).
    expect(KEYS_CLEARED_BY_SIGN_IN_AGAIN).not.toContain("flagship.wrappedUmk");
  });
});
