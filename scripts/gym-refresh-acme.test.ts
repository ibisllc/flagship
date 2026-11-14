// gym-refresh.sh step 5b (docs/gym-test-acme.md item 8): it restarts the gym's Pebble only, and only when the gym
// Worker's config names it. Production's wrangler.toml never names a test CA.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = readFileSync(join(root, "scripts/gym-refresh.sh"), "utf8");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

function readDirectory(toml: string): string {
  const line = /^ACME_DIR="\$\((.*)\)"$/m.exec(code)![1]!.replace(/"\$WT\/apps\/com\/\$CFG"/, "/dev/stdin");
  return execFileSync("bash", ["-c", line], { input: toml, encoding: "utf8" }).trim();
}

describe("gym-refresh restarts only the gym's test CA", () => {
  it("reads ISSUANCE_ACME_DIRECTORY from the gym Worker's config", () => {
    expect(readDirectory('[vars]\nISSUANCE_ACME_DIRECTORY = "https://flagship-acme-gym.fly.dev/dir"\n')).toBe("https://flagship-acme-gym.fly.dev/dir");
    expect(readDirectory("[vars]\nSERVICES_APEX = \"gym.flagship.services\"\n")).toBe("");
    expect(readDirectory('# ISSUANCE_ACME_DIRECTORY = "https://flagship-acme-gym.fly.dev/dir"\n')).toBe("");
  });

  it("restarts nothing but flagship-acme-gym, and refuses a directory that is not it", () => {
    expect(code).toMatch(/ACME_APP="flagship-acme-gym"/);
    expect(code).toMatch(/run flyctl apps restart "\$ACME_APP"/);
    expect(code).toMatch(/https:\/\/flagship-acme-gym\.fly\.dev\/\*\) ;;\n\s*\*\) die/);
    expect([...code.matchAll(/flyctl apps restart/g)]).toHaveLength(1);
  });

  it("production's Worker config names no ACME directory (it falls back to Let's Encrypt)", () => {
    const prod = readFileSync(join(root, "apps/com/wrangler.toml"), "utf8");
    expect(prod).not.toMatch(/^\s*ISSUANCE_ACME_DIRECTORY\s*=/m);
  });
});
