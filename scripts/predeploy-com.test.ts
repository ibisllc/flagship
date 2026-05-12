import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(__dirname, "predeploy-com.sh");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
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
