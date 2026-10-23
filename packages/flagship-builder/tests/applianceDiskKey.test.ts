/**
 * The appliance re-key, run for real: the shell text the specializer embeds
 * executes under bash against a stub `cryptsetup` that keeps the volume key,
 * key slots and an unfinished re-encryption in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLIANCE_FACTORY_LUKS_RECORD,
  APPLIANCE_REKEY_BLOCK,
  LUKS_KEY_FINGERPRINT_FNS,
  buildApplianceFactoryLuksRecordBlock,
} from "../src/applianceDiskKey.js";
import { buildAppliancePrepareScript, buildApplianceSpecializerScript } from "../src/appliance.js";

const STUB = `#!/bin/bash
S="$LUKS_STUB_STATE"
echo "$*" >> "$S/calls"
cmd="$1"; shift
dev=""; keyfile=""; vkfile=""; dumpvk=0; resume=0; backup=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key-file) keyfile="$2"; shift 2 ;;
    --volume-key-file) vkfile="$2"; shift 2 ;;
    --header-backup-file) backup="$2"; shift 2 ;;
    --dump-volume-key) dumpvk=1; shift ;;
    --resume-only) resume=1; shift ;;
    --resilience|--progress-frequency) shift 2 ;;
    --*) shift ;;
    *) dev="$1"; shift ;;
  esac
done
opens() { [ -f "$keyfile" ] && grep -qxF "$(cat "$keyfile")" "$S/keys"; }
case "$cmd" in
  luksDump)
    [ -e "$S/dump-fails" ] && exit 1
    if [ "$dumpvk" = 1 ]; then
      opens || exit 2
      [ -e "$vkfile" ] && exit 5
      cat "$S/vk" > "$vkfile"
      exit 0
    fi
    echo "LUKS header information"; echo "Version:       	2"
    [ -e "$S/pending" ] && echo "Requirements:	online-reencrypt-v2"
    echo; echo "Keyslots:"
    i=0; while IFS= read -r _; do printf '  %s: luks2\\n\\tKey:        512 bits\\n' "$i"; i=$((i+1)); done < "$S/keys"
    echo "Tokens:"; echo "Digests:"; echo "  0: pbkdf2"
    printf '\\tDigest:     %s\\n' "$(cat "$S/vk" | od -An -tx1 | tr -d ' \\n')"
    ;;
  luksHeaderBackup)
    [ -e "$backup" ] && exit 1
    echo "HEADER-OF-$(cat "$S/vk")" > "$backup"
    ;;
  reencrypt)
    opens || exit 2
    if [ "$resume" = 1 ]; then [ -e "$S/pending" ] || exit 1; fi
    [ -e "$S/reencrypt-fails" ] && { echo "Reencryption failed."; exit 1; }
    echo "Progress:  12.5%, ETA 01:00,  100 MiB written, speed 100.0 MiB/s"
    echo "Progress:  55.0%, ETA 00:30,  500 MiB written, speed 100.0 MiB/s"
    echo "Finished, time 01:00.000, 1000 MiB written, speed 100.0 MiB/s"
    [ -e "$S/reencrypt-noop" ] && exit 0
    [ -e "$S/stay-pending" ] && { touch "$S/pending"; exit 0; }
    echo "fresh-volume-key-$RANDOM-$$" > "$S/vk"
    rm -f "$S/pending"
    ;;
  *) exit 3 ;;
esac
`;

const FACTORY_VK = "factory-volume-key-shared-by-every-box\n";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "appliance-rekey-"));
  writeFileSync(join(dir, "cryptsetup"), STUB);
  chmodSync(join(dir, "cryptsetup"), 0o755);
  writeFileSync(join(dir, "build.key"), "FACTORYPASS");
  writeFileSync(join(dir, "keys"), "FACTORYPASS\n");
  writeFileSync(join(dir, "vk"), FACTORY_VK);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bash(script: string): { code: number; out: string } {
  const r = spawnSync("bash", ["-c", script], {
    env: { PATH: `${dir}:${process.env.PATH}`, LUKS_STUB_STATE: dir },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function recordFactory(): void {
  const r = bash(`set -euo pipefail
ROOT_LUKS_PART=/dev/fake
${buildApplianceFactoryLuksRecordBlock(`${dir}/build.key`).replace(APPLIANCE_FACTORY_LUKS_RECORD, `${dir}/record.json`).replace(APPLIANCE_FACTORY_LUKS_RECORD, `${dir}/record.json`).replace(/\/run\)/, `${dir})`)}`);
  expect(r.code, r.out).toBe(0);
}

function specialize(): { code: number; out: string } {
  return bash(`set -euo pipefail
report() { echo "REPORT $1 $2"; }
stage() { echo "STAGE $1"; report installing "$1"; }
ROOT_LUKS_PART=/dev/fake
FLAGSHIP_LUKS_BUILD_KEY=${dir}/build.key
FLAGSHIP_LUKS_FACTORY_RECORD=${dir}/record.json
FLAGSHIP_LUKS_REKEY_MARKER=${dir}/var/rekeyed.json
FLAGSHIP_LUKS_HEADER_BACKUP=${dir}/boot-header.img
FLAGSHIP_LUKS_TMP=${dir}
${APPLIANCE_REKEY_BLOCK}
echo CONTINUED
`);
}

const calls = (): string[] => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);

describe("appliance factory LUKS record", () => {
  it("records both fingerprints without printing the key", () => {
    recordFactory();
    const rec = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
    expect(rec.version).toBe(1);
    expect(rec.volumeKeySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.digestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, `flagship-vk.${process.pid}`))).toBe(false);
  });
});

describe("appliance re-key", () => {
  it("re-encrypts a factory disk with journal resilience after backing up the header", () => {
    recordFactory();
    const factory = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
    const r = specialize();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("CONTINUED");
    expect(r.out).not.toContain(FACTORY_VK.trim());
    const c = calls();
    const backup = c.findIndex((l) => l.startsWith("luksHeaderBackup /dev/fake"));
    const reenc = c.findIndex((l) => l.startsWith("reencrypt /dev/fake"));
    expect(backup).toBeGreaterThan(-1);
    expect(backup).toBeLessThan(reenc);
    expect(c[reenc]).toContain("--resilience journal");
    expect(c[reenc]).toContain(`--key-file ${dir}/build.key`);
    expect(c[reenc]).toContain("--batch-mode");
    expect(c[reenc]).not.toContain("--resume-only");
    expect(readFileSync(join(dir, "vk"), "utf8")).not.toBe(FACTORY_VK);
    const marker = JSON.parse(readFileSync(join(dir, "var/rekeyed.json"), "utf8"));
    expect(marker.factoryDigestSha256).toBe(factory.digestSha256);
    expect(marker.digestSha256).not.toBe(factory.digestSha256);
    expect(existsSync(join(dir, "boot-header.img"))).toBe(false);
    expect(r.out).toContain("REPORT installing Giving this server its own disk encryption key (10%)");
    expect(r.out).toContain("REPORT installing Giving this server its own disk encryption key (50%)");
  });

  it("resumes an interrupted re-encryption instead of starting over", () => {
    recordFactory();
    writeFileSync(join(dir, "vk"), "half-way-new-key\n");
    writeFileSync(join(dir, "pending"), "");
    writeFileSync(join(dir, "boot-header.img"), "HEADER-OF-factory\n");
    const r = specialize();
    expect(r.code, r.out).toBe(0);
    const c = calls();
    expect(c.some((l) => l.startsWith("luksHeaderBackup"))).toBe(false);
    const reenc = c.filter((l) => l.startsWith("reencrypt"));
    expect(reenc).toHaveLength(1);
    expect(reenc[0]).toContain("--resume-only");
    expect(r.out).toContain("STAGE Resuming this server's own disk encryption key");
    expect(existsSync(join(dir, "var/rekeyed.json"))).toBe(true);
    expect(existsSync(join(dir, "boot-header.img"))).toBe(false);
  });

  it("keeps a header backup from an earlier attempt rather than overwriting it", () => {
    recordFactory();
    writeFileSync(join(dir, "boot-header.img"), "HEADER-OF-factory\n");
    writeFileSync(join(dir, "reencrypt-fails"), "");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(calls().some((l) => l.startsWith("luksHeaderBackup"))).toBe(false);
    expect(readFileSync(join(dir, "boot-header.img"), "utf8")).toBe("HEADER-OF-factory\n");
  });

  it("skips the re-encryption on a retry once the disk has its own key", () => {
    recordFactory();
    writeFileSync(join(dir, "vk"), "already-own-key\n");
    const r = specialize();
    expect(r.code, r.out).toBe(0);
    expect(calls().some((l) => l.startsWith("reencrypt"))).toBe(false);
    expect(r.out).toContain("already has its own encryption key");
    expect(existsSync(join(dir, "var/rekeyed.json"))).toBe(true);
  });

  it("fails the install loudly when cryptsetup fails, and never continues", () => {
    recordFactory();
    writeFileSync(join(dir, "reencrypt-fails"), "");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("[appliance] FATAL: could not give the disk its own encryption key");
    expect(r.out).toContain("REPORT error Setup failed: could not give the disk its own encryption key");
    expect(r.out).not.toContain("CONTINUED");
    expect(existsSync(join(dir, "var/rekeyed.json"))).toBe(false);
  });

  it("fails when cryptsetup claims success but the volume key did not change", () => {
    recordFactory();
    writeFileSync(join(dir, "reencrypt-noop"), "");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: the disk still has the shared factory encryption key");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("fails when the re-encryption is still pending afterwards", () => {
    recordFactory();
    writeFileSync(join(dir, "stay-pending"), "");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: the disk re-encryption did not finish");
  });

  it("fails without the factory record", () => {
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: the image has no record of its factory disk key");
    expect(calls().some((l) => l.startsWith("reencrypt"))).toBe(false);
  });

  it("fails on a malformed factory record", () => {
    writeFileSync(join(dir, "record.json"), JSON.stringify({ version: 1, volumeKeySha256: "nope", digestSha256: "x" }));
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: the factory disk key record is malformed");
  });

  it("refuses to re-encrypt a factory disk with a second key slot", () => {
    recordFactory();
    writeFileSync(join(dir, "keys"), "FACTORYPASS\nOTHER\n");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("more than one key slot");
    expect(calls().some((l) => l.startsWith("reencrypt"))).toBe(false);
  });

  it("fails when the header cannot be read", () => {
    recordFactory();
    writeFileSync(join(dir, "dump-fails"), "");
    const r = specialize();
    expect(r.code).toBe(1);
    expect(r.out).toContain("FATAL: cannot read the disk's LUKS header");
  });
});

describe("specializer wiring", () => {
  const script = buildApplianceSpecializerScript();
  it("re-keys after the recipe check and before the disk grows or the bootstrap runs", () => {
    const rekey = script.indexOf("flagship_luks_run_reencrypt \"$ROOT_LUKS_PART\" \"$REKEY_BUILD_KEY\" fresh");
    expect(rekey).toBeGreaterThan(script.indexOf('stage "Checking the server recipe"'));
    expect(rekey).toBeLessThan(script.indexOf('growpart "/dev/$ROOT_PARENT"'));
    expect(rekey).toBeLessThan(script.indexOf("FLAGSHIP_APPLIANCE_PREINSTALLED=1 /usr/local/sbin/flagship-bootstrap.sh"));
    expect(script).toContain("FLAGSHIP_LUKS_BUILD_KEY=/etc/flagship/appliance-build.key");
  });
  it("checks the key again before the box is marked specialized", () => {
    const recheck = script.indexOf('[ "$SEALED_DIGEST_FP" != "$FACTORY_DIGEST_FP" ]');
    expect(recheck).toBeGreaterThan(script.indexOf('flagship_assert_single_luks_slot "$ROOT_LUKS_PART"'));
    expect(recheck).toBeLessThan(script.indexOf("date > /var/flagship/appliance-specialized.flag"));
  });
  it("the factory records the image key in the prepared image", () => {
    const prepare = buildAppliancePrepareScript({ gitRef: "main" });
    expect(prepare).toContain(`> ${APPLIANCE_FACTORY_LUKS_RECORD}`);
    expect(prepare.indexOf(APPLIANCE_FACTORY_LUKS_RECORD)).toBeGreaterThan(prepare.indexOf("> /etc/flagship/appliance-build.key"));
    expect(prepare.indexOf(APPLIANCE_FACTORY_LUKS_RECORD)).toBeLessThan(prepare.indexOf("touch /etc/flagship/appliance-ready"));
  });
  it("both scripts parse", () => {
    for (const s of [script, buildAppliancePrepareScript({ gitRef: "main" }), LUKS_KEY_FINGERPRINT_FNS]) {
      const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});
