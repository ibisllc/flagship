import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cryptoEraseLuks, luksHeaderBytes, readRetailImage, retailWipeAsRoot, type BlockIo } from "../../src/retailClaim/wipe.js";

const LUKS2_DUMP = `LUKS header information
Version:       	2
Data segments:
  0: crypt
	offset: 16777216 [bytes]
	length: (whole device)
Keyslots:
  0: luks2`;

/** A disk in memory: starts with a LUKS header and plaintext-looking key area. */
function fakeDisk(size = 32 * 1024 * 1024, opts: { ignoreWrites?: boolean } = {}) {
  const disk = Buffer.alloc(size, 0x41);
  Buffer.from("LUKS\xba\xbe", "latin1").copy(disk, 0);
  Buffer.from("SKUL\xba\xbe", "latin1").copy(disk, 16384);
  const io: BlockIo = {
    async readAt(_d, off, n) {
      return Uint8Array.from(disk.subarray(off, off + n));
    },
    async overwriteHead(_d, n) {
      if (opts.ignoreWrites) return;
      randomFillSync(disk, 0, n);
    },
  };
  return { disk, io };
}

describe("retail wipe", () => {
  it("reads the header size from luksDump", () => {
    expect(luksHeaderBytes(LUKS2_DUMP)).toBe(16 * 1024 * 1024);
    expect(luksHeaderBytes("Version: 1\nPayload offset:\t4096\n")).toBe(4096 * 512);
    expect(luksHeaderBytes("")).toBe(16 * 1024 * 1024);
  });

  it("erases key slots, overwrites the header and checks it reads back as noise", async () => {
    const { disk, io } = fakeDisk();
    const calls: string[][] = [];
    const run = async (c: string, a: string[]) => {
      calls.push([c, ...a]);
      return a[0] === "luksDump" ? LUKS2_DUMP : "";
    };
    await cryptoEraseLuks("/dev/disk/by-partlabel/flagship-data", run, io);
    expect(calls).toEqual([
      ["cryptsetup", "luksDump", "/dev/disk/by-partlabel/flagship-data"],
      ["cryptsetup", "erase", "--batch-mode", "/dev/disk/by-partlabel/flagship-data"],
    ]);
    expect(disk.subarray(0, 4).toString("latin1")).not.toBe("LUKS");
    expect(disk[16 * 1024 * 1024]).toBe(0x41);
  });

  it("fails when the header is still there afterwards", async () => {
    const { io } = fakeDisk(32 * 1024 * 1024, { ignoreWrites: true });
    await expect(cryptoEraseLuks("/dev/sda3", async () => LUKS2_DUMP, io)).rejects.toThrow(/wipe check failed/);
  });

  it("refuses a device path it does not recognise", async () => {
    const { io } = fakeDisk(1024 * 1024);
    await expect(cryptoEraseLuks("/dev/../etc/passwd", async () => "", io)).rejects.toThrow();
    await expect(cryptoEraseLuks("/tmp/x", async () => "", io)).rejects.toThrow();
  });

  it("the root step runs only on a retail image, after the marker, with a named volume", async () => {
    const { io } = fakeDisk();
    const run = async () => LUKS2_DUMP;
    const image = { v: 1 as const, dataLuksDevice: "/dev/nvme0n1", recoveryPartition: null };
    await expect(retailWipeAsRoot({ image: null, markerPresent: true, run, io })).rejects.toThrow(/retail/);
    await expect(retailWipeAsRoot({ image, markerPresent: false, run, io })).rejects.toThrow(/marker/);
    await expect(retailWipeAsRoot({ image: { ...image, dataLuksDevice: null }, markerPresent: true, run, io })).rejects.toThrow(/names no data volume/);
    expect(await retailWipeAsRoot({ image, markerPresent: true, run, io })).toEqual({ erased: true, reimaged: false });
  });

  it("reads the image marker: none on other boxes, nothing erasable when damaged", async () => {
    const missing = Object.assign(new Error("x"), { code: "ENOENT" });
    expect(await readRetailImage("/x", async () => Promise.reject(missing))).toBeNull();
    expect(await readRetailImage("/x", async () => "{")).toEqual({ v: 1, dataLuksDevice: null, recoveryPartition: null });
    expect(await readRetailImage("/x", async () => JSON.stringify({ v: 1, dataLuksDevice: "/dev/disk/by-partlabel/data", recoveryPartition: "rm -rf /" }))).toEqual({
      v: 1,
      dataLuksDevice: "/dev/disk/by-partlabel/data",
      recoveryPartition: null,
    });
  });
});
