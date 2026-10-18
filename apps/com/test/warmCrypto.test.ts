/**
 * The Worker entry pays @noble/ed25519's one-time table build (about 20 ms)
 * at startup instead of in the first request. Run in a fresh process so no
 * other test has already built it.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cpuProbe = (importWarm: boolean) => `
  ${importWarm ? 'await import("./apps/com/src/warmCrypto.ts");' : ""}
  const { ed } = await import("@flagship/protocol");
  const t = process.threadCpuUsage();
  ed.getPublicKey(new Uint8Array(32).fill(7));
  const d = process.threadCpuUsage();
  console.log(((d.user + d.system) - (t.user + t.system)) / 1000);
`;

function firstUseMs(importWarm: boolean): number {
  const out = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", cpuProbe(importWarm)], {
    cwd: new URL("../../..", import.meta.url).pathname,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  expect(out.status, out.stderr).toBe(0);
  return Number(out.stdout.trim().split("\n").pop());
}

describe("warmCrypto", () => {
  it("moves the first key derivation's table build out of the first use", () => {
    const cold = firstUseMs(false);
    const warm = firstUseMs(true);
    expect(cold).toBeGreaterThan(8); // the table build is real work
    expect(warm).toBeLessThan(cold / 4);
  }, 60_000);
});
