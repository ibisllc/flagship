import { describe, expect, it } from "vitest";
import {
  validateUserLabel,
  validateAppLabel,
  userWildcardSans,
  serverWildcardSans,
  appFqdn,
  _internal,
} from "../src/validation.js";

describe("validateUserLabel", () => {
  it("accepts plain DNS labels", () => {
    expect(validateUserLabel("harry").ok).toBe(true);
    expect(validateUserLabel("h-a-r-r-y").ok).toBe(true);
    expect(validateUserLabel("user42").ok).toBe(true);
  });

  it("normalizes case", () => {
    const r = validateUserLabel("HARRY");
    if (r.ok) expect(r.label).toBe("harry");
    else throw new Error(r.reason);
  });

  it("rejects names beginning or ending with hyphens", () => {
    expect(validateUserLabel("-harry").ok).toBe(false);
    expect(validateUserLabel("harry-").ok).toBe(false);
  });

  it("rejects names with disallowed characters", () => {
    expect(validateUserLabel("har_ry").ok).toBe(false);
    expect(validateUserLabel("har.ry").ok).toBe(false);
    expect(validateUserLabel("HARRY!").ok).toBe(false);
  });

  it("rejects names longer than 63 characters", () => {
    expect(validateUserLabel("a".repeat(64)).ok).toBe(false);
    expect(validateUserLabel("a".repeat(63)).ok).toBe(true);
  });

  it("rejects reserved usernames so users can't shadow control-plane endpoints", () => {
    for (const reserved of ["api", "www", "admin", "git", "tunnel", "support"]) {
      expect(validateUserLabel(reserved).ok).toBe(false);
    }
  });
});

describe("validateAppLabel", () => {
  it("does not apply the user-reserved list (apps can be 'api', 'www', etc. under <user>)", () => {
    expect(validateAppLabel("api").ok).toBe(true);
    expect(validateAppLabel("www").ok).toBe(true);
  });

  it("still enforces RFC 1035 label rules", () => {
    expect(validateAppLabel("with.dot").ok).toBe(false);
  });
});

describe("userWildcardSans (legacy / single-server users)", () => {
  it("returns the apex + wildcard SAN list for a per-user cert", () => {
    expect(userWildcardSans("harry", "flagship.services")).toEqual([
      "harry.flagship.services",
      "*.harry.flagship.services",
    ]);
  });
});

describe("serverWildcardSans (multi-server v1)", () => {
  it("issues a per-SERVER wildcard so adding a server doesn't reissue siblings' certs", () => {
    expect(serverWildcardSans("home-box", "harry", "flagship.services")).toEqual([
      "home-box.harry.flagship.services",
      "*.home-box.harry.flagship.services",
    ]);
    expect(serverWildcardSans("chillout", "harry", "flagship.services")).toEqual([
      "chillout.harry.flagship.services",
      "*.chillout.harry.flagship.services",
    ]);
  });
});

describe("appFqdn", () => {
  it("composes <app>.<server>.<user>.<apex>", () => {
    expect(appFqdn("habits", "home-box", "harry", "flagship.services")).toBe(
      "habits.home-box.harry.flagship.services",
    );
  });
});

describe("_internal", () => {
  it("the reserved set covers the obvious phishing surface", () => {
    const must = ["www", "api", "admin", "git", "control", "console"];
    for (const m of must) expect(_internal.RESERVED_USER_LABELS.has(m)).toBe(true);
  });
});
