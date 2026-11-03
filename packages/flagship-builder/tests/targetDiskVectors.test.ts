// test-vectors/install-disk-stop.json is what every Studio's "Disk to install on" field and the apps'
// disk-stop messages are checked against: it must agree with the generator.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TARGET_DISK_PATTERN } from "../src/preseed.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../../test-vectors/install-disk-stop.json"), "utf8")) as {
  targetDiskPattern: string;
  targetDisk: { valid: string[]; invalid: string[] };
  stops: Array<{ detail: string; kind: string | null }>;
};

describe("install-disk-stop vectors", () => {
  it("carry the generator's targetDisk pattern", () => {
    expect(V.targetDiskPattern).toBe(TARGET_DISK_PATTERN.source);
  });
  it("valid and invalid names agree with the generator", () => {
    for (const s of V.targetDisk.valid) expect(TARGET_DISK_PATTERN.test(s), s).toBe(true);
    for (const s of V.targetDisk.invalid) expect(TARGET_DISK_PATTERN.test(s), s).toBe(false);
  });
  it("every stop sentence is one the installer writes", () => {
    const src = readFileSync(join(__dirname, "../src/preseed.ts"), "utf8");
    for (const fragment of [
      "disks that could be erased (",
      "This machine has no fixed disk of 8 GB or more to install on",
      "is not in this machine",
      "matches more than one disk",
      "Nothing was erased.",
    ]) expect(src).toContain(fragment);
    expect(V.stops.filter((s) => s.kind).map((s) => s.kind).sort()).toEqual(["ambiguous", "missing", "none", "several", "several"]);
  });
});
