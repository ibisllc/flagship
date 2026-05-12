import { describe, expect, it } from "vitest";
import { parseRepoUrl, pickProvider } from "../src/repo-provider.js";

describe("parseRepoUrl", () => {
  it("parses a bare github URL", () => {
    const r = parseRepoUrl("github.com/foo/bar");
    expect(r.provider).toBe("github.com");
    expect(r.owner).toBe("foo");
    expect(r.repo).toBe("bar");
    expect(r.ref).toBe("main");
    expect(r.canonical).toBe("github.com/foo/bar");
  });
  it("parses an https URL with .git suffix", () => {
    const r = parseRepoUrl("https://github.com/foo/bar.git");
    expect(r.canonical).toBe("github.com/foo/bar");
  });
  it("parses an @ref suffix", () => {
    const r = parseRepoUrl("github.com/foo/bar@v1.2.0");
    expect(r.ref).toBe("v1.2.0");
  });
  it("parses a /tree/<branch> suffix", () => {
    const r = parseRepoUrl("https://github.com/foo/bar/tree/develop");
    expect(r.ref).toBe("develop");
    expect(r.canonical).toBe("github.com/foo/bar");
  });
  it("parses a gitlab /-/tree/ suffix", () => {
    const r = parseRepoUrl("https://gitlab.com/foo/bar/-/tree/main");
    expect(r.provider).toBe("gitlab.com");
    expect(r.ref).toBe("main");
  });
  it("parses a git@host:owner/repo.git URL", () => {
    const r = parseRepoUrl("git@github.com:foo/bar.git");
    expect(r.canonical).toBe("github.com/foo/bar");
  });
  it("supports nested gitlab namespaces", () => {
    const r = parseRepoUrl("gitlab.com/group/subgroup/project");
    expect(r.owner).toBe("group");
    expect(r.repo).toBe("subgroup/project");
  });
  it("rejects empty", () => {
    expect(() => parseRepoUrl("")).toThrow();
    expect(() => parseRepoUrl("github.com")).toThrow();
  });
});

describe("pickProvider", () => {
  it("picks github for github.com", () => {
    const ref = parseRepoUrl("github.com/foo/bar");
    expect(pickProvider(ref).name).toBe("github");
  });
  it("picks codeberg for codeberg.org", () => {
    const ref = parseRepoUrl("codeberg.org/foo/bar");
    expect(pickProvider(ref).name).toBe("codeberg");
  });
  it("picks gitlab for gitlab.com", () => {
    const ref = parseRepoUrl("gitlab.com/foo/bar");
    expect(pickProvider(ref).name).toBe("gitlab");
  });
  it("constructs raw URL for github correctly", () => {
    const ref = parseRepoUrl("github.com/foo/bar");
    const provider = pickProvider(ref);
    const url = provider.rawContentUrl(ref, ".maintainers/policy.json");
    expect(url).toBe("https://raw.githubusercontent.com/foo/bar/main/.maintainers/policy.json");
  });
  it("constructs raw URL for codeberg correctly", () => {
    const ref = parseRepoUrl("codeberg.org/foo/bar@develop");
    const provider = pickProvider(ref);
    const url = provider.rawContentUrl(ref, ".maintainers/policy.json");
    expect(url).toBe("https://codeberg.org/foo/bar/raw/branch/develop/.maintainers/policy.json");
  });
  it("constructs raw URL for gitlab correctly", () => {
    const ref = parseRepoUrl("gitlab.com/foo/bar");
    const provider = pickProvider(ref);
    const url = provider.rawContentUrl(ref, ".maintainers/policy.json");
    expect(url).toBe("https://gitlab.com/foo/bar/-/raw/main/.maintainers/policy.json");
  });
  it("throws for an unknown host", () => {
    const ref = parseRepoUrl("internal.example.com/foo/bar");
    expect(() => pickProvider(ref)).toThrow(/no provider/);
  });
});
