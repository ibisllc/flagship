import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactRefusedError,
  buildArtifactSwapper,
  nodeArch,
  readInstalledRelease,
  type ArtifactCommandRunner,
} from "../src/artifactUpdate.js";
import { buildArtifactCatalog } from "../src/artifactCatalog.js";

const COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);
const DIGEST = "e".repeat(64);
const BASE = "https://downloads.example/box";
const CONFIG = { artifactBase: BASE, minSequence: 3, nodeFloor: "24.22.1", trust: { keys: ["k1", "k2"], threshold: 2 } };

function fetchFiles(files: Record<string, string>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const body = files[url];
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("buildArtifactSwapper", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "artifact-update-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const name = `flagship-box-${COMMIT.slice(0, 12)}-amd64`;
  const files = {
    [`${BASE}/${name}.manifest.json`]: JSON.stringify({ manifest: { artifactSha256: DIGEST } }),
    [`${BASE}/${name}.tar.gz`]: "tarball",
  };

  it("downloads the release for the exact commit and hands it to the installer with the baked trust", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: ArtifactCommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      expect(readFileSync(args[args.indexOf("--artifact") + 1]!, "utf8")).toBe("tarball");
      return { stdout: "" };
    };
    const seen: string[] = [];
    const swapper = buildArtifactSwapper({ repoPath: "/opt/flagship", runner, fetchImpl: fetchFiles(files, seen), workDir: dir, arch: "x64", config: CONFIG });
    await swapper.install(COMMIT);
    expect(seen).toEqual([`${BASE}/${name}.manifest.json`, `${BASE}/${name}.tar.gz`]);
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0]!;
    expect(cmd).toBe("bash");
    expect(args[0]).toBe("/opt/flagship/installer/install-box-artifact.sh");
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag("--trust-keys")).toBe("k1,k2");
    expect(flag("--threshold")).toBe("2");
    expect(flag("--expect-sha256")).toBe(DIGEST);
    expect(flag("--expect-commit")).toBe(COMMIT);
    expect(flag("--arch")).toBe("amd64");
    expect(flag("--node-floor")).toBe("24.22.1");
    expect(flag("--min-sequence")).toBe("3");
  });

  it("maps the verifier's refusal (exit 1) to ArtifactRefusedError and leaves no download behind", async () => {
    const runner: ArtifactCommandRunner = async () => {
      throw Object.assign(new Error("refused: signatures"), { code: 1 });
    };
    const swapper = buildArtifactSwapper({ repoPath: "/opt/flagship", runner, fetchImpl: fetchFiles(files), workDir: dir, arch: "x64", config: CONFIG });
    await expect(swapper.install(COMMIT)).rejects.toBeInstanceOf(ArtifactRefusedError);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats any other installer failure as a plain error, not a refusal", async () => {
    const runner: ArtifactCommandRunner = async () => {
      throw Object.assign(new Error("disk full"), { code: 3 });
    };
    const swapper = buildArtifactSwapper({ repoPath: "/opt/flagship", runner, fetchImpl: fetchFiles(files), workDir: dir, arch: "x64", config: CONFIG });
    const err = await swapper.install(COMMIT).catch((e) => e);
    expect(err).not.toBeInstanceOf(ArtifactRefusedError);
    expect(err.message).toContain("disk full");
  });

  it("fails when the release is not published, and never runs the installer", async () => {
    let ran = false;
    const swapper = buildArtifactSwapper({
      repoPath: "/opt/flagship",
      runner: async () => void (ran = true) as never,
      fetchImpl: fetchFiles({}),
      workDir: dir,
      arch: "x64",
      config: CONFIG,
    });
    await expect(swapper.install(OTHER)).rejects.toThrow(/download failed/);
    expect(ran).toBe(false);
  });

  it("refuses a branch, a short hash and a non-https base", async () => {
    const runner: ArtifactCommandRunner = async () => ({ stdout: "" });
    const swapper = buildArtifactSwapper({ repoPath: "/opt/flagship", runner, fetchImpl: fetchFiles(files), workDir: dir, arch: "x64", config: CONFIG });
    await expect(swapper.install("main")).rejects.toBeInstanceOf(ArtifactRefusedError);
    await expect(swapper.install(COMMIT.slice(0, 12))).rejects.toBeInstanceOf(ArtifactRefusedError);
    const insecure = buildArtifactSwapper({
      repoPath: "/opt/flagship",
      runner,
      fetchImpl: fetchFiles(files),
      workDir: dir,
      arch: "x64",
      config: { ...CONFIG, artifactBase: "http://downloads.example/box" },
    });
    await expect(insecure.install(COMMIT)).rejects.toThrow(/https/);
  });

  it("restores only an exact commit, using the rollback script of the running release", async () => {
    const calls: string[][] = [];
    const swapper = buildArtifactSwapper({ repoPath: "/opt/flagship", runner: async (c, a) => (calls.push([c, ...a]), { stdout: "" }), arch: "x64", config: CONFIG });
    await swapper.restore(COMMIT);
    expect(calls).toEqual([["bash", "/opt/flagship/installer/rollback-box-artifact.sh", COMMIT]]);
    await expect(swapper.restore("main")).rejects.toThrow();
  });

  it("only knows amd64 and arm64", () => {
    expect(nodeArch("x64")).toBe("amd64");
    expect(nodeArch("arm64")).toBe("arm64");
    expect(() => nodeArch("ia32")).toThrow();
  });
});

