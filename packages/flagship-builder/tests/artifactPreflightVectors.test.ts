/**
 * The Studios' box-release preflight (vm-core-vectors.json "artifactPreflight") asks for exactly the
 * manifest the installer bootstrap downloads. If the bootstrap's name or base moves, the vectors (and
 * the three Studios they pin) must move with it, or Studio checks one file while the box fetches another.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildBootstrapScript, DEFAULT_BOOT_HOST } from "../src/userdata.js";
import { BOX_RELEASE } from "../src/boxReleaseConfig.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../../apps/desktop-shared/golden/vm-core-vectors.json", import.meta.url), "utf8"),
).artifactPreflight as { urlCases: { name: string; controlHost: string; commit: string; arch: string; url: string | null }[] };

describe("artifactPreflight vectors follow the installer bootstrap", () => {
  const commit = "386e29c84899283c167c9ce983d2dc2acbaa4f11";
  const script = buildBootstrapScript({
    ref: commit,
    repoUrl: "https://github.com/ibisllc/flagship.git",
    encryptRoot: true,
    bootUnlockMode: "auto",
    bootHost: DEFAULT_BOOT_HOST,
  });

  it("downloads <artifactBase>/flagship-box-<commit12>-<arch>.manifest.json", () => {
    expect(script).toContain('BOX_ARTIFACT_NAME="flagship-box-${GIT_REF:0:12}-$BOX_ARCH"');
    expect(script).toContain(`BOX_ARTIFACT_BASE="${BOX_RELEASE.artifactBase}"`);
    expect(script).toContain('"$BOX_ARTIFACT_BASE/$BOX_ARTIFACT_NAME.$_ext"');
    expect(script).toMatch(/for _ext in tar\.gz manifest\.json; do/);
  });

  it("the base is <control host>/build/iso, the host the Studios follow", () => {
    expect(BOX_RELEASE.artifactBase).toMatch(/^https:\/\/[^/]+\/build\/iso$/);
    for (const c of vectors.urlCases.filter((c) => c.url !== null && c.commit === commit)) {
      const base = `https://${c.controlHost}/build/iso`;
      expect(c.url, c.name).toBe(`${base}/flagship-box-${commit.slice(0, 12)}-${c.arch}.manifest.json`);
    }
    // This checkout's own plane (production, or the gym on the gym branch) is one of the vector hosts.
    const own = vectors.urlCases.find((c) => c.controlHost === new URL(BOX_RELEASE.artifactBase).host && c.commit === commit && c.url);
    expect(own?.url.replace(/-(amd64|arm64)\.manifest\.json$/, "")).toBe(`${BOX_RELEASE.artifactBase}/flagship-box-${commit.slice(0, 12)}`);
  });
});
