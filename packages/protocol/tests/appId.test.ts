import { describe, expect, it } from "vitest";
import { composeAppId, parseAppId, deriveUrlFragment } from "../src/appId.js";

describe("composeAppId / parseAppId", () => {
  it("round-trips a simple id", () => {
    expect(composeAppId("harry", "game1")).toBe("harry-game1");
    expect(parseAppId("harry-game1")).toEqual({ creator: "harry", slug: "game1" });
  });

  it("splits at the FIRST hyphen so hyphenated slugs survive", () => {
    expect(parseAppId("meta-notes-app")).toEqual({
      creator: "meta",
      slug: "notes-app",
    });
  });

  it("returns null when there is no usable boundary", () => {
    expect(parseAppId("nodash")).toBeNull();
    expect(parseAppId("-leading")).toBeNull();
    expect(parseAppId("trailing-")).toBeNull();
  });
});

describe("deriveUrlFragment", () => {
  it("is just the slug when the running user authored it", () => {
    // harry runs his own harry-game1 -> game1
    expect(deriveUrlFragment("harry-game1", "harry")).toBe("game1");
  });

  it("is slug-creator when running someone else's app", () => {
    // harry runs meta's meta-game1 -> game1-meta
    expect(deriveUrlFragment("meta-game1", "harry")).toBe("game1-meta");
  });

  it("is case-insensitive on the creator/user match", () => {
    expect(deriveUrlFragment("Harry-Game1", "harry")).toBe("game1");
    expect(deriveUrlFragment("META-game1", "harry")).toBe("game1-meta");
  });

  it("keeps a hyphenated slug intact in both branches", () => {
    expect(deriveUrlFragment("harry-notes-app", "harry")).toBe("notes-app");
    expect(deriveUrlFragment("meta-notes-app", "harry")).toBe("notes-app-meta");
  });

  it("sanitizes an id with no creator/slug boundary", () => {
    expect(deriveUrlFragment("nodash", "harry")).toBe("nodash");
  });
});
