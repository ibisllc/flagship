import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Dynamic-import the browser-shipping modules so the source we serve to
// clients is exactly what the test verifies. lib/keyfile.js imports the
// vendored @noble/hashes argon2 (apps/web/public/webapp/vendor) + WebCrypto
// AES-GCM, both of which work under Node 18+ (the vitest "node" env).
function load(rel: string) {
  const path = resolve(__dirname, "..", "public", "webapp", rel);
  return import(pathToFileURL(path).href);
}
const loadKeyfile = () => load("lib/keyfile.js");
const loadBackup = () => load("lib/keyfileBackup.js");

const GOLDEN_FILE = JSON.stringify({
  magic: "flagship-key",
  version: 1,
  username: "interop",
  accountId: "acct-golden",
  createdAt: "2026-05-25T00:00:00.000Z",
  kdf: { algo: "argon2id", m: 65536, t: 3, p: 4, saltHex: "fc6235a631ca2ca22c0335541200972a" },
  aead: "aes-256-gcm",
  nonceHex: "a032679f057a61a653814b15",
  ciphertextHex:
    "606618b0f9918b91ee724ff83ee7cb88728d9b6663899991c0e2e0133579547ec3547122d83165ebfe0d2d74fc827c24",
});
const GOLDEN_PASSPHRASE = "interop-test-passphrase";
const GOLDEN_SEED = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

