/**
 * Dependency policy (SECURITY-HARDENING-PLAN.md section 8.1, items 8 and 9): security-boundary
 * dependencies are exact versions, lifecycle scripts are off unless audited, and the lockfile is
 * the only source of what installs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const policy = JSON.parse(read("release/dependency-policy.json")) as {
  boundaryPackages: Record<string, string[]>;
  installScriptAllowlist: Record<string, string>;
};
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe("dependency policy", () => {
  it("pins every security-boundary dependency to one exact version", () => {
    for (const [dir, names] of Object.entries(policy.boundaryPackages)) {
      const pkg = JSON.parse(read(`${dir}/package.json`)) as { dependencies?: Record<string, string> };
      for (const name of names) {
        const spec = pkg.dependencies?.[name];
        expect(spec, `${dir} must declare ${name}`).toBeDefined();
        expect(spec, `${dir}: ${name} is not an exact version`).toMatch(EXACT);
      }
    }
  });

  it("keeps the lockfile in step with the exact pins", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    for (const [dir, names] of Object.entries(policy.boundaryPackages)) {
      const entry = lock.packages[dir];
      expect(entry, dir).toBeDefined();
      for (const name of names) {
        const pkg = JSON.parse(read(`${dir}/package.json`)) as { dependencies: Record<string, string> };
        expect(entry!.dependencies?.[name], `${dir}: lockfile records a different specifier for ${name}`).toBe(pkg.dependencies[name]);
      }
    }
  });

  it("runs no dependency lifecycle script unless it is on the audited allowlist", () => {
    expect(read(".npmrc")).toMatch(/^ignore-scripts=true$/m);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { hasInstallScript?: boolean }> };
    const withScripts = new Set(
      Object.entries(lock.packages)
        .filter(([, v]) => v.hasInstallScript)
        .map(([k]) => k.split("node_modules/").pop()!),
    );
    for (const name of withScripts) {
      expect(Object.keys(policy.installScriptAllowlist), `${name} has an install script and is not audited`).toContain(name);
    }
    for (const [name, why] of Object.entries(policy.installScriptAllowlist)) expect(why.length, name).toBeGreaterThan(20);
  });
});
