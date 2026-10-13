import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_BASES } from "@flagship/protocol";
import { prepareRuntimeContext } from "../src/runtimes/buildContext.js";
import { runDockerBuild } from "../src/serviceRunner.js";
import { RUNTIMES, runtimeById } from "../src/runtimes/catalog.js";
import { runtimeBuildFile } from "../src/runtimes/buildFile.js";

const has = (o: Partial<{ packageLock: boolean; packageJson: boolean; requirements: boolean }> = {}) => ({
  packageLock: false,
  packageJson: false,
  requirements: false,
  ...o,
});

describe("the runtime catalog", () => {
  it("pins every runtime by an index digest", () => {
    for (const rt of Object.values(RUNTIMES)) expect(rt.image).toMatch(/^docker\.io\/[a-z0-9./-]+:[A-Za-z0-9.-]+@sha256:[0-9a-f]{64}$/);
  });
  it("runs nothing as root", () => {
    for (const rt of Object.values(RUNTIMES)) expect(rt.user).not.toMatch(/^0[:]|^root/);
  });
  it("knows only its own ids", () => {
    expect(runtimeById("node-24")?.id).toBe("node-24");
    expect(runtimeById("toString")).toBeNull();
    expect(runtimeById("node-18")).toBeNull();
    expect(runtimeById(3)).toBeNull();
  });
});

describe("the box-written build", () => {
  it("node: pinned base, npm ci from the lockfile, the app's start, an unprivileged user", () => {
    const r = runtimeBuildFile({ base: "node-24", port: 3000, start: ["node", "server.js"], has: has({ packageJson: true, packageLock: true }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.dockerfile.trim().split("\n");
    expect(lines[1]).toBe(`FROM ${RUNTIMES["node-24"].image}`);
    expect(lines).toContain("RUN npm ci --omit=dev --no-audit --no-fund");
    expect(lines).toContain("USER 10001:10001");
    expect(lines.at(-1)).toBe('CMD ["node","server.js"]');
    // Exactly one FROM and one RUN, both the box's.
    expect(lines.filter((l) => l.startsWith("FROM "))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("RUN "))).toHaveLength(1);
    expect(r.dockerignore).toContain("node_modules");
    expect(r.dockerignore).toContain(".env");
  });

  it("node without a lockfile installs from package.json; without package.json it refuses", () => {
    const r = runtimeBuildFile({ base: "node-24", port: 3000, start: null, has: has({ packageJson: true }) });
    expect(r.ok && r.dockerfile).toContain("RUN npm install --omit=dev");
    expect(r.ok && r.dockerfile.trim().split("\n").at(-1)).toBe('CMD ["npm","start"]');
    expect(runtimeBuildFile({ base: "node-24", port: 3000, start: null, has: has() })).toEqual({ ok: false, reason: "a node-24 app needs a package.json" });
  });

  it("python needs a start command and installs requirements when it has them", () => {
    expect(runtimeBuildFile({ base: "python-3.13", port: 8000, start: null, has: has() }).ok).toBe(false);
    const r = runtimeBuildFile({ base: "python-3.13", port: 8000, start: ["python", "app.py"], has: has({ requirements: true }) });
    expect(r.ok && r.dockerfile).toContain("RUN pip install --no-cache-dir -r requirements.txt");
    const bare = runtimeBuildFile({ base: "python-3.13", port: 8000, start: ["python", "app.py"], has: has() });
    expect(bare.ok && bare.dockerfile).not.toContain("RUN ");
  });

  it("static serves a folder on 8080 and has no RUN at all", () => {
    const r = runtimeBuildFile({ base: "static", port: 8080, start: null, root: "./public/", has: has() });
    expect(r.ok && r.dockerfile).toContain("COPY public /usr/share/nginx/html/");
    expect(r.ok && r.dockerfile).not.toContain("RUN ");
    expect(runtimeBuildFile({ base: "static", port: 3000, start: null, has: has() })).toMatchObject({ ok: false, reason: expect.stringMatching(/8080/) });
    expect(runtimeBuildFile({ base: "static", port: 8080, start: null, root: "../etc", has: has() }).ok).toBe(false);
    expect(runtimeBuildFile({ base: "static", port: 8080, start: null, root: "a b", has: has() }).ok).toBe(false);
    expect(runtimeBuildFile({ base: "static", port: 8080, start: ["x"], has: has() }).ok).toBe(false);
  });

  it("a start command can't smuggle Dockerfile syntax", () => {
    const r = runtimeBuildFile({ base: "node-24", port: 3000, start: ["node", "a.js\nRUN curl evil"], has: has({ packageJson: true }) });
    expect(r.ok && r.dockerfile.split("\n").filter((l) => l.startsWith("RUN "))).toHaveLength(1);
  });
});

describe("preparing a build context", () => {
  const manifest = (runtime: Record<string, unknown>) =>
    JSON.stringify({ schema_version: 1, name: "clock", version: "0.1.0", runtime, network: { subdomain: "clock" } });

  it("replaces the app's own Dockerfile with the box's for a runtime app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-ctx-"));
    await writeFile(join(dir, "flagship.app.json"), manifest({ base: "node-24", port: 3000, start: ["node", "server.js"] }));
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "Dockerfile"), "FROM evil/image\nRUN curl attacker\n");
    await writeFile(join(dir, "containerfile"), "FROM evil/image\n");
    const rec: string[][] = [];
    await runDockerBuild({ run: async (c, a) => void rec.push([c, ...a]) }, "flagship-vibe-x:1", dir);
    const df = await readFile(join(dir, "Dockerfile"), "utf8");
    expect(df).toContain(`FROM ${RUNTIMES["node-24"].image}`);
    expect(df).not.toContain("evil");
    await expect(readFile(join(dir, "containerfile"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toContain("node_modules");
    expect(rec[0]![1]).toBe("build");
  });

  it("leaves an app without a runtime to its own Dockerfile (and the policy)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-ctx-"));
    await writeFile(join(dir, "flagship.app.json"), manifest({ image: "x:1", port: 3000 }));
    await writeFile(join(dir, "Dockerfile"), "FROM node:24-alpine\n");
    expect(await prepareRuntimeContext(dir)).toBeNull();
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe("FROM node:24-alpine\n");
  });

  it("fails the build with the reason when the runtime can't build the app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-ctx-"));
    await writeFile(join(dir, "flagship.app.json"), manifest({ base: "node-24", port: 3000 }));
    await expect(runDockerBuild({ run: async () => {} }, "x:1", dir)).rejects.toThrow("a node-24 app needs a package.json");
  });

  it("covers every base the manifest accepts", () => {
    expect(Object.keys(RUNTIMES).sort()).toEqual([...RUNTIME_BASES].sort());
  });
});
