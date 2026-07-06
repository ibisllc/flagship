import { describe, expect, it } from "vitest";
import { composeServiceId, parseServiceId, deriveUrlFragment } from "../src/serviceId.js";

// docs/service-addressing-double-dash.md: the slug↔creator delimiter is `--`, so
// both halves may carry SINGLE dashes (dashed usernames + dashed slugs) and the
// single `--` is always the boundary.
describe("composeServiceId / parseServiceId (`--` delimiter)", () => {
  it("round-trips a simple id", () => {
    expect(composeServiceId("harry", "game1")).toBe("harry--game1");
    expect(parseServiceId("harry--game1")).toEqual({ creator: "harry", slug: "game1" });
  });

  it("survives dashes in BOTH the creator (dashed username) and the slug", () => {
    expect(composeServiceId("happy-turtle", "notes-app")).toBe("happy-turtle--notes-app");
    expect(parseServiceId("happy-turtle--notes-app")).toEqual({
      creator: "happy-turtle",
      slug: "notes-app",
    });
  });

  it("returns null when there is no single usable boundary", () => {
    expect(parseServiceId("nodash")).toBeNull(); // no `--`
    expect(parseServiceId("single-dash")).toBeNull(); // single dash is NOT the delimiter
    expect(parseServiceId("--leading")).toBeNull(); // empty creator
    expect(parseServiceId("trailing--")).toBeNull(); // empty slug
    expect(parseServiceId("a--b--c")).toBeNull(); // ≥2 delimiters → ambiguous
  });
});

describe("deriveUrlFragment (`--` delimiter)", () => {
  it("is just the slug when the running user authored it", () => {
    expect(deriveUrlFragment("harry--game1", "harry")).toBe("game1");
  });

  it("is slug--creator when running someone else's service", () => {
    expect(deriveUrlFragment("meta--game1", "harry")).toBe("game1--meta");
  });

  it("is case-insensitive on the creator/user match", () => {
    expect(deriveUrlFragment("Harry--Game1", "harry")).toBe("game1");
    expect(deriveUrlFragment("META--game1", "harry")).toBe("game1--meta");
  });

  it("keeps dashed slugs AND dashed creators intact in both branches", () => {
    expect(deriveUrlFragment("harry--notes-app", "harry")).toBe("notes-app");
    expect(deriveUrlFragment("happy-turtle--notes-app", "harry")).toBe("notes-app--happy-turtle");
  });

  it("sanitizes an id with no creator/slug boundary", () => {
    expect(deriveUrlFragment("nodash", "harry")).toBe("nodash");
  });
});
