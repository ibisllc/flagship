import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed } from "../../../packages/protocol/src/edSync.js";
import { buildRuntimeManifest, verifyRuntimeManifestFile } from "../runtime-manifest.js";

const LOCK = readFileSync(join(import.meta.dirname, "../../../release/runtime-lock.json"), "utf8");
const SEED = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed.getPublicKey(SEED)).toString("hex");
const trust = { keys: [PUB], threshold: 1 };
const NOW = 1_800_000_000_000;

describe("runtime-manifest tool", () => {
  it("builds from the committed lock, signs with a key file and verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "rtm-"));
    try {
      const keyFile = join(dir, "key");
      writeFileSync(keyFile, Buffer.from(SEED).toString("hex"));
      const tool = join(import.meta.dirname, "../runtime-manifest.ts");
      const run = (...a: string[]) => execFileSync("npx", ["tsx", tool, ...a], { encoding: "utf8" });
      run("build", "--sequence", "3", "--issued-at", String(NOW), "--out", join(dir, "u.json"));
      run("sign", "--manifest", join(dir, "u.json"), "--out", join(dir, "s.json"), "--key-file", keyFile);
      const signed = JSON.parse(readFileSync(join(dir, "s.json"), "utf8"));
      expect(signed.manifest.version).toBe(JSON.parse(LOCK).version);
      expect(signed.lockJson).toBe(LOCK);
      expect(verifyRuntimeManifestFile(signed, trust, NOW + 1000).ok).toBe(true);
      expect(verifyRuntimeManifestFile(signed, trust, NOW + 100 * 86_400_000)).toMatchObject({ ok: false, code: "expired" });
      expect(verifyRuntimeManifestFile(signed, trust, NOW + 1000, 3)).toMatchObject({ ok: false, code: "rollback" });
      expect(verifyRuntimeManifestFile({ ...signed, lockJson: LOCK + "\n" }, trust, NOW + 1000)).toMatchObject({ ok: false, code: "lock-mismatch" });
      const trustFile = join(dir, "trust.json");
      writeFileSync(trustFile, JSON.stringify(trust));
      const ok = spawnSync("npx", ["tsx", tool, "verify", "--manifest", join(dir, "s.json"), "--trust", trustFile, "--now", String(NOW + 1000)], { encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("verified: node");
      const bad = spawnSync("npx", ["tsx", tool, "verify", "--manifest", join(dir, "s.json"), "--trust", trustFile, "--now", String(NOW + 100 * 86_400_000)], { encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("refused: expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a lock that does not parse into a manifest", () => {
    expect(() => buildRuntimeManifest(JSON.stringify({ runtime: "node", version: "x", securityFloor: "1.0.0" }), { sequence: 1, issuedAt: NOW, validDays: 30 })).toThrow();
  });
});
