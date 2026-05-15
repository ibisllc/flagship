import { describe, expect, it } from "vitest";
import {
  validateUserLabel,
  validateAppLabel,
  validateAppSlug,
  parseAppLabel,
  userWildcardSans,
  serverWildcardSans,
  appFqdn,
  _internal,
} from "../src/validation.js";

describe("validateUserLabel", () => {
  it("accepts plain dashless labels", () => {
    expect(validateUserLabel("harry").ok).toBe(true);
    expect(validateUserLabel("user42").ok).toBe(true);
    expect(validateUserLabel("a").ok).toBe(true);
  });

  it("normalizes case", () => {
    const r = validateUserLabel("HARRY");
    if (r.ok) expect(r.label).toBe("harry");
    else throw new Error(r.reason);
  });

  it("rejects dashes (the dash is reserved as the slug-creator separator in app URLs)", () => {
    expect(validateUserLabel("h-a-r-r-y").ok).toBe(false);
    expect(validateUserLabel("john-doe").ok).toBe(false);
    expect(validateUserLabel("-harry").ok).toBe(false);
    expect(validateUserLabel("harry-").ok).toBe(false);
  });

  it("rejects names with other disallowed characters", () => {
    expect(validateUserLabel("har_ry").ok).toBe(false);
    expect(validateUserLabel("har.ry").ok).toBe(false);
    expect(validateUserLabel("HARRY!").ok).toBe(false);
  });

  it("rejects names longer than 63 chars (DNS label cap)", () => {
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
    expect(serverWildcardSans("homebox", "harry", "flagship.services")).toEqual([
      "homebox.harry.flagship.services",
      "*.homebox.harry.flagship.services",
    ]);
    expect(serverWildcardSans("chillout", "harry", "flagship.services")).toEqual([
      "chillout.harry.flagship.services",
      "*.chillout.harry.flagship.services",
    ]);
  });
});

describe("appFqdn", () => {
  it("composes <app>.<server>.<user>.<apex>", () => {
    expect(appFqdn("habits", "homebox", "harry", "flagship.services")).toBe(
      "habits.homebox.harry.flagship.services",
    );
  });
});

describe("validateAppSlug", () => {
  it("accepts simple and multi-word slugs", () => {
    expect(validateAppSlug("game1").ok).toBe(true);
    expect(validateAppSlug("habit-tracker").ok).toBe(true);
    expect(validateAppSlug("password-manager").ok).toBe(true);
  });

  it("rejects leading, trailing, and doubled dashes", () => {
    expect(validateAppSlug("-foo").ok).toBe(false);
    expect(validateAppSlug("foo-").ok).toBe(false);
    expect(validateAppSlug("foo--bar").ok).toBe(false);
  });

  it("rejects disallowed characters", () => {
    expect(validateAppSlug("foo_bar").ok).toBe(false);
    expect(validateAppSlug("foo.bar").ok).toBe(false);
    expect(validateAppSlug("FOO!").ok).toBe(false);
  });

  it("rejects > 32 chars", () => {
    expect(validateAppSlug("a".repeat(33)).ok).toBe(false);
    expect(validateAppSlug("a".repeat(32)).ok).toBe(true);
  });
});

describe("parseAppLabel", () => {
  it("splits `<slug>-<creator>` on the LAST dash so multi-word slugs survive", () => {
    expect(parseAppLabel("game1-john")).toEqual({ slug: "game1", creator: "john" });
    expect(parseAppLabel("habit-tracker-john")).toEqual({
      slug: "habit-tracker",
      creator: "john",
    });
    expect(parseAppLabel("password-manager-alice")).toEqual({
      slug: "password-manager",
      creator: "alice",
    });
  });

  it("rejects labels without a dash (no creator)", () => {
    const r = parseAppLabel("game1");
    expect("ok" in r && r.ok === false).toBe(true);
  });

  it("rejects labels whose slug part fails slug validation", () => {
    const r = parseAppLabel("--john"); // slug = "-" → invalid
    expect("ok" in r && r.ok === false).toBe(true);
  });

  it("rejects labels whose creator part contains a dash (would be a username with a dash)", () => {
    // "game1-john-doe" — split on last dash gives slug="game1-john", creator="doe".
    // That's the right interpretation: john-doe can't be a creator (usernames are dashless),
    // but "game1-john" IS a valid slug, so this DOES parse — to (game1-john, doe).
    expect(parseAppLabel("game1-john-doe")).toEqual({
      slug: "game1-john",
      creator: "doe",
    });
  });
});

describe("_internal", () => {
  it("the reserved set covers the obvious phishing surface", () => {
    const must = ["www", "api", "admin", "git", "control", "console"];
    for (const m of must) expect(_internal.RESERVED_USER_LABELS.has(m)).toBe(true);
  });
});
