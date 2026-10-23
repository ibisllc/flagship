import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildReleaseIndex } from "../release-index.js";

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
