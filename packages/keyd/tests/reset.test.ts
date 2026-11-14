import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeydService, readKeyFile, resetKeydState } from "../src/index.js";

function ownedState(): string {
  const dir = mkdtempSync(join(tmpdir(), "keyd-reset-"));
  for (const f of ["identity", "identity-mldsa", "swk", "cgk"]) writeFileSync(join(dir, `${f}.key`), "11".repeat(32) + "\n", { mode: 0o400 });
  for (const f of ["policy.json", "owner.json", "archive-keks.json", "revocations.json", "ca-keys.json", "revocation-list.json", "audit.log", "acme-account.key", "provision-ceremony.token"]) writeFileSync(join(dir, f), "{\"previous\":\"owner\"}");
  mkdirSync(join(dir, "tls"));
  writeFileSync(join(dir, "tls", "home.alice.flagship.services.key"), "old tls key");
  return dir;
}

describe("keyd reset", () => {
  it("leaves only a fresh STK and ML-DSA seed, readable by the serving keyd", () => {
    const dir = ownedState();
    const old = new KeydService({ identitySeed: readKeyFile(join(dir, "identity.key"))! });
    const r = resetKeydState(dir);
    expect(readdirSync(dir).sort()).toEqual(["identity-mldsa.key", "identity.key"]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o400);
    const seed = readKeyFile(join(dir, "identity.key"))!;
    const pq = readKeyFile(join(dir, "identity-mldsa.key"))!;
    const fresh = new KeydService({ identitySeed: seed, pqSeed: pq });
    expect(fresh.publicKeyHex).toBe(r.publicKeyHex);
    expect(fresh.publicKeyHex).not.toBe(old.publicKeyHex);
    expect(Buffer.from(seed).toString("hex")).not.toBe(Buffer.from(pq).toString("hex"));
  });

  it("two resets never give the same key, and an empty or missing folder works", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "keyd-reset-")), "state");
    const a = resetKeydState(dir);
    const b = resetKeydState(dir);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.mldsaPubHex).not.toBe(b.mldsaPubHex);
  });
});
