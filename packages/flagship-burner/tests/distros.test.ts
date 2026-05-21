/**
 * Burner: pinned distro allowlist invariants.
 *
 * The allowlist is the security boundary — anything off it the Burner
 * refuses. These tests pin the shape so an accidental commit can't
 * add a distro with a malformed SHA / mismatched size / non-HTTPS URL.
 */
import { describe, it, expect } from "vitest";
import { PINNED_DISTROS, findDistroById, findDistroBySha } from "../src/distros.js";

describe("PINNED_DISTROS allowlist", () => {
  it("has at least one entry (we're not shipping with an empty allowlist)", () => {
    expect(PINNED_DISTROS.length).toBeGreaterThan(0);
  });

  it("every entry's sha256 is exactly 64 lowercase hex characters", () => {
    for (const d of PINNED_DISTROS) {
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("every entry's URL is https", () => {
    for (const d of PINNED_DISTROS) {
      expect(d.upstreamUrl.startsWith("https://")).toBe(true);
    }
  });

  it("every entry's URL references the major.minor version from the id", () => {
    for (const d of PINNED_DISTROS) {
      // Extract the major.minor token from the id (e.g. 22.04 from
      // "ubuntu-22.04-server-amd64").
      const m = d.id.match(/(\d+\.\d+)/);
      if (m) expect(d.upstreamUrl).toContain(m[1]!);
    }
  });

  it("ids are unique", () => {
    const ids = PINNED_DISTROS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SHAs are unique (two distros can't claim the same upstream bytes)", () => {
    const shas = PINNED_DISTROS.map((d) => d.sha256);
    expect(new Set(shas).size).toBe(shas.length);
  });

  it("every entry has a positive size > 100 MB (filters tiny garbage)", () => {
    for (const d of PINNED_DISTROS) {
      expect(d.sizeBytes).toBeGreaterThan(100 * 1024 * 1024);
    }
  });

  it("findDistroById round-trips", () => {
    for (const d of PINNED_DISTROS) {
      expect(findDistroById(d.id)).toBe(d);
    }
    expect(findDistroById("nonexistent")).toBeUndefined();
  });

  it("findDistroBySha is case-insensitive", () => {
    for (const d of PINNED_DISTROS) {
      expect(findDistroBySha(d.sha256)).toBe(d);
      expect(findDistroBySha(d.sha256.toUpperCase())).toBe(d);
    }
    expect(findDistroBySha("00".repeat(32))).toBeUndefined();
  });

  it("v1 includes Ubuntu Server 22.04 — the launch distro", () => {
    const d = findDistroById("ubuntu-22.04-server-amd64");
    expect(d).toBeDefined();
    expect(d!.cloudInitDatasource).toBe("subiquity");
  });
});
