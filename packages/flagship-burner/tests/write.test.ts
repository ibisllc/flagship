import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteCommand, runWriteImageCommand, type WriteCommandOpts } from "../src/write.js";
import {
  deriveIRK,
  ed,
  signAuthCode,
  signInstallBlob,
  type AuthCode,
  type InstallBlob,
} from "@flagship/protocol";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "flagship-burner-write-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

async function makeFakeRecipe(): Promise<string> {
  const umk = { seed: new Uint8Array(32).fill(7) };
  const irk = deriveIRK(umk);
  const delegatedSeed = new Uint8Array(32).fill(13);
  const delegatedPub = ed.getPublicKey(delegatedSeed);
  const expires = Date.now() + 3600_000;
  const authCode: AuthCode = {
    version: 1,
    serial: "auth-1",
    username: "alice",
    serverName: "primary",
    serverDomain: "alice.flagship.services",
    delegatedPubKey: delegatedPub,
    userPubKey: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: expires,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: "alice.flagship.services",
    username: "alice",
    serverName: "primary",
    phoneDelegatedPubKey: delegatedPub,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode,
    authCodeUserSignature: signAuthCode(authCode, irk),
    installerGitRef: "main",
    rckPubKey: delegatedPub,
  };
  const sigBytes = signInstallBlob(blob, irk);
  const recipeJson = {
    version: 2,
    serverDomain: blob.serverDomain,
    username: blob.username,
    serverName: blob.serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      serial: blob.authCode.serial,
      username: blob.authCode.username,
      serverName: blob.authCode.serverName,
      serverDomain: blob.authCode.serverDomain,
      delegatedPubKey: bytesToHex(blob.authCode.delegatedPubKey),
      userPubKey: bytesToHex(blob.authCode.userPubKey),
      issuedAt: blob.authCode.issuedAt,
      expiresAt: blob.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(blob.authCodeUserSignature),
    installerGitRef: blob.installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
    blobSignatureHex: bytesToHex(sigBytes),
  };
  const recipePath = join(workDir, "recipe.json");
  await writeFile(recipePath, JSON.stringify(recipeJson));
  return recipePath;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}


/** remaster stub — writes a tiny stand-in ISO at the requested output
 *  path so the orchestration's write + cleanup still works. Avoids
 *  invoking xorriso in unit tests. */
async function stubRemaster(args: {
  srcIsoPath: string;
  outIsoPath: string;
  userDataYaml: string;
}): Promise<void> {
  await writeFile(args.outIsoPath, Buffer.alloc(2048, 0xbb));
}

