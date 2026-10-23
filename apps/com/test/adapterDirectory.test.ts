import { describe, expect, it } from "vitest";
import { renderDirectory, type DirectoryRow } from "../src/adapterDirectory.js";

const row = (over: Partial<DirectoryRow> = {}): DirectoryRow => ({
  repo: "https://github.com/me/notes", license: "MIT", base: "a".repeat(40), file_sha256: "b".repeat(64), added: "2026-10-20", confirmations: 3, complaints: 0, ...over,
});

describe("adapter directory", () => {
  it("lists projects with digest, base, license and a status, and nothing about counts or people", () => {
    const out = JSON.parse(renderDirectory([row(), row({ file_sha256: "c".repeat(64), complaints: 5, confirmations: 1 })], new Set(), "2026-10-23"));
    expect(out).toMatchObject({ version: 1, generated: "2026-10-23" });
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0]).toMatchObject({ repo: "https://github.com/me/notes", host: "github.com", license: "MIT" });
    expect(out.projects[0].adapters.map((a: { status: string }) => a.status)).toEqual(["published", "disputed"]);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/confirmations|complaints|installs|count/i);
    expect(Object.keys(out.projects[0].adapters[0]).sort()).toEqual(["added", "base", "digest", "status"]);
  });

  it("leaves out a repo that opted out and sorts projects by address", () => {
    const out = JSON.parse(renderDirectory([row({ repo: "https://github.com/z/z" }), row({ repo: "https://github.com/a/a", file_sha256: "d".repeat(64) }), row({ repo: "https://github.com/no/no", file_sha256: "e".repeat(64) })], new Set(["https://github.com/no/no"]), "2026-10-23"));
    expect(out.projects.map((p: { repo: string }) => p.repo)).toEqual(["https://github.com/a/a", "https://github.com/z/z"]);
  });
});
