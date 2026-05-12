import { describe, expect, it } from "vitest";
import { detectRepo, maintainersPaths } from "../src/repo-detect.js";

describe("detectRepo", () => {
  it("detects github repos", () => {
    const r = detectRepo("https://github.com/foo/bar");
    expect(r).not.toBeNull();
    expect(r?.provider).toBe("github");
    expect(r?.owner).toBe("foo");
    expect(r?.repo).toBe("bar");
    expect(r?.repoUrl).toBe("https://github.com/foo/bar");
  });

  it("detects deep github paths (file view, issues, etc.)", () => {
    const r = detectRepo("https://github.com/foo/bar/blob/main/README.md");
    expect(r?.owner).toBe("foo");
    expect(r?.repo).toBe("bar");
  });

  it("strips trailing .git suffix", () => {
    const r = detectRepo("https://github.com/foo/bar.git");
    expect(r?.repo).toBe("bar");
  });

  it("rejects non-repo github paths (settings, marketplace, etc.)", () => {
    expect(detectRepo("https://github.com/settings/profile")).toBeNull();
    expect(detectRepo("https://github.com/marketplace/foo")).toBeNull();
    expect(detectRepo("https://github.com/topics/javascript")).toBeNull();
  });

  it("rejects github user profile pages (single segment)", () => {
    expect(detectRepo("https://github.com/foo")).toBeNull();
  });

  it("rejects unknown hosts", () => {
    expect(detectRepo("https://example.com/foo/bar")).toBeNull();
  });

  it("detects gitlab.com repos and produces raw URLs", () => {
    const r = detectRepo("https://gitlab.com/foo/bar");
    expect(r?.provider).toBe("gitlab");
    expect(r?.rawUrl(".maintainers/policy.json", "main")).toBe(
      "https://gitlab.com/foo/bar/-/raw/main/.maintainers/policy.json",
    );
  });

  it("detects codeberg.org repos and produces raw URLs", () => {
    const r = detectRepo("https://codeberg.org/foo/bar");
    expect(r?.provider).toBe("codeberg");
    expect(r?.rawUrl(".maintainers/policy.json", "main")).toBe(
      "https://codeberg.org/foo/bar/raw/branch/main/.maintainers/policy.json",
    );
  });

  it("detects gitea.com and gitea.* repos", () => {
    expect(detectRepo("https://gitea.com/foo/bar")?.provider).toBe("gitea");
    expect(detectRepo("https://gitea.example.org/foo/bar")?.provider).toBe("gitea");
  });

  it("accepts whitelisted hosts as gitea-shaped", () => {
    const r = detectRepo("https://git.example.com/foo/bar", ["git.example.com"]);
    expect(r?.provider).toBe("gitea");
    expect(r?.rawUrl("README.md", "main")).toBe(
      "https://git.example.com/foo/bar/raw/branch/main/README.md",
    );
  });

  it("produces canonical github raw URLs", () => {
    const r = detectRepo("https://github.com/foo/bar");
    expect(r?.rawUrl(".maintainers/policy.json", "main")).toBe(
      "https://raw.githubusercontent.com/foo/bar/main/.maintainers/policy.json",
    );
  });

  it("rejects malformed URLs", () => {
    expect(detectRepo("not-a-url")).toBeNull();
    expect(detectRepo("ftp://github.com/foo/bar")).toBeNull();
  });

  it("rejects pathologically long path segments", () => {
    const longOwner = "a".repeat(200);
    expect(detectRepo(`https://github.com/${longOwner}/bar`)).toBeNull();
  });
});

describe("maintainersPaths", () => {
  it("returns standard paths", () => {
    const p = maintainersPaths();
    expect(p.policy).toBe(".maintainers/policy.json");
    expect(p.trackPolicy("release")).toBe(".maintainers/tracks/release/policy.json");
    expect(p.trackMandatesListing("release")).toBe(".maintainers/tracks/release/mandates/");
    expect(p.keysListing).toBe(".maintainers/keys/");
  });
});