describe("runWriteCommand — early gates", () => {
  it("refuses on non-root (clear sudo message)", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/nope.iso",
      isRoot: () => false,
      enumerateOpts: { os: "darwin", runCommand: async () => ({ stdout: "", stderr: "", code: 0 }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/sudo/);
    expect(r.exitCode).toBe(13);
  });

  it("refuses on win32 with a clear unsupported-platform message", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/nope.iso",
      isRoot: () => true,
      enumerateOpts: { os: "win32", runCommand: async () => ({ stdout: "", stderr: "", code: 0 }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/unsupported platform/);
  });

  it("refuses on malformed recipe (never touches the device)", async () => {
    const bad = join(workDir, "bad.json");
    await writeFile(bad, "not json");
    let writeCalled = false;
    const r = await runWriteCommand({
      recipePath: bad,
      isoPath: "/nonexistent",
      isRoot: () => true,
      writeBytesToDevice: async () => {
        writeCalled = true;
        return { bytesWritten: 0 };
      },
      enumerateOpts: { os: "linux", runCommand: async () => ({ stdout: "", stderr: "", code: 0 }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/load recipe failed/);
    expect(writeCalled).toBe(false);
  });

});

describe("runWriteCommand — happy path + device gates", () => {
  function makeLsblkRun(blockdevices: unknown[]): WriteCommandOpts["enumerateOpts"] {
    return {
      os: "linux",
      runCommand: async (cmd) => {
        if (cmd === "lsblk") {
          return {
            stdout: JSON.stringify({ blockdevices }),
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    };
  }

  it("happy path: writes to a removable USB and shreds the recipe", async () => {
    const recipePath = await makeFakeRecipe();
    let writeCalls = 0;
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdb",
      yes: true,
      isRoot: () => true,
      remaster: stubRemaster,
      writeBytesToDevice: async (a) => {
        expect(a.devicePath).toBe("/dev/sdb");
        writeCalls++;
        return { bytesWritten: 12345 };
      },
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Test USB",
        },
      ]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.devicePath).toBe("/dev/sdb");
    expect(r.bytesWritten).toBe(12345);
    expect(writeCalls).toBe(1);
    await expect(stat(recipePath)).rejects.toThrow();
  });

  it("--keep-recipe preserves the recipe file on success", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdb",
      yes: true,
      keepRecipe: true,
      isRoot: () => true,
      remaster: stubRemaster,
      writeBytesToDevice: async () => ({ bytesWritten: 7 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Test USB",
        },
      ]),
    });
    expect(r.ok).toBe(true);
    const st = await stat(recipePath);
    expect(st.size).toBeGreaterThan(0);
  });

  it("refuses --device that resolves to an internal drive", async () => {
    const recipePath = await makeFakeRecipe();
    let writeCalled = false;
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sda",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => {
        writeCalled = true;
        return { bytesWritten: 0 };
      },
      enumerateOpts: makeLsblkRun([
        {
          name: "sda",
          size: 512 * 1024 * 1024 * 1024,
          type: "disk",
          rm: false,
          tran: "sata",
          model: "Internal SSD",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/internal/);
    expect(writeCalled).toBe(false);
  });

  it("refuses --device that isn't in the enumeration", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdz",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not present|Refusing/);
  });

  it("refuses --device that's not an absolute /dev path", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "sdb",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/absolute \/dev path/);
  });

  it("--device auto with 0 eligible refuses", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "auto",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no removable-usb/);
  });

  it("--device auto with >1 eligible refuses (ambiguous)", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "auto",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "A",
        },
        {
          name: "sdc",
          size: 32 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "B",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/2 removable-usb/);
  });

  it("--yes refuses if the named device's verdict isn't removable-usb (defense in depth)", async () => {
    const recipePath = await makeFakeRecipe();
    // Device DOES exist in enumeration but is marked too-small.
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdb",
      yes: true,
      isRoot: () => true,
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 100 * 1024 * 1024, // 100MB — too small
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Tiny",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/too-small|Refusing/);
  });

  it("interactive picker uses promptForLine when no --device given", async () => {
    const recipePath = await makeFakeRecipe();
    const prompts: string[] = [];
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      yes: true,
      isRoot: () => true,
      remaster: stubRemaster,
      promptForLine: async (m) => {
        prompts.push(m);
        return "1";
      },
      writeBytesToDevice: async () => ({ bytesWritten: 99 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.devicePath).toBe("/dev/sdb");
    // Picker prompt was shown.
    expect(prompts[0]).toMatch(/Pick a device/);
  });

  it("interactive: invalid picker selection fails cleanly", async () => {
    const recipePath = await makeFakeRecipe();
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      yes: true,
      isRoot: () => true,
      promptForLine: async () => "9",
      writeBytesToDevice: async () => ({ bytesWritten: 0 }),
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/invalid picker/);
  });

  it("confirmation prompt: a non-yes answer aborts without writing", async () => {
    const recipePath = await makeFakeRecipe();
    let writeCalled = false;
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdb",
      yes: false, // require typed-yes
      isRoot: () => true,
      promptForLine: async () => "no thanks",
      writeBytesToDevice: async () => {
        writeCalled = true;
        return { bytesWritten: 0 };
      },
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ]),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/declined/);
    expect(writeCalled).toBe(false);
    // Recipe NOT shredded on abort.
    const st = await stat(recipePath);
    expect(st.size).toBeGreaterThan(0);
  });

  it("confirmation prompt: typing yes proceeds (case-insensitive, trimmed)", async () => {
    const recipePath = await makeFakeRecipe();
    let writeCalls = 0;
    const r = await runWriteCommand({
      recipePath,
      isoPath: "/tmp/ignored.iso",
      device: "/dev/sdb",
      isRoot: () => true,
      remaster: stubRemaster,
      promptForLine: async () => "  YES  ",
      writeBytesToDevice: async () => {
        writeCalls++;
        return { bytesWritten: 7 };
      },
      enumerateOpts: makeLsblkRun([
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(writeCalls).toBe(1);
  });
});

describe("runWriteImageCommand — privileged write of a prepared image", () => {
  function usbLsblk(): WriteCommandOpts["enumerateOpts"] {
    return {
      os: "linux",
      runCommand: async (cmd) => {
        if (cmd === "lsblk") {
          return {
            stdout: JSON.stringify({
              blockdevices: [
                { name: "sdb", size: 16 * 1024 * 1024 * 1024, type: "disk", rm: true, tran: "usb", model: "Cruzer" },
              ],
            }),
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    };
  }

  async function makeImage(): Promise<string> {
    const p = join(workDir, "prepared.iso");
    await writeFile(p, Buffer.alloc(4096, 0xcd));
    return p;
  }

  it("refuses when not root (clear sudo message)", async () => {
    const r = await runWriteImageCommand({
      imagePath: await makeImage(),
      device: "/dev/sdb",
      yes: true,
      isRoot: () => false,
      enumerateOpts: usbLsblk(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.exitCode).toBe(13);
  });

  it("refuses a missing image without touching the device", async () => {
    let wrote = false;
    const r = await runWriteImageCommand({
      imagePath: join(workDir, "does-not-exist.iso"),
      device: "/dev/sdb",
      yes: true,
      isRoot: () => true,
      enumerateOpts: usbLsblk(),
      writeBytesToDevice: async () => {
        wrote = true;
        return { bytesWritten: 0 };
      },
    });
    expect(r.ok).toBe(false);
    expect(wrote).toBe(false);
  });

  it("happy path: writes the prepared image to a removable USB", async () => {
    const image = await makeImage();
    let target = "";
    const r = await runWriteImageCommand({
      imagePath: image,
      device: "/dev/sdb",
      yes: true,
      isRoot: () => true,
      enumerateOpts: usbLsblk(),
      writeBytesToDevice: async (a) => {
        target = a.devicePath;
        expect(a.isoPath).toBe(image);
        return { bytesWritten: 4096 };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytesWritten).toBe(4096);
    expect(target).toBe("/dev/sdb");
  });

  it("refuses --yes on a non-removable target", async () => {
    const r = await runWriteImageCommand({
      imagePath: await makeImage(),
      device: "/dev/sda",
      yes: true,
      isRoot: () => true,
      enumerateOpts: {
        os: "linux",
        runCommand: async (cmd) =>
          cmd === "lsblk"
            ? {
                stdout: JSON.stringify({
                  blockdevices: [
                    { name: "sda", size: 500 * 1024 * 1024 * 1024, type: "disk", rm: false, tran: "sata", model: "INTERNAL" },
                  ],
                }),
                stderr: "",
                code: 0,
              }
            : { stdout: "", stderr: "", code: 0 },
      },
    });
    expect(r.ok).toBe(false);
  });
});