// Cheap argon params keep the round-trip / wrong-passphrase tests fast.
// (The interop gate must use the file's real m=65536,t=3,p=4 — it does,
// since unwrap reads params from the file itself.)
const CHEAP = { m: 256, t: 1, p: 1 };

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("webapp `.flagshipkey` — interop with @flagship/protocol + iOS", () => {
  it("INTEROP GATE: unwraps the golden file to the expected seed", async () => {
    const { unwrapUmkFromKeyfile } = await loadKeyfile();
    const { seed, meta } = await unwrapUmkFromKeyfile(GOLDEN_FILE, GOLDEN_PASSPHRASE);
    expect(toHex(seed)).toBe(GOLDEN_SEED);
    expect(meta.username).toBe("interop");
    expect(meta.accountId).toBe("acct-golden");
    expect(meta.createdAt).toBe("2026-05-25T00:00:00.000Z");
  });

  it("wrap → unwrap round-trips the seed (argon2id + AES-256-GCM)", async () => {
    const { wrapUmkToKeyfile, unwrapUmkFromKeyfile } = await loadKeyfile();
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) & 0xff;
    const text = await wrapUmkToKeyfile(
      seed,
      "super-strong-pass",
      { username: "alice", accountId: "acct-1" },
      CHEAP,
    );
    const { seed: out, meta } = await unwrapUmkFromKeyfile(text, "super-strong-pass");
    expect(toHex(out)).toBe(toHex(seed));
    expect(meta.username).toBe("alice");
    expect(meta.accountId).toBe("acct-1");
  });

  it("produces a well-formed envelope (magic/version/kdf/aead shapes)", async () => {
    const { wrapUmkToKeyfile } = await loadKeyfile();
    const seed = new Uint8Array(32).fill(0x42);
    const text = await wrapUmkToKeyfile(seed, "another-strong-1", { username: "bob" }, CHEAP);
    const env = JSON.parse(text);
    expect(env.magic).toBe("flagship-key");
    expect(env.version).toBe(1);
    expect(env.kdf.algo).toBe("argon2id");
    expect(env.aead).toBe("aes-256-gcm");
    expect(env.kdf.saltHex).toMatch(/^[0-9a-f]{32}$/);
    expect(env.nonceHex).toMatch(/^[0-9a-f]{24}$/);
    // 32-byte seed + 16-byte GCM tag = 48 bytes = 96 hex chars.
    expect(env.ciphertextHex).toMatch(/^[0-9a-f]{96}$/);
    // accountId omitted when not supplied.
    expect("accountId" in env).toBe(false);
  });

  it("wrong passphrase throws KeyfileError code=bad-passphrase", async () => {
    const { wrapUmkToKeyfile, unwrapUmkFromKeyfile, KeyfileError } = await loadKeyfile();
    const seed = new Uint8Array(32).fill(9);
    const text = await wrapUmkToKeyfile(seed, "right-pass-here", { username: "carol" }, CHEAP);
    await expect(unwrapUmkFromKeyfile(text, "wrong-pass-here")).rejects.toMatchObject({
      name: "KeyfileError",
      code: "bad-passphrase",
    });
    // sanity: it really is the exported class
    expect(KeyfileError).toBeTypeOf("function");
  });

  it("tampering an AAD-bound header field fails decryption (bad-passphrase)", async () => {
    const { wrapUmkToKeyfile, unwrapUmkFromKeyfile } = await loadKeyfile();
    const seed = new Uint8Array(32).fill(5);
    const text = await wrapUmkToKeyfile(seed, "tamper-strong-pass", { username: "dave" }, CHEAP);
    const env = JSON.parse(text);
    env.username = "mallory"; // bound into AAD → must break the tag
    await expect(unwrapUmkFromKeyfile(JSON.stringify(env), "tamper-strong-pass")).rejects.toMatchObject({
      code: "bad-passphrase",
    });
  });

  it("non-keyfile JSON throws code=malformed", async () => {
    const { unwrapUmkFromKeyfile } = await loadKeyfile();
    await expect(unwrapUmkFromKeyfile('{"hello":"world"}', "x")).rejects.toMatchObject({
      code: "malformed",
    });
    await expect(unwrapUmkFromKeyfile("not json at all", "x")).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("unsupported version throws code=version", async () => {
    const { unwrapUmkFromKeyfile } = await loadKeyfile();
    const env = JSON.parse(GOLDEN_FILE);
    env.version = 2;
    await expect(unwrapUmkFromKeyfile(JSON.stringify(env), GOLDEN_PASSPHRASE)).rejects.toMatchObject({
      code: "version",
    });
  });
});

describe("keyfileBackup orchestration", () => {
  it("passphraseStrengthError rejects weak, accepts strong", async () => {
    const { passphraseStrengthError } = await loadBackup();
    expect(passphraseStrengthError("short")).toBeTruthy();
    expect(passphraseStrengthError("alllowercaseletters")).toBeTruthy(); // 1 class
    expect(passphraseStrengthError("Abcdefghijkl")).toBeTruthy(); // 2 classes
    expect(passphraseStrengthError("Abcdef123456")).toBeNull(); // 3 classes, 12 chars
    expect(passphraseStrengthError("Str0ng!Passphrase")).toBeNull();
  });

  it("createBackupFile downloads <username>.flagshipkey and the file unwraps", async () => {
    const { createBackupFile } = await loadBackup();
    const { unwrapUmkFromKeyfile } = await loadKeyfile();
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = i;
    let captured: { name: string; text: string } | null = null;
    const { filename } = await createBackupFile({
      seed,
      username: "Demo User!",
      accountId: "acct-x",
      passphrase: "Str0ng!Passphrase",
      download: (name: string, text: string) => {
        captured = { name, text };
      },
      argonParams: CHEAP,
    });
    expect(filename).toBe("demouser.flagshipkey"); // sanitized
    expect(captured!.name).toBe("demouser.flagshipkey");
    const { seed: out, meta } = await unwrapUmkFromKeyfile(captured!.text, "Str0ng!Passphrase");
    expect(toHex(out)).toBe(toHex(seed));
    expect(meta.accountId).toBe("acct-x");
  });

  it("restoreFromBackupFile unwraps, installs into the keystore, and unlocks the session", async () => {
    const { createBackupFile, restoreFromBackupFile } = await loadBackup();
    const seed = new Uint8Array(32).fill(0xab);
    let fileText = "";
    await createBackupFile({
      seed,
      username: "restoreme",
      passphrase: "Str0ng!Passphrase",
      download: (_n: string, t: string) => {
        fileText = t;
      },
      argonParams: CHEAP,
    });

    const keystore = {
      hasWrappedUmk: vi.fn().mockResolvedValue(false),
      resetDevice: vi.fn().mockResolvedValue(undefined),
      bootstrapFromExistingSeed: vi.fn().mockResolvedValue(undefined),
    };
    const unlockSession = vi.fn().mockResolvedValue(undefined);

    const res = await restoreFromBackupFile({
      fileText,
      passphrase: "Str0ng!Passphrase",
      localPassphrase: "device-pass-12",
      keystore,
      unlockSession,
    });

    expect(res.username).toBe("restoreme");
    expect(keystore.bootstrapFromExistingSeed).toHaveBeenCalledTimes(1);
    const [, installedSeed] = keystore.bootstrapFromExistingSeed.mock.calls[0];
    expect(toHex(installedSeed as Uint8Array)).toBe(toHex(seed));
    expect(unlockSession).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "restoreme",
    );
  });

  it("restoreFromBackupFile clears an existing identity before installing", async () => {
    const { createBackupFile, restoreFromBackupFile } = await loadBackup();
    const seed = new Uint8Array(32).fill(1);
    let fileText = "";
    await createBackupFile({
      seed,
      username: "u",
      passphrase: "Str0ng!Passphrase",
      download: (_n: string, t: string) => {
        fileText = t;
      },
      argonParams: CHEAP,
    });
    const keystore = {
      hasWrappedUmk: vi.fn().mockResolvedValue(true),
      resetDevice: vi.fn().mockResolvedValue(undefined),
      bootstrapFromExistingSeed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreFromBackupFile({
      fileText,
      passphrase: "Str0ng!Passphrase",
      localPassphrase: "device-pass-12",
      keystore,
      unlockSession: vi.fn().mockResolvedValue(undefined),
    });
    expect(keystore.resetDevice).toHaveBeenCalledTimes(1);
  });

  it("importErrorMessage maps codes to the approved copy", async () => {
    const { importErrorMessage, KEYFILE_COPY } = await loadBackup();
    const { KeyfileError } = await loadKeyfile();
    expect(importErrorMessage(new KeyfileError("x", "bad-passphrase"))).toBe(
      KEYFILE_COPY.importBadPassphrase,
    );
    expect(importErrorMessage(new KeyfileError("x", "malformed"))).toBe(
      KEYFILE_COPY.importBadFile,
    );
    expect(importErrorMessage(new KeyfileError("x", "version"))).toBe(
      KEYFILE_COPY.importBadFile,
    );
  });
});
