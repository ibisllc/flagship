import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEYD_REQUIRED_PROPERTIES } from "../packages/keyd/src/unit.js";

const SCRIPT = new URL("../installer/verify-keyd-unit.sh", import.meta.url).pathname;

function shown(over: Record<string, string> = {}): string {
  const props = { ...KEYD_REQUIRED_PROPERTIES, RestrictAddressFamilies: "AF_UNIX", ...over };
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

function run(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "verify-keyd-"));
  try {
    writeFileSync(join(dir, "show"), text);
    return spawnSync("bash", [SCRIPT, "--from", join(dir, "show")], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("verify-keyd-unit.sh", () => {
  it("accepts the properties the unit is generated with", () => {
    const r = run(shown());
    expect(r.status, r.stdout).toBe(0);
  });

  it("names every weakened property", () => {
    const r = run(shown({ NoNewPrivileges: "no", PrivateNetwork: "no", CapabilityBoundingSet: "cap_sys_admin", RestrictAddressFamilies: "AF_UNIX AF_INET", User: "root", LimitCORE: "infinity" }));
    expect(r.status).toBe(1);
    for (const k of ["NoNewPrivileges", "PrivateNetwork", "CapabilityBoundingSet", "RestrictAddressFamilies", "User", "LimitCORE"]) expect(r.stdout).toContain(`MISMATCH ${k}`);
  });

  it("fails when a required property is missing altogether", () => {
    const r = run(shown().replace(/^MemoryDenyWriteExecute=yes\n/m, ""));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("MISMATCH MemoryDenyWriteExecute");
  });
});
