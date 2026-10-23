import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed, signOfflineSecrets, swkCommitment } from "@flagship/protocol";
import { persistSwkHex, swkHexFromInstallBlob as readSwk } from "../src/index.js";

// First-boot SWK provisioning: the phone embeds `swkHex` (= deriveSWK(umk,
// serverId)) as an UNSIGNED recipe sibling that the builder writes into
// install-blob.json. The daemon reads + persists it so the service/build
// platform turns on. These pin the read/parse + persist halves of that path
// (the resolution-order wiring itself lives in main(), which is the boot
// entry and not unit-tested).

const VALID_SWK = "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377";
const DOMAIN = "abc.harry.flagship.services";
const OWNER = (() => {
  const privateKey = new Uint8Array(32).fill(0x21);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
})();
const AUTH = { serial: "SERIAL1", issuedAt: 1_760_000_000_000, expiresAt: 1_760_003_600_000 };
const commitment = (over: Partial<{ serverDomain: string; serial: string; swk: string; issuedAt: number }> = {}) =>
  signOfflineSecrets(
    { serverDomain: over.serverDomain ?? DOMAIN, serial: over.serial ?? AUTH.serial, swkSha256Hex: swkCommitment(Uint8Array.from(Buffer.from(over.swk ?? VALID_SWK, "hex"))), issuedAt: over.issuedAt ?? AUTH.issuedAt + 1000 },
    OWNER,
  );
const signedBlob = (over: Record<string, unknown> = {}) => ({ serverDomain: DOMAIN, authCode: AUTH, swkHex: VALID_SWK, offlineSecrets: commitment(), ...over });
const swkHexFromInstallBlob = (userPub: Uint8Array = OWNER.publicKey) => readSwk({ ownerIrkPub: userPub, serverDomain: DOMAIN });

let dir: string;
const savedEnv = process.env.FLAGSHIP_INSTALL_BLOB;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-swk-"));
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.FLAGSHIP_INSTALL_BLOB;
  else process.env.FLAGSHIP_INSTALL_BLOB = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

async function writeBlob(obj: unknown): Promise<string> {
  const p = join(dir, "install-blob.json");
  await writeFile(p, JSON.stringify(obj));
  process.env.FLAGSHIP_INSTALL_BLOB = p;
  return p;
}

describe("swkHexFromInstallBlob", () => {
  it("(a) resolves a valid swkHex sibling, lowercased, then persistSwkHex writes swk.hex", async () => {
    await writeBlob(signedBlob({ swkHex: VALID_SWK.toUpperCase() }));
    const resolved = await swkHexFromInstallBlob();
    expect(resolved).toBe(VALID_SWK);

    // The first-boot path persists it for stable later boots (mode 0600).
    const swkPath = join(dir, "swk.hex");
    await persistSwkHex(swkPath, resolved!);
    const onDisk = (await readFile(swkPath, "utf8")).trim();
    expect(onDisk).toBe(VALID_SWK);
  });

  it("(SEC-RECIPE-001) ignores a workload key the owner did not sign for this server and order", async () => {
    const refused: string[] = [];
    const read = (userPub: Uint8Array = OWNER.publicKey) => readSwk({ ownerIrkPub: userPub, serverDomain: DOMAIN, onRefused: (w) => refused.push(w) });
    // No commitment at all: the file alone is not enough.
    await writeBlob({ serverDomain: DOMAIN, authCode: AUTH, swkHex: VALID_SWK });
    expect(await read()).toBeNull();
    // A commitment for a different key (someone swapped the key in the file).
    const other = "11".repeat(32);
    await writeBlob(signedBlob({ swkHex: other }));
    expect(await read()).toBeNull();
    // For another server, another order, issued outside the order's life, or by another account.
    await writeBlob(signedBlob({ offlineSecrets: commitment({ serverDomain: "xyz.harry.flagship.services" }) }));
    expect(await read()).toBeNull();
    await writeBlob(signedBlob({ offlineSecrets: commitment({ serial: "SERIAL2" }) }));
    expect(await read()).toBeNull();
    await writeBlob(signedBlob({ offlineSecrets: commitment({ issuedAt: AUTH.expiresAt + 5 }) }));
    expect(await read()).toBeNull();
    await writeBlob(signedBlob());
    expect(await read(ed.getPublicKey(new Uint8Array(32).fill(0x22)))).toBeNull();
    expect(refused).toEqual(["missing", "wrong-secret", "wrong-server", "wrong-order", "outside-order-validity", "bad-signature"]);
    // And the genuine one is accepted.
    await writeBlob(signedBlob());
    expect(await read()).toBe(VALID_SWK);
  });

  it("(b) returns null when the blob carries no swkHex (older recipe)", async () => {
    await writeBlob({ serverDomain: "abc.harry.flagship.services" });
    expect(await swkHexFromInstallBlob()).toBeNull();
  });

  it("(b) returns null when the install blob is absent entirely", async () => {
    process.env.FLAGSHIP_INSTALL_BLOB = join(dir, "does-not-exist.json");
    expect(await swkHexFromInstallBlob()).toBeNull();
  });

  it("(c) ignores a malformed swkHex sibling (wrong length / non-hex)", async () => {
    await writeBlob({ swkHex: "deadbeef" });
    expect(await swkHexFromInstallBlob()).toBeNull();

    await writeBlob({ swkHex: "z".repeat(64) });
    expect(await swkHexFromInstallBlob()).toBeNull();

    await writeBlob({ swkHex: 12345 });
    expect(await swkHexFromInstallBlob()).toBeNull();
  });

  it("(c) ignores a malformed (non-JSON) install blob without throwing", async () => {
    const p = join(dir, "install-blob.json");
    await writeFile(p, "{not json");
    process.env.FLAGSHIP_INSTALL_BLOB = p;
    expect(await swkHexFromInstallBlob()).toBeNull();
  });
});

describe("persistSwkHex", () => {
  it("surfaces an unwritable target so a consumed deposit is never marked durable", async () => {
    await expect(persistSwkHex(dir, VALID_SWK)).rejects.toThrow();
  });
});
