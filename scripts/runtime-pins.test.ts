// Release plan G2: release/runtime-lock.json is the one Node a box runs. Every other place that names that Node (the box
// artifact's pins, the security floor, the box release floors, the CI runtimes that build and test the box) must agree
// with it, so raising the runtime is one reviewed change and a stale pin fails CI instead of shipping.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

const lock = json("release/runtime-lock.json");
const pins = json("tools/box-artifact/node-pins.json");
const floor = json("release/security-floor.json");
const cmp = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
};
// Node's own signed list for the locked release (fetched and PGP-checked by rust/crates/flagship-updater/tests/pgp_real.rs).
const signedList = new Map(
  read(`rust/crates/flagship-updater/tests/fixtures/node-${lock.version}/SHASUMS256.txt`)
    .trim()
    .split("\n")
    .map((l) => l.split(/\s+/))
    .map(([digest, file]) => [file!, digest!] as const),
);

describe("the runtime lock and every other Node pin agree", () => {
  it("the box artifact bundles the locked version from the same upstream", () => {
    expect(pins.node.version).toBe(lock.version);
    expect(pins.node.downloadBase).toBe(lock.upstream.base);
    expect(lock.upstream.base).toBe(`https://nodejs.org/dist/v${lock.version}/`);
  });

  it("both pin files name digests from Node's signed list for that release", () => {
    for (const t of Object.values(lock.targets) as { file: string; sha256: string }[]) expect(signedList.get(t.file), t.file).toBe(t.sha256);
    for (const a of Object.values(pins.node.archives) as { file: string; sha256: string }[]) expect(signedList.get(a.file), a.file).toBe(a.sha256);
  });

  it("the upstream signer keys are the same set", () => {
    const lockFps = new Set((lock.keyring.upstreamFingerprints as string[]).map((f) => f.toLowerCase()));
    const pinFps = new Set((pins.node.releaseSigningKeys.fingerprints as string[]).map((f) => f.toLowerCase()));
    expect([...lockFps].sort()).toEqual([...pinFps].sort());
    for (const s of lock.keyring.signers as { fingerprint: string }[]) expect(lockFps.has(s.fingerprint)).toBe(true);
  });

  it("the security floor is the lock's floor, and the locked version meets it", () => {
    expect(lock.securityFloor).toBe(floor.node.minimum);
    expect(cmp(lock.version, lock.securityFloor)).toBeGreaterThanOrEqual(0);
    expect(floor.node.supportedLines).toContain(lock.support.line);
    expect(Number(lock.version.split(".")[0])).toBe(lock.support.line);
  });

  it("the box release floors equal the security floor", () => {
    for (const p of [
      "packages/protocol/src/boxReleaseConfig.ts",
      "packages/control-plane/src/boxReleaseConfig.ts",
      "packages/flagship-builder/src/boxReleaseConfig.ts",
      "packages/flagship-builder/engine/preseed-engine.js",
    ]) {
      expect(/nodeFloor: "([0-9.]+)"/.exec(read(p))?.[1], p).toBe(lock.securityFloor);
    }
  });

  it("the CI jobs that build and test the box run the locked Node", () => {
    for (const p of [".github/workflows/box-artifact.yml", ".github/workflows/rust.yml"]) {
      const versions = [...read(p).matchAll(/node-version:\s*"?([0-9.]+)"?/g)].map((m) => m[1]);
      expect(versions.length, p).toBeGreaterThan(0);
      for (const v of versions) expect(v, p).toBe(lock.version);
    }
  });
});
