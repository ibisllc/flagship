import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  parseMacosDiskList,
  classifyMacosDisk,
  parseLsblk,
  enumerateDevices,
  fmtSize,
  MIN_DEVICE_SIZE_BYTES,
  MAX_DEVICE_SIZE_BYTES,
  type CommandRunner,
} from "../src/devices.js";

describe("computeVerdict — safety classification", () => {
  it("hard-refuses /dev/disk0 (macOS system drive) even if marked external", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk0",
      sizeBytes: 32 * 1024 * 1024 * 1024,
      internal: false,
      removable: true,
      bus: "USB",
      virtual: false,
    });
    expect(v.verdict).toBe("internal");
    expect(v.reason).toMatch(/disk0/);
  });

  it("refuses devices smaller than 500MB as too-small", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk5",
      sizeBytes: 100 * 1024 * 1024,
      internal: false,
      removable: true,
      bus: "USB",
      virtual: false,
    });
    expect(v.verdict).toBe("too-small");
  });

  it("refuses devices larger than 500GB as probably-internal", () => {
    const v = computeVerdict({
      devicePath: "/dev/sdb",
      sizeBytes: 1024 * 1024 * 1024 * 1024,
      internal: false,
      removable: true,
      bus: "USB",
      virtual: false,
    });
    expect(v.verdict).toBe("internal");
    expect(v.reason).toMatch(/500\.00GB/);
  });

  it("refuses devices marked internal by the OS", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk1",
      sizeBytes: 16 * 1024 * 1024 * 1024,
      internal: true,
      removable: false,
      bus: "PCI-Express",
      virtual: false,
    });
    expect(v.verdict).toBe("internal");
    expect(v.reason).toMatch(/internal/);
  });

  it("refuses virtual disk images as unknown (not physical hardware)", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk5",
      sizeBytes: 8 * 1024 * 1024 * 1024,
      internal: false,
      removable: true,
      bus: "Disk Image",
      virtual: true,
    });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toMatch(/virtual/);
  });

  it("approves a removable USB in the safe-size band", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk5",
      sizeBytes: 16 * 1024 * 1024 * 1024,
      internal: false,
      removable: true,
      bus: "USB",
      virtual: false,
    });
    expect(v.verdict).toBe("removable-usb");
    expect(v.reason).toMatch(/16/);
  });

  it("refuses USB with zero size as unknown", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk5",
      sizeBytes: 0,
      internal: false,
      removable: true,
      bus: "USB",
      virtual: false,
    });
    expect(v.verdict).toBe("unknown");
  });

  it("refuses ambiguous non-removable non-internal as unknown", () => {
    const v = computeVerdict({
      devicePath: "/dev/disk9",
      sizeBytes: 16 * 1024 * 1024 * 1024,
      internal: false,
      removable: false,
      bus: "SCSI",
      virtual: false,
    });
    expect(v.verdict).toBe("unknown");
  });

  it("MIN/MAX constants are sane", () => {
    expect(MIN_DEVICE_SIZE_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_DEVICE_SIZE_BYTES).toBe(500 * 1024 * 1024 * 1024);
  });
});

describe("parseMacosDiskList", () => {
  it("extracts DeviceIdentifier entries from AllDisksAndPartitions", () => {
    const plist = {
      AllDisksAndPartitions: [
        { DeviceIdentifier: "disk4", OSInternal: false },
        { DeviceIdentifier: "disk5", OSInternal: false },
      ],
    };
    expect(parseMacosDiskList(plist)).toEqual(["disk4", "disk5"]);
  });

  it("returns [] for malformed plist", () => {
    expect(parseMacosDiskList(null)).toEqual([]);
    expect(parseMacosDiskList({})).toEqual([]);
    expect(parseMacosDiskList({ AllDisksAndPartitions: "no" })).toEqual([]);
  });

  it("skips entries without DeviceIdentifier", () => {
    const plist = {
      AllDisksAndPartitions: [
        { DeviceIdentifier: "disk4" },
        {},
        { DeviceIdentifier: "disk5" },
      ],
    };
    expect(parseMacosDiskList(plist)).toEqual(["disk4", "disk5"]);
  });
});

describe("classifyMacosDisk", () => {
  it("classifies an external USB stick as removable-usb", () => {
    const info = classifyMacosDisk("disk5", {
      DeviceIdentifier: "disk5",
      DeviceNode: "/dev/disk5",
      Size: 32 * 1024 * 1024 * 1024,
      Internal: false,
      Removable: true,
      Ejectable: true,
      MediaName: "SanDisk Ultra USB 3.0",
      BusProtocol: "USB",
      MountPoint: "",
    });
    expect(info.verdict).toBe("removable-usb");
    expect(info.bus).toBe("USB");
    expect(info.model).toBe("SanDisk Ultra USB 3.0");
    expect(info.mounted).toBe(false);
  });

  it("classifies the macOS system drive as internal", () => {
    const info = classifyMacosDisk("disk0", {
      DeviceIdentifier: "disk0",
      DeviceNode: "/dev/disk0",
      Size: 500 * 1024 * 1024 * 1024,
      Internal: true,
      Removable: false,
      MediaName: "APPLE SSD",
      BusProtocol: "PCI-Express",
    });
    expect(info.verdict).toBe("internal");
  });

  it("classifies a mounted Disk Image as unknown (virtual)", () => {
    const info = classifyMacosDisk("disk5", {
      DeviceIdentifier: "disk5",
      DeviceNode: "/dev/disk5",
      Size: 9 * 1024 * 1024 * 1024,
      Internal: false,
      Removable: true,
      MediaName: "Disk Image",
      BusProtocol: "Disk Image",
      VirtualOrPhysical: "Virtual",
      MountPoint: "/Volumes/foo",
    });
    expect(info.verdict).toBe("unknown");
    expect(info.mounted).toBe(true);
  });

  it("falls back gracefully on a near-empty info plist", () => {
    const info = classifyMacosDisk("disk9", {});
    expect(info.devicePath).toBe("/dev/disk9");
    expect(info.sizeBytes).toBe(0);
    expect(info.model).toBe("(unknown model)");
    expect(info.verdict).toBe("unknown");
  });
});

