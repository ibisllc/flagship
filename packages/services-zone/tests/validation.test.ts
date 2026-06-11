import { describe, expect, it } from "vitest";
import {
  validateUserLabel,
  validateAppLabel,
  validateAppSlug,
  parseAppLabel,
  resolveLeftmostLabel,
  type ResolverLookups,
  serverWildcardSans,
  appFqdn,
  canonicalServiceFqdn,
  _internal,
} from "../src/validation.js";

describe("validateUserLabel", () => {
  it("accepts plain dashless labels in the 3–30 range", () => {
    expect(validateUserLabel("harry").ok).toBe(true);
    expect(validateUserLabel("user42").ok).toBe(true);
    expect(validateUserLabel("abc").ok).toBe(true); // min length 3
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

  it("enforces the 3–30 length range", () => {
    expect(validateUserLabel("ab").ok).toBe(false); // too short (< 3)
    expect(validateUserLabel("abc").ok).toBe(true); // min
    expect(validateUserLabel("a".repeat(30)).ok).toBe(true); // max
    expect(validateUserLabel("a".repeat(31)).ok).toBe(false); // too long (> 30)
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

describe("serverWildcardSans (canonical per-box shape, model A′)", () => {
  it("issues one cert per box: apex + one label of subdomains under the box", () => {
    expect(serverWildcardSans("homebox", "harry", "flagship.services")).toEqual([
      "homebox.harry.flagship.services",
      "*.homebox.harry.flagship.services",
    ]);
  });

  it("two boxes under one user get DISTINCT SAN sets (no duplicate-cert collision)", () => {
    const a = serverWildcardSans("homebox", "harry", "flagship.services");
    const b = serverWildcardSans("chillout", "harry", "flagship.services");
    expect(a).not.toEqual(b);
  });
});

describe("appFqdn (tier 2 — hardware-agnostic)", () => {
  it("composes <app>.<user>.<apex>", () => {
    expect(appFqdn("habits", "harry", "flagship.services")).toBe(
      "habits.harry.flagship.services",
    );
  });
});

describe("canonicalServiceFqdn (tier 1 — box-pinned, model A′)", () => {
  it("composes the hierarchical <service>.<server>.<user>.<apex>", () => {
    expect(canonicalServiceFqdn("habits", "homebox", "harry", "flagship.services")).toBe(
      "habits.homebox.harry.flagship.services",
    );
  });

  it("the canonical name sits inside the box's wildcard SAN coverage", () => {
    const [, wildcard] = serverWildcardSans("homebox", "harry", "flagship.services");
    const fqdn = canonicalServiceFqdn("habits", "homebox", "harry", "flagship.services");
    expect(fqdn.endsWith(wildcard!.slice(1))).toBe(true);
    expect(fqdn.split(".").length).toBe(wildcard!.split(".").length);
  });

  it("composes from labels that pass the existing label validators", () => {
    expect(validateAppSlug("habit-tracker").ok).toBe(true);
    expect(validateAppLabel("homebox").ok).toBe(true);
    expect(validateUserLabel("harry").ok).toBe(true);
    expect(
      canonicalServiceFqdn("habit-tracker", "homebox", "harry", "flagship.services"),
    ).toBe("habit-tracker.homebox.harry.flagship.services");
  });
});

describe("resolveLeftmostLabel (user-zone precedence)", () => {
  function lookups(over: Partial<{ boxes: string[]; devices: string[]; apps: string[] }> = {}): ResolverLookups {
    const boxes = new Set(over.boxes ?? []);
    const devices = new Set(over.devices ?? []);
    const apps = new Set(over.apps ?? []);
    return {
      isBoxName: (l) => boxes.has(l),
      isDeviceLabel: (l) => devices.has(l),
      isAppLabel: (l) => apps.has(l),
    };
  }

  it("1. a registered box name → box-apex", () => {
    expect(resolveLeftmostLabel("home", lookups({ boxes: ["home"] }))).toEqual({ cls: "box-apex", label: "home" });
  });

  it("2. a device label → device (before app)", () => {
    expect(resolveLeftmostLabel("reviewer", lookups({ devices: ["reviewer"], apps: ["reviewer"] })))
      .toEqual({ cls: "device", label: "reviewer" });
  });

  it("3. an install-table app → app", () => {
    expect(resolveLeftmostLabel("game", lookups({ apps: ["game"] }))).toEqual({ cls: "app", label: "game" });
  });

  it("4. unknown label → none (disambiguation)", () => {
    expect(resolveLeftmostLabel("nope", lookups())).toEqual({ cls: "none", label: "nope" });
  });

  it("precedence: box-name beats a same-named app", () => {
    expect(resolveLeftmostLabel("home", lookups({ boxes: ["home"], apps: ["home"] })).cls).toBe("box-apex");
  });

  it("the retired -- pin operator is just an ordinary (unregistered) label now", () => {
    expect(resolveLeftmostLabel("photo-album--home", lookups({ boxes: ["home"] })))
      .toEqual({ cls: "none", label: "photo-album--home" });
  });

  it("is case-insensitive on the input label", () => {
    expect(resolveLeftmostLabel("HOME", lookups({ boxes: ["home"] })).cls).toBe("box-apex");
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
