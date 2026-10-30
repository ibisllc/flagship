import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseIndex, mergeReleaseIndex } from "../release-index.js";

it("joins both architectures of a release and orders newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-index-"));
  try {
    const m = (commit: string, arch: string, sequence: number) =>
      writeFileSync(join(dir, `flagship-box-${commit.slice(0, 12)}-${arch}.manifest.json`), JSON.stringify({ manifest: { commit, arch, sequence, issuedAt: 1760000000000 } }));
    m("a".repeat(40), "amd64", 1);
    m("b".repeat(40), "amd64", 2);
    m("b".repeat(40), "arm64", 2);
    writeFileSync(join(dir, "junk.manifest.json"), JSON.stringify({ manifest: { commit: "main", sequence: 9 } }));
    const idx = buildReleaseIndex(dir, { ["b".repeat(40)]: "0.3" });
    expect(idx.releases.map((r) => [r.commit[0], r.sequence, r.arch, r.tag])).toEqual([
      ["b", 2, ["amd64", "arm64"], "0.3"],
      ["a", 1, ["amd64"], undefined],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mergeReleaseIndex", () => {
  const a = { commit: "a".repeat(40), sequence: 2, arch: ["amd64"] };
  const b = { commit: "b".repeat(40), sequence: 1, arch: ["amd64"] };
  it("keeps the new entries and adds earlier releases it does not name, newest first", () => {
    expect(mergeReleaseIndex({ releases: [a] }, { releases: [b, { ...a, sequence: 9 }] }).releases).toEqual([a, b]);
  });
  it("ignores a missing or hostile earlier index", () => {
    expect(mergeReleaseIndex({ releases: [a] }, null).releases).toEqual([a]);
    expect(mergeReleaseIndex({ releases: [a] }, { releases: [{ commit: "x", sequence: "1", arch: 1 }, null] }).releases).toEqual([a]);
  });
});