describe("parseLsblk", () => {
  it("classifies a USB stick as removable-usb", () => {
    const lsblk = {
      blockdevices: [
        {
          name: "sdb",
          size: 16 * 1024 * 1024 * 1024,
          type: "disk",
          rm: true,
          ro: false,
          model: "Ultra USB 3.0",
          vendor: "SanDisk",
          tran: "usb",
          mountpoint: null,
          hotplug: true,
        },
      ],
    };
    const r = parseLsblk(lsblk);
    expect(r).toHaveLength(1);
    expect(r[0]!.verdict).toBe("removable-usb");
    expect(r[0]!.devicePath).toBe("/dev/sdb");
    expect(r[0]!.bus).toBe("USB");
    expect(r[0]!.model).toBe("SanDisk Ultra USB 3.0");
  });

  it("classifies an internal SATA SSD as internal", () => {
    const lsblk = {
      blockdevices: [
        {
          name: "sda",
          size: 512 * 1024 * 1024 * 1024,
          type: "disk",
          rm: false,
          tran: "sata",
          model: "Internal SSD",
          mountpoint: null,
          children: [
            { name: "sda1", type: "part", mountpoint: "/boot" },
            { name: "sda2", type: "part", mountpoint: "/" },
          ],
        },
      ],
    };
    const r = parseLsblk(lsblk);
    expect(r).toHaveLength(1);
    expect(r[0]!.verdict).toBe("internal");
    expect(r[0]!.mounted).toBe(true);
  });

  it("classifies an NVMe drive as internal", () => {
    const lsblk = {
      blockdevices: [
        {
          name: "nvme0n1",
          size: 1024 * 1024 * 1024 * 1024,
          type: "disk",
          rm: false,
          tran: "nvme",
          model: "Samsung 990",
        },
      ],
    };
    const r = parseLsblk(lsblk);
    expect(r[0]!.verdict).toBe("internal");
  });

  it("skips non-disk entries (partitions, loop, rom)", () => {
    const lsblk = {
      blockdevices: [
        { name: "sda1", type: "part" },
        { name: "loop0", type: "loop" },
        { name: "sr0", type: "rom" },
      ],
    };
    expect(parseLsblk(lsblk)).toEqual([]);
  });

  it("handles size as string (lsblk on some distros)", () => {
    const lsblk = {
      blockdevices: [
        {
          name: "sdc",
          size: String(8 * 1024 * 1024 * 1024),
          type: "disk",
          rm: true,
          tran: "usb",
          model: "Cruzer",
        },
      ],
    };
    const r = parseLsblk(lsblk);
    expect(r[0]!.verdict).toBe("removable-usb");
    expect(r[0]!.sizeBytes).toBe(8 * 1024 * 1024 * 1024);
  });

  it("returns [] on malformed json", () => {
    expect(parseLsblk(null)).toEqual([]);
    expect(parseLsblk({})).toEqual([]);
    expect(parseLsblk({ blockdevices: "no" })).toEqual([]);
  });
});

describe("enumerateDevices — platform routing + command injection", () => {
  it("returns [] on an unsupported platform", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (cmd) => {
      calls.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = await enumerateDevices({ os: "win32", runCommand: run });
    expect(r).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("linux path: shells out to lsblk and parses JSON", async () => {
    const run: CommandRunner = async (cmd, argv) => {
      expect(cmd).toBe("lsblk");
      expect(argv).toContain("-J");
      return {
        stdout: JSON.stringify({
          blockdevices: [
            {
              name: "sdb",
              size: 16 * 1024 * 1024 * 1024,
              type: "disk",
              rm: true,
              tran: "usb",
              model: "Cruzer",
            },
          ],
        }),
        stderr: "",
        code: 0,
      };
    };
    const r = await enumerateDevices({ os: "linux", runCommand: run });
    expect(r).toHaveLength(1);
    expect(r[0]!.devicePath).toBe("/dev/sdb");
    expect(r[0]!.verdict).toBe("removable-usb");
  });

  it("linux path: returns [] when lsblk exits non-zero", async () => {
    const run: CommandRunner = async () => ({
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });
    const r = await enumerateDevices({ os: "linux", runCommand: run });
    expect(r).toEqual([]);
  });

  it("linux path: returns [] when lsblk returns junk", async () => {
    const run: CommandRunner = async () => ({
      stdout: "not json {",
      stderr: "",
      code: 0,
    });
    const r = await enumerateDevices({ os: "linux", runCommand: run });
    expect(r).toEqual([]);
  });
});

describe("fmtSize", () => {
  it("formats bytes, KB, MB, GB", () => {
    expect(fmtSize(100)).toBe("100B");
    expect(fmtSize(2048)).toBe("2.0KB");
    expect(fmtSize(2 * 1024 * 1024)).toBe("2.0MB");
    expect(fmtSize(16 * 1024 * 1024 * 1024)).toBe("16.00GB");
  });
});
