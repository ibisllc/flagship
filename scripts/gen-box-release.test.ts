import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script
import { files, load } from "./gen-box-release.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("box release constants", () => {
  it("every generated file is in sync with release/*.json and installer/*.sh", () => {
    const r = spawnSync("node", [join(ROOT, "scripts/gen-box-release.mjs"), "--check"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("the release commit is a full 40-hex commit and the trust set is the one the installer checks", () => {
    const { value, errors } = load(ROOT);
    expect(errors).toEqual([]);
    expect(value.commit).toMatch(/^[0-9a-f]{40}$/);
    const trust = JSON.parse(readFileSync(join(ROOT, "release/box-artifact-trust.json"), "utf8"));
    expect(value.trustKeys).toEqual(trust.keys);
    expect(value.nodeFloor).toBe(JSON.parse(readFileSync(join(ROOT, "release/security-floor.json"), "utf8")).node.minimum);
  });

  it("refuses a branch, a tag, an abbreviation, a weak trust set and a plain-http base", () => {
    const dir = mkdtempSync(join(tmpdir(), "box-release-"));
    tmp.push(dir);
    cpSync(join(ROOT, "release"), join(dir, "release"), { recursive: true });
    const set = (file: string, over: Record<string, unknown>) => {
      const p = join(dir, "release", file);
      const j = JSON.parse(readFileSync(join(ROOT, "release", file), "utf8"));
      writeFileSync(p, JSON.stringify({ ...j, ...over }));
    };
    for (const [file, over, msg] of [
      ["box-release.json", { commit: "main" }, /commit must be 40/],
      ["box-release.json", { commit: "v1.2.3" }, /commit must be 40/],
      ["box-release.json", { commit: "386e29c84" }, /commit must be 40/],
      ["box-release.json", { artifactBase: "http://x.test/a" }, /https URL/],
      ["box-release.json", { artifactBase: "https://x.test/a/" }, /trailing slash/],
      ["box-artifact-trust.json", { threshold: 0 }, /threshold/],
      ["box-artifact-trust.json", { keys: ["zz"] }, /64-hex/],
    ] as Array<[string, Record<string, unknown>, RegExp]>) {
      set("box-release.json", {});
      set("box-artifact-trust.json", {});
      set(file, over);
      expect(load(dir).errors.join("\n"), JSON.stringify(over)).toMatch(msg);
    }
  });

  it("the embedded installer scripts are the scripts, byte for byte, and parse as bash", () => {
    const { value } = load(ROOT);
    const out = files(value, ROOT)["packages/flagship-builder/src/boxInstallerScripts.ts"] as string;
    expect(out).toContain(JSON.stringify(readFileSync(join(ROOT, "installer/verify-box-artifact.sh"), "utf8")));
    expect(out).toContain(JSON.stringify(readFileSync(join(ROOT, "installer/install-box-artifact.sh"), "utf8")));
    for (const f of ["verify-box-artifact.sh", "install-box-artifact.sh"]) {
      execFileSync("bash", ["-n", join(ROOT, "installer", f)]);
    }
  });
});
