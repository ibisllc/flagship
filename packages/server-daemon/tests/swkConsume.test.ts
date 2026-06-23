import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistSwkHex, swkHexFromInstallBlob } from "../src/index.js";

// First-boot SWK provisioning: the phone embeds `swkHex` (= deriveSWK(umk,
// serverId)) as an UNSIGNED recipe sibling that the burner writes into
// install-blob.json. The daemon reads + persists it so the service/build
// platform turns on. These pin the read/parse + persist halves of that path
// (the resolution-order wiring itself lives in main(), which is the boot
// entry and not unit-tested).

const VALID_SWK = "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377";

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
    await writeBlob({ serverDomain: "abc.harry.flagship.services", swkHex: VALID_SWK.toUpperCase() });
    const resolved = await swkHexFromInstallBlob();
    expect(resolved).toBe(VALID_SWK);

    // The first-boot path persists it for stable later boots (mode 0600).
    const swkPath = join(dir, "swk.hex");
    await persistSwkHex(swkPath, resolved!);
    const onDisk = (await readFile(swkPath, "utf8")).trim();
    expect(onDisk).toBe(VALID_SWK);
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
  it("is non-fatal when the path is unwritable", async () => {
    // A directory-as-file target makes the write fail; the helper swallows it.
    await expect(persistSwkHex(dir, VALID_SWK)).resolves.toBeUndefined();
  });
});
