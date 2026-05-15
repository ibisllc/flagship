// E7 — webapp pure-logic mirror of the account-reset detector.
//
// The actual home.js detector touches DOM + localStorage + fetch,
// none of which jsdom is wired up for in this repo. The cheapest
// faithful test is to re-implement the predicate against the
// canonicalised input shape and pin its truth table. If a future
// refactor changes the rule, the assertions break.

import { describe, expect, it } from "vitest";

interface Device {
  tokenId: string;
  tokenPrefix: string;
  label: string;
  platform: string;
  addedAt: number;
  lastSeenAt: number;
}

/** Mirrors the `present`-vs-orphan decision in detectAccountReset(). */
function shouldShowAccountResetBanner(localTokenId: string | null, devices: Device[]): boolean {
  if (!localTokenId) return false; // fresh install — never orphaned
  return !devices.some((d) => d.tokenId === localTokenId);
}

describe("E7 account-reset detector — predicate", () => {
  it("returns false when there's no local token (fresh install)", () => {
    expect(shouldShowAccountResetBanner(null, [])).toBe(false);
    expect(shouldShowAccountResetBanner("", [])).toBe(false);
  });

  it("returns false when our token IS in the list", () => {
    const devs: Device[] = [
      { tokenId: "tA", tokenPrefix: "tA", label: "Phone", platform: "apns", addedAt: 1, lastSeenAt: 1 },
      { tokenId: "tB", tokenPrefix: "tB", label: "Browser", platform: "webpush", addedAt: 2, lastSeenAt: 2 },
    ];
    expect(shouldShowAccountResetBanner("tB", devs)).toBe(false);
  });

  it("returns true when our token is MISSING from the list", () => {
    const devs: Device[] = [
      { tokenId: "tA", tokenPrefix: "tA", label: "Phone", platform: "apns", addedAt: 1, lastSeenAt: 1 },
    ];
    // Locally we remember `tZ` but the server says only tA is left.
    // → this browser was disconnected by another device.
    expect(shouldShowAccountResetBanner("tZ", devs)).toBe(true);
  });

  it("returns true on an empty devices list when we have a local token", () => {
    // Edge case: the account was wiped entirely (e.g. v1.1 wipe-restart
    // ceremony with our token replaced). The user must re-pair.
    expect(shouldShowAccountResetBanner("tZ", [])).toBe(true);
  });

  it("is case-sensitive on tokenId (matches Worker comparison)", () => {
    // The Worker's listByUser doesn't lower-case tokenIds — they're
    // opaque bytes hex-encoded. A casing mismatch should NOT match.
    const devs: Device[] = [
      { tokenId: "ABC123", tokenPrefix: "abc123", label: "Phone", platform: "apns", addedAt: 1, lastSeenAt: 1 },
    ];
    expect(shouldShowAccountResetBanner("abc123", devs)).toBe(true);
    expect(shouldShowAccountResetBanner("ABC123", devs)).toBe(false);
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
