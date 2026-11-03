import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactRefusedError,
  buildArtifactSwapper,
  nodeArch,
  pickRuntimeManifest,
  readInstalledRelease,
  RUNTIME_MANIFEST_FILE,
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
    expect(seen).toEqual([`${BASE}/${name}.manifest.json`, `${BASE}/${name}.tar.gz`, "https://downloads.example/api/runtime/manifest"]);
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
    expect(args).not.toContain("--runtime-manifest"); // nothing published (404 here): the release's own lock decides
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

describe("the signed runtime manifest goes to the installer (G2, owner decision 2026-11-02)", () => {
  const LOCK = readFileSync(join(__dirname, "../../../release/runtime-lock.json"), "utf8");
  const SEED = new Uint8Array(32).fill(9);
  const NOW = 1_800_000_000_000;
  let dir: string;
  let repo: string;
  let pub: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "artifact-runtime-"));
    repo = mkdtempSync(join(tmpdir(), "artifact-repo-"));
    const { ed } = await import("../../protocol/src/edSync.js");
    pub = Buffer.from(ed.getPublicKey(SEED)).toString("hex");
    mkdirSync(join(repo, "release"));
    writeFileSync(join(repo, "release/box-artifact-trust.json"), JSON.stringify({ keys: [pub], threshold: 1 }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const name = `flagship-box-${COMMIT.slice(0, 12)}-amd64`;
  const RUNTIME_URL = "https://downloads.example/api/runtime/manifest";
  async function signed(o: { validUntil?: number; seed?: Uint8Array } = {}) {
    const { signRuntimeManifest } = await import("@flagship/protocol");
    const { createHash } = await import("node:crypto");
    const lock = JSON.parse(LOCK) as { version: string; securityFloor: string };
    const manifest = {
      runtime: "node" as const,
      version: lock.version,
      lockSha256: createHash("sha256").update(LOCK).digest("hex"),
      securityFloor: lock.securityFloor,
      release: "0.3",
      sequence: 2,
      issuedAt: NOW - 1000,
      validUntil: o.validUntil ?? NOW + 86_400_000,
      revokedSigners: [],
    };
    return JSON.stringify({ manifest, signatures: [signRuntimeManifest(manifest, o.seed ?? SEED)], lockJson: LOCK });
  }
  async function installWith(runtime: { status: number; body?: string } | null, url?: string | null) {
    const files: Record<string, Response> = {};
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => {
      seen.push(u);
      if (u === `${BASE}/${name}.manifest.json`) return new Response(JSON.stringify({ manifest: { artifactSha256: DIGEST } }));
      if (u === `${BASE}/${name}.tar.gz`) return new Response("tarball");
      if (u === RUNTIME_URL && runtime) return new Response(runtime.status === 204 ? null : runtime.body ?? "", { status: runtime.status });
      return files[u] ?? new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    let args: string[] = [];
    let staged: string | null = null;
    const logs: string[] = [];
    const runner: ArtifactCommandRunner = async (_c, a) => {
      args = a;
      const i = a.indexOf("--runtime-manifest");
      if (i >= 0) staged = readFileSync(a[i + 1]!, "utf8");
      return { stdout: "" };
    };
    const swapper = buildArtifactSwapper({ repoPath: repo, runner, fetchImpl, workDir: dir, arch: "x64", config: CONFIG, now: () => NOW, onLog: (m) => logs.push(m), ...(url !== undefined ? { runtimeManifestUrl: url } : {}) });
    await swapper.install(COMMIT);
    return { args, staged, logs, seen };
  }

  it("passes a manifest that verifies under the release's trust and has not expired, beside the artifact", async () => {
    const body = await signed();
    const r = await installWith({ status: 200, body });
    const i = r.args.indexOf("--runtime-manifest");
    expect(i).toBeGreaterThan(0);
    expect(r.args[i + 1]).toBe(join(dir, `.flagship-update-${COMMIT.slice(0, 12)}`, RUNTIME_MANIFEST_FILE));
    expect(r.staged).toBe(body);
  });

  it("never stops an update for want of a manifest: absent, unreachable, expired, forged or unreadable all fall back to the signed lock", async () => {
    for (const [runtime, why] of [
      [{ status: 204 }, "none is published"],
      [{ status: 503, body: "down" }, "none is published"],
      [{ status: 200, body: await signed({ validUntil: NOW - 1 }) }, "expired"],
      [{ status: 200, body: await signed({ seed: new Uint8Array(32).fill(1) }) }, "does not verify"],
      [{ status: 200, body: "{not json" }, "unreadable"],
    ] as const) {
      const r = await installWith(runtime);
      expect(r.args, why).not.toContain("--runtime-manifest");
      expect(r.logs.join("\n"), why).toContain(why);
      expect(r.logs.join("\n")).toContain("the release's own signed runtime lock decides");
    }
  });

  it("does not ask .com at all when the check is off", async () => {
    const r = await installWith({ status: 200, body: await signed() }, null);
    expect(r.seen).not.toContain(RUNTIME_URL);
    expect(r.args).not.toContain("--runtime-manifest");
  });

  it("a release without a trust file passes nothing", () => {
    expect(pickRuntimeManifest("{}", null, NOW)).toEqual({ pass: false, why: "this release pins no release trust" });
  });
});
