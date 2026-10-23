import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLIANCE_FACTORY_LUKS_RECORD,
  APPLIANCE_REKEY_MARKER,
  APPLIANCE_SPECIALIZED_FLAG,
  SHARED_KEY_ACTIVITY_KIND,
  checkApplianceDiskKey,
  luksDigestFingerprint,
  warnIfSharedApplianceDiskKey,
  type ApplianceDiskKeyDeps,
} from "../src/applianceDiskKey.js";
import {
  APPLIANCE_FACTORY_LUKS_RECORD as IMAGE_RECORD,
  APPLIANCE_REKEY_MARKER as IMAGE_MARKER,
  LUKS_KEY_FINGERPRINT_FNS,
} from "../../flagship-builder/src/applianceDiskKey.js";

const dump = (digest: string): string =>
  [
    "LUKS header information",
    "Version:       \t2",
    "",
    "Keyslots:",
    "  0: luks2",
    "\tKey:        512 bits",
    "Tokens:",
    "Digests:",
    "  0: pbkdf2",
    "\tHash:       sha256",
    `\tSalt:       ${digest.slice(0, 16)}`,
    `\tDigest:     ${digest}`,
    "",
    "",
  ].join("\n");

const FACTORY_DUMP = dump("aa".repeat(32));
const OWN_DUMP = dump("bb".repeat(32));
const FACTORY_FP = luksDigestFingerprint(FACTORY_DUMP)!;

function deps(files: Record<string, string>, luks: string | null): ApplianceDiskKeyDeps & { files: Record<string, string> } {
  return {
    files,
    exists: async (p) => p in files,
    readText: async (p) => files[p] ?? null,
    rootLuksDump: async () => luks,
  };
}

const record = JSON.stringify({ version: 1, volumeKeySha256: "cc".repeat(32), digestSha256: FACTORY_FP });

describe("luksDigestFingerprint", () => {
  it("hashes exactly what the image's shell helper hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-fp-"));
    try {
      writeFileSync(join(dir, "dump"), FACTORY_DUMP);
      writeFileSync(join(dir, "cryptsetup"), `#!/bin/bash\ncat "${dir}/dump"\n`);
      chmodSync(join(dir, "cryptsetup"), 0o755);
      const r = spawnSync("bash", ["-c", `set -euo pipefail\n${LUKS_KEY_FINGERPRINT_FNS}\nflagship_luks_digest_fp /dev/fake`], {
        env: { PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(FACTORY_FP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("differs when the volume key digest differs and is null without a Digests section", () => {
    expect(luksDigestFingerprint(OWN_DUMP)).not.toBe(FACTORY_FP);
    expect(luksDigestFingerprint("LUKS header information\nKeyslots:\n")).toBeNull();
  });
  it("uses the same paths the image writes", () => {
    expect(APPLIANCE_FACTORY_LUKS_RECORD).toBe(IMAGE_RECORD);
    expect(APPLIANCE_REKEY_MARKER).toBe(IMAGE_MARKER);
  });
});

describe("checkApplianceDiskKey", () => {
  it("ignores a box installed from the USB/ISO installer", async () => {
    expect(await checkApplianceDiskKey(deps({}, FACTORY_DUMP))).toEqual({ state: "not-appliance" });
  });
  it("flags an appliance box whose specializer never re-encrypted", async () => {
    const v = await checkApplianceDiskKey(deps({ [APPLIANCE_SPECIALIZED_FLAG]: "x" }, OWN_DUMP));
    expect(v).toEqual({ state: "shared-key", reason: "never-rekeyed" });
  });
  it("flags a box whose header still carries the factory digest", async () => {
    const v = await checkApplianceDiskKey(deps({
      [APPLIANCE_SPECIALIZED_FLAG]: "x", [APPLIANCE_REKEY_MARKER]: "{}", [APPLIANCE_FACTORY_LUKS_RECORD]: record,
    }, FACTORY_DUMP));
    expect(v).toEqual({ state: "shared-key", reason: "factory-digest" });
  });
  it("accepts a re-encrypted box", async () => {
    const v = await checkApplianceDiskKey(deps({
      [APPLIANCE_SPECIALIZED_FLAG]: "x", [APPLIANCE_REKEY_MARKER]: "{}", [APPLIANCE_FACTORY_LUKS_RECORD]: record,
    }, OWN_DUMP));
    expect(v.state).toBe("own-key");
  });
  it("reports unknown, not shared, when it cannot read what it needs", async () => {
    const base = { [APPLIANCE_SPECIALIZED_FLAG]: "x", [APPLIANCE_REKEY_MARKER]: "{}" };
    expect((await checkApplianceDiskKey(deps(base, OWN_DUMP))).state).toBe("unknown");
    expect((await checkApplianceDiskKey(deps({ ...base, [APPLIANCE_FACTORY_LUKS_RECORD]: "{bad" }, OWN_DUMP))).state).toBe("unknown");
    expect((await checkApplianceDiskKey(deps({ ...base, [APPLIANCE_FACTORY_LUKS_RECORD]: record }, null))).state).toBe("unknown");
  });
});

describe("warnIfSharedApplianceDiskKey", () => {
  it("notes Activity once and remembers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-key-warn-"));
    try {
      const marker = join(dir, "appliance-disk-key-warning.json");
      const notes: string[] = [];
      const d = deps({ [APPLIANCE_SPECIALIZED_FLAG]: "x" }, OWN_DUMP);
      const realExists = d.exists;
      d.exists = async (p) => (p === marker ? existsSync(marker) : realExists(p));
      const run = () => warnIfSharedApplianceDiskKey({ deps: d, warnedMarkerPath: marker, note: (k) => notes.push(k), log: () => {} });
      expect((await run()).state).toBe("shared-key");
      expect((await run()).state).toBe("shared-key");
      expect(notes).toEqual([SHARED_KEY_ACTIVITY_KIND]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("says nothing on a box with its own key", async () => {
    const notes: string[] = [];
    await warnIfSharedApplianceDiskKey({
      deps: deps({ [APPLIANCE_SPECIALIZED_FLAG]: "x", [APPLIANCE_REKEY_MARKER]: "{}", [APPLIANCE_FACTORY_LUKS_RECORD]: record }, OWN_DUMP),
      warnedMarkerPath: "/nonexistent/x", note: (k) => notes.push(k), log: () => {},
    });
    expect(notes).toEqual([]);
  });
});
