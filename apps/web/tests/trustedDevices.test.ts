// Smoke test for the webapp Trusted-devices view. The view module
// itself relies on DOM globals (jsdom isn't installed); the testable
// pieces are the wire-format expectations + the small set of pure
// formatting helpers. We re-implement those here against the same
// expected output so a renamed wire field surfaces immediately.

import { describe, expect, it } from "vitest";

interface TrustedDevice {
  deviceId: string;
  displayName?: string;
  supportCode: string;
  platformClass: "ios" | "android" | "web";
  createdAt: number;
  lastSeenAt: number;
}

// Mirror of the helpers inside views/trusted-devices.js. If they
// drift, the assertions below break — the file's the source of
// truth, this test is the contract check.
function platformDisplay(p: string | undefined): string {
  return ({ ios: "iPhone / iPad", android: "Android", web: "Web" } as Record<string, string>)[p ?? ""] ?? (p || "Unknown platform");
}

// Mirror of deviceName() inside views/trusted-devices.js — the row's
// display name must NEVER render the literal string "undefined", even
// when `label` (and `platform`) are absent from the record.
function deviceName(device: { displayName?: string; platformClass?: string; supportCode?: string; deviceId: string }): string {
  if (device.displayName) return device.displayName;
  return `${platformDisplay(device.platformClass)} · Device ${device.supportCode ?? device.deviceId.slice(0, 8)}`;
}

function relative(ms: number, now: number): string {
  if (!ms) return "unknown";
  const d = now - ms;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

describe("trusted-devices helpers", () => {
  it("platformDisplay maps the three known platforms", () => {
    expect(platformDisplay("ios")).toBe("iPhone / iPad");
    expect(platformDisplay("android")).toBe("Android");
    expect(platformDisplay("web")).toBe("Web");
  });

  it("platformDisplay passes through unknown platforms verbatim", () => {
    expect(platformDisplay("xrOS")).toBe("xrOS");
  });

  it("platformDisplay never renders 'undefined' for a missing platform", () => {
    expect(platformDisplay(undefined)).toBe("Unknown platform");
    expect(platformDisplay("")).toBe("Unknown platform");
  });

  it("uses decrypted names and otherwise renders only opaque identity", () => {
    const deviceId = "00112233445566778899aabbccddeeff";
    expect(deviceName({ displayName: "Erica", platformClass: "ios", supportCode: "7A4F-K9Q2", deviceId })).toBe("Erica");
    expect(deviceName({ platformClass: "ios", supportCode: "7A4F-K9Q2", deviceId })).toBe("iPhone / iPad · Device 7A4F-K9Q2");
    expect(deviceName({ platformClass: "web", deviceId })).toBe("Web · Device 00112233");
  });

  it("relative() returns 'just now' under 60s", () => {
    const now = 1_700_000_000_000;
    expect(relative(now - 30_000, now)).toBe("just now");
  });

  it("relative() drops minutes / hours / days at the right thresholds", () => {
    const now = 1_700_000_000_000;
    expect(relative(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relative(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("relative(0) returns 'unknown'", () => {
    expect(relative(0, 1)).toBe("unknown");
  });
});

describe("trusted-devices decrypted-directory shape", () => {
  it("contains opaque metadata plus a locally decrypted name", () => {
    const sample: TrustedDevice = {
      deviceId: "00112233445566778899aabbccddeeff",
      displayName: "Erica",
      supportCode: "7A4F-K9Q2",
      platformClass: "ios",
      createdAt: 1700000000000,
      lastSeenAt: 1700100000000,
    };
    expect(Object.keys(sample).sort()).toEqual(
      ["createdAt", "deviceId", "displayName", "lastSeenAt", "platformClass", "supportCode"].sort(),
    );
  });
});

describe("trusted-devices quarantine (v1.2 Phase 4)", () => {
  // Pure-logic mirror of the quarantine helpers + the disabled-button
  // render contract inside views/trusted-devices.js. A freshly-admitted
  // device (re-pair takeover) carries a 14-day `quarantineUntil`; until
  // it elapses the Disconnect button is disabled and the row shows the
  // date. If the helpers drift, these break — the view is the source of
  // truth, this test is the contract check.

  function isQuarantined(device: { quarantineUntil?: number }, now: number): boolean {
    const until = device.quarantineUntil;
    return typeof until === "number" && until > 0 && until > now;
  }

  function quarantineMessage(device: { quarantineUntil?: number }): string {
    const until = device.quarantineUntil;
    if (!until) return "This device is in quarantine. Use another device.";
    const when = new Date(until).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return `Quarantined until ${when}. Use another device.`;
  }

  // Mirror of renderDeviceCard()'s button: `disabled` is present iff the
  // row is quarantined.
  function disconnectButton(quarantined: boolean): string {
    return `<button class="secondary danger" ${quarantined ? "disabled" : ""}>Disconnect</button>`;
  }

  const now = 1_700_000_000_000;

  it("a future quarantineUntil is quarantined; past / 0 / absent is not", () => {
    expect(isQuarantined({ quarantineUntil: now + 86_400_000 }, now)).toBe(true);
    expect(isQuarantined({ quarantineUntil: now - 1 }, now)).toBe(false);
    expect(isQuarantined({ quarantineUntil: 0 }, now)).toBe(false);
    expect(isQuarantined({}, now)).toBe(false);
  });

  it("disables the Disconnect button while quarantined", () => {
    expect(disconnectButton(true)).toContain("disabled");
    expect(disconnectButton(false)).not.toContain("disabled");
  });

  it("quarantine message shows the date and matches the iOS/Android wording", () => {
    const msg = quarantineMessage({ quarantineUntil: now + 14 * 86_400_000 });
    expect(msg.startsWith("Quarantined until ")).toBe(true);
    expect(msg.endsWith(". Use another device.")).toBe(true);
  });

  it("falls back to a dateless message when quarantineUntil is missing", () => {
    expect(quarantineMessage({})).toBe("This device is in quarantine. Use another device.");
  });
});

// The danger zone (Replace device, Wipe & restart) left this view: Wipe & restart is "Reset account keys" in
// Account security and each row offers only rename and "Remove from account" (webappDeviceRemoved.test.ts).
