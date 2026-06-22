import { describe, expect, it } from "vitest";
// The unified cover's pure core (docs/login-and-account-redesign.md): given a
// resolved (existing) account, ALL four access pathways are always returned,
// with enabled/disabledReason saying which apply — so entering your own name
// offers recovery instead of dead-ending at "name taken".
import { accessOptions, hasAnyAccess } from "../public/webapp/lib/accountAccess.js";

type Resolution = Parameters<typeof accessOptions>[0];

function res(over: Partial<Record<string, unknown>> = {}): Resolution {
  return {
    username: "harry",
    exists: true,
    kind: "single",
    recovery: { present: false, hasFetchGate: false },
    totpEnrolled: false,
    trustedDeviceCount: 1,
    graceModel: "3d",
    ...over,
  } as unknown as Resolution;
}

describe("accessOptions — the four pathways are ALWAYS shown", () => {
  it("always returns recover / scan / keyfile / grace, in that order", () => {
    const ids = accessOptions(res()).map((o) => o.id);
    expect(ids).toEqual(["recover", "scan", "keyfile", "grace"]);
  });

  it("recover is ENABLED only when cloud recovery is enrolled", () => {
    const enrolled = accessOptions(res({ recovery: { present: true } })).find((o) => o.id === "recover")!;
    expect(enrolled.enabled).toBe(true);
    expect(enrolled.disabledReason).toBeNull();

    const notEnrolled = accessOptions(res()).find((o) => o.id === "recover")!;
    expect(notEnrolled.enabled).toBe(false);
    expect(notEnrolled.disabledReason).toMatch(/no cloud recovery/i);
  });

  it("scan + keyfile are always enabled (we can't know server-side if you have them)", () => {
    const opts = accessOptions(res({ recovery: { present: false }, graceModel: "none" }));
    expect(opts.find((o) => o.id === "scan")!.enabled).toBe(true);
    expect(opts.find((o) => o.id === "keyfile")!.enabled).toBe(true);
  });

  it("grace is disabled (with a reason) when the account has no grace path", () => {
    const none = accessOptions(res({ graceModel: "none" })).find((o) => o.id === "grace")!;
    expect(none.enabled).toBe(false);
    expect(none.disabledReason).toBeTruthy();

    const totp = accessOptions(res({ graceModel: "24h-totp" })).find((o) => o.id === "grace")!;
    expect(totp.enabled).toBe(true);
    expect(totp.label.toLowerCase()).toContain("authenticator");
  });

  it("hasAnyAccess: even a recovery-less account is reachable (scan/keyfile)", () => {
    expect(hasAnyAccess(res({ recovery: { present: false }, graceModel: "none" }))).toBe(true);
  });
});