describe("readInstalledRelease", () => {
  it("reads the installer's record and rejects junk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "installed-"));
    try {
      expect(await readInstalledRelease(dir)).toBeNull();
      writeFileSync(join(dir, "artifact-current.json"), JSON.stringify({ commit: COMMIT, arch: "amd64", sequence: 4 }));
      expect(await readInstalledRelease(dir)).toEqual({ commit: COMMIT, arch: "amd64", sequence: 4 });
      writeFileSync(join(dir, "artifact-current.json"), JSON.stringify({ commit: "main", arch: "amd64", sequence: 4 }));
      expect(await readInstalledRelease(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildArtifactCatalog", () => {
  const dirWith = (record: object) => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-"));
    writeFileSync(join(dir, "artifact-current.json"), JSON.stringify(record));
    return dir;
  };
  const index = {
    releases: [
      { commit: OTHER, sequence: 5, tag: "0.4", arch: ["amd64", "arm64"] },
      { commit: COMMIT, sequence: 4, arch: ["amd64"] },
      { commit: "f".repeat(40), sequence: 3, arch: ["arm64"] },
      { commit: "not-a-commit", sequence: 9, arch: ["amd64"] },
    ],
  };

  it("orders by sequence, relates to the running release and keeps only this architecture", async () => {
    const dir = dirWith({ commit: COMMIT, arch: "amd64", sequence: 4 });
    try {
      const cat = buildArtifactCatalog({ artifactBase: BASE, stateDir: dir, arch: "x64", fetchImpl: fetchFiles({ [`${BASE}/releases.json`]: JSON.stringify(index) }) });
      const c = await cat.get({ refresh: true });
      expect(c.currentCommit).toBe(COMMIT);
      expect(c.releases.map((r) => [r.commit, r.relation])).toEqual([[OTHER, "newer"], [COMMIT, "current"]]);
      expect(c.latest?.commit).toBe(OTHER);
      expect(c.stale).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the catalog stale and offers nothing when the index cannot be read", async () => {
    const dir = dirWith({ commit: COMMIT, arch: "amd64", sequence: 4 });
    try {
      const cat = buildArtifactCatalog({ artifactBase: BASE, stateDir: dir, arch: "x64", fetchImpl: fetchFiles({}) });
      const c = await cat.get({ refresh: true });
      expect(c).toMatchObject({ currentCommit: COMMIT, latest: null, releases: [], stale: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
