import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "predeploy-com.sh");

function run(
  args: string[],
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("predeploy-com.sh — wrangler --route(s) guard", () => {
  it("exits 0 when no args are passed", () => {
    const r = run([]);
    expect(r.code).toBe(0);
  });

  it("exits 0 for a clean deploy command (only safe flags)", () => {
    const r = run(["deploy", "--env", "production", "--minify"]);
    expect(r.code).toBe(0);
  });

  it("rejects --routes with a space-separated value", () => {
    const r = run(["deploy", "--routes", "flagshipserver.com/*"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
    expect(r.stderr).toContain("apps/com/wrangler.toml");
  });

  it("rejects --route (singular) with a space-separated value", () => {
    const r = run(["deploy", "--route", "flagshipserver.com/*"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
  });

  it("rejects --routes=value form", () => {
    const r = run(["deploy", "--routes=flagshipserver.com/*"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
    expect(r.stderr).toContain("--routes=flagshipserver.com/*");
  });

  it("rejects --route=value form", () => {
    const r = run(["deploy", "--route=flagshipserver.com/*"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
    expect(r.stderr).toContain("--route=flagshipserver.com/*");
  });

  it("rejects when the bad flag is mixed in with safe flags", () => {
    const r = run(["deploy", "--env", "production", "--routes", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
  });

  it("error message points to apps/com/wrangler.toml", () => {
    const r = run(["--routes=foo"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("apps/com/wrangler.toml");
    expect(r.stderr).toContain("Edit the");
  });

  it("does NOT misfire on flags that merely contain the substring 'route'", () => {
    // Defensive: future wrangler flags might include the word "route"
    // without being the foot-gun (e.g. --routes-config-file would be
    // bad, but a hypothetical --some-route-thing isn't on our radar).
    // We only block exact --route / --routes / --route= / --routes=.
    const r = run(["--router-thing", "--routed-output"]);
    expect(r.code).toBe(0);
  });
});

describe("predeploy-com.sh — build-freshness gate (dist vs src)", () => {
  let fixtureRoot: string | null = null;

  afterEach(() => {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = null;
    }
  });

  // Build a throwaway packages/<pkg>/{src,dist} fixture tree the script
  // can point at via FLAGSHIP_DIST_CHECK_ROOT. mtimes are set explicitly
  // so the comparison is deterministic.
  function makeFixture(
    pkgs: Array<{
      name: string;
      srcMtime: number; // epoch seconds
      distMtime: number | null; // null = no dist dir at all
    }>,
  ): string {
    const root = mkdtempSync(join(tmpdir(), "predeploy-fixture-"));
    fixtureRoot = root;
    for (const pkg of pkgs) {
      const srcDir = join(root, "packages", pkg.name, "src");
      mkdirSync(srcDir, { recursive: true });
      const srcFile = join(srcDir, "index.ts");
      writeFileSync(srcFile, "export const x = 1;\n");
      utimesSync(srcFile, pkg.srcMtime, pkg.srcMtime);
      if (pkg.distMtime !== null) {
        const distDir = join(root, "packages", pkg.name, "dist");
        mkdirSync(distDir, { recursive: true });
        const distFile = join(distDir, "index.js");
        writeFileSync(distFile, "export const x = 1;\n");
        utimesSync(distFile, pkg.distMtime, pkg.distMtime);
      }
    }
    return root;
  }

  it("passes when every bundled dist is newer than its src", () => {
    const root = makeFixture([
      { name: "control-plane", srcMtime: 1000, distMtime: 2000 },
      { name: "storage", srcMtime: 1000, distMtime: 2000 },
      { name: "protocol", srcMtime: 1000, distMtime: 2000 },
    ]);
    const r = run(["deploy"], { FLAGSHIP_DIST_CHECK_ROOT: root });
    expect(r.code).toBe(0);
  });

  it("fails when a bundled package's src is newer than its dist", () => {
    const root = makeFixture([
      { name: "control-plane", srcMtime: 3000, distMtime: 2000 },
      { name: "storage", srcMtime: 1000, distMtime: 2000 },
      { name: "protocol", srcMtime: 1000, distMtime: 2000 },
    ]);
    const r = run(["deploy"], { FLAGSHIP_DIST_CHECK_ROOT: root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
    expect(r.stderr).toContain("control-plane");
    expect(r.stderr).toContain("npx tsc -b");
  });

  it("fails when a bundled package has no dist directory at all", () => {
    const root = makeFixture([
      { name: "control-plane", srcMtime: 1000, distMtime: 2000 },
      { name: "storage", srcMtime: 1000, distMtime: null },
      { name: "protocol", srcMtime: 1000, distMtime: 2000 },
    ]);
    const r = run(["deploy"], { FLAGSHIP_DIST_CHECK_ROOT: root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO DEPLOY");
    expect(r.stderr).toContain("storage(dist missing)");
  });

  it("can be bypassed with FLAGSHIP_SKIP_DIST_FRESHNESS=1", () => {
    const root = makeFixture([
      { name: "control-plane", srcMtime: 3000, distMtime: 2000 },
      { name: "storage", srcMtime: 1000, distMtime: 2000 },
      { name: "protocol", srcMtime: 1000, distMtime: 2000 },
    ]);
    const r = run(["deploy"], {
      FLAGSHIP_DIST_CHECK_ROOT: root,
      FLAGSHIP_SKIP_DIST_FRESHNESS: "1",
    });
    expect(r.code).toBe(0);
  });

  it("the route guard still fires even when dist is fresh", () => {
    const root = makeFixture([
      { name: "control-plane", srcMtime: 1000, distMtime: 2000 },
      { name: "storage", srcMtime: 1000, distMtime: 2000 },
      { name: "protocol", srcMtime: 1000, distMtime: 2000 },
    ]);
    const r = run(["deploy", "--routes", "x"], {
      FLAGSHIP_DIST_CHECK_ROOT: root,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--route(s) flag detected");
  });
});
