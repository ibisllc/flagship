/**
 * The install-time LUKS key removal and its single-slot proof, run for real:
 * the shell text the bootstrap embeds (userdata.ts) executes under bash against
 * a stub `cryptsetup` that keeps its key slots in a temp file. Every way the
 * proof can fail must end with a FATAL line and a non-zero exit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LUKS_ASSERT_SINGLE_SLOT_FN, buildLuksBurnSlotRemovalBlock } from "../src/userdata.js";

const STUB = `#!/bin/bash
# stub cryptsetup: keys live one per line in $LUKS_STUB_STATE/keys
S="$LUKS_STUB_STATE"
cmd="$1"; shift
case "$cmd" in
  open)
    keyfile=""
    while [ $# -gt 0 ]; do
      case "$1" in --key-file) keyfile="$2"; shift 2 ;; --test-passphrase) shift ;; *) shift ;; esac
    done
    [ -f "$keyfile" ] || exit 2
    grep -qxF "$(cat "$keyfile")" "$S/keys"
    ;;
  luksDump)
    [ -e "$S/dump-fails" ] && exit 1
    if [ -e "$S/luks1" ]; then
      echo "LUKS header information for $1"; echo "Version:        1"; echo
      i=0; while IFS= read -r _; do echo "Key Slot $i: ENABLED"; i=$((i+1)); done < "$S/keys"
      for j in $(seq $i 7); do echo "Key Slot $j: DISABLED"; done
    else
      echo "LUKS header information"; echo; echo "Version:        2"; echo "Epoch:          5"; echo
      echo "Keyslots:"
      i=0; while IFS= read -r _; do printf '  %s: luks2\\n\\tKey:        512 bits\\n\\tPriority:   normal\\n' "$i"; i=$((i+1)); done < "$S/keys"
      echo "Tokens:"; echo "Digests:"; echo "  0: pbkdf2"
    fi
    ;;
  luksRemoveKey)
    [ -e "$S/remove-fails" ] && exit 1
    keyfile=""
    while [ $# -gt 0 ]; do case "$1" in --key-file) keyfile="$2"; shift 2 ;; *) shift ;; esac; done
    k="$(cat "$keyfile")"
    grep -vxF "$k" "$S/keys" > "$S/keys.new"; mv "$S/keys.new" "$S/keys"
    ;;
  *) exit 3 ;;
esac
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "luks-slot-"));
  writeFileSync(join(dir, "cryptsetup"), STUB);
  chmodSync(join(dir, "cryptsetup"), 0o755);
  writeFileSync(join(dir, "burn"), "BURNKEY");
  writeFileSync(join(dir, "real"), "REALKEY");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function keys(...k: string[]): void {
  writeFileSync(join(dir, "keys"), k.join("\n") + (k.length ? "\n" : ""));
}

function run(script: string): { code: number; out: string } {
  const r = spawnSync("bash", ["-c", script], {
    env: { PATH: `${dir}:${process.env.PATH}`, LUKS_STUB_STATE: dir },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const assertCall = (): string =>
  `set -euo pipefail\n${LUKS_ASSERT_SINGLE_SLOT_FN}\nflagship_assert_single_luks_slot /dev/fake ${dir}/burn ${dir}/real\necho PASSED\n`;

describe("flagship_assert_single_luks_slot", () => {
  it("passes when only the real key opens the disk and one slot remains (LUKS2)", () => {
    keys("REALKEY");
    const r = run(assertCall());
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASSED");
    expect(r.out).toContain("exactly 1 enabled key slot");
  });

  it("passes on a LUKS1 header with one enabled slot", () => {
    keys("REALKEY");
    writeFileSync(join(dir, "luks1"), "");
    expect(run(assertCall()).code).toBe(0);
  });

  it("fails when the removed key still opens the disk", () => {
    keys("REALKEY", "BURNKEY");
    const r = run(assertCall());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("[flagship-bootstrap] FATAL");
    expect(r.out).toContain("still opens");
    expect(r.out).not.toContain("PASSED");
  });

  it("fails when the phone-sealed key does not open the disk", () => {
    keys("SOMETHINGELSE");
    const r = run(assertCall());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FATAL");
    expect(r.out).toContain("does not open");
  });

  it("fails when a second, unknown slot is still enabled", () => {
    keys("REALKEY", "UNKNOWNKEY");
    const r = run(assertCall());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FATAL");
    expect(r.out).toContain("has 2 enabled LUKS key slots, expected exactly 1");
  });

  it("fails on a LUKS1 header with two enabled slots", () => {
    keys("REALKEY", "UNKNOWNKEY");
    writeFileSync(join(dir, "luks1"), "");
    const r = run(assertCall());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("2 enabled LUKS key slots");
  });

  it("fails when luksDump cannot be read", () => {
    keys("REALKEY");
    writeFileSync(join(dir, "dump-fails"), "");
    const r = run(assertCall());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FATAL");
    expect(r.out).toContain("cannot read the LUKS header");
  });
});

describe("the removal step of the bootstrap (step C), executed", () => {
  const stepC = (extraEnv = ""): string =>
    `set -euo pipefail
${extraEnv}
report_phase() { echo "[phase] $*"; }
ROOT_LUKS_PART=/dev/fake
LUKS_BURN_KEYFILE=${dir}/burn
LUKS_KEY=${dir}/real
${buildLuksBurnSlotRemovalBlock()}
echo STEP_C_DONE
`;

  it("removes the install-time key, proves one slot, reports it and destroys both key files", () => {
    keys("BURNKEY", "REALKEY");
    const r = run(stepC());
    expect(r.code).toBe(0);
    expect(r.out).toContain("STEP_C_DONE");
    expect(r.out).toContain("[phase] sealing Disk key secured");
    expect(readFileSync(join(dir, "keys"), "utf8")).toBe("REALKEY\n");
    expect(existsSync(join(dir, "burn"))).toBe(false);
    expect(existsSync(join(dir, "real"))).toBe(false);
  });

  it("a luksRemoveKey that fails ends the install (non-zero, FATAL), nothing is shredded", () => {
    keys("BURNKEY", "REALKEY");
    writeFileSync(join(dir, "remove-fails"), "");
    const r = run(stepC());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FATAL: could not remove the install-time LUKS key");
    expect(r.out).not.toContain("STEP_C_DONE");
    expect(existsSync(join(dir, "burn"))).toBe(true);
  });

  it("refuses to remove anything if the new key does not open the disk", () => {
    keys("BURNKEY");
    const r = run(stepC());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("refusing to remove the install-time key");
    expect(readFileSync(join(dir, "keys"), "utf8")).toBe("BURNKEY\n");
  });

  it("an extra slot nobody sealed fails the install after the removal", () => {
    keys("BURNKEY", "REALKEY", "SPARE");
    const r = run(stepC());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("has 2 enabled LUKS key slots");
  });

  it("on a VM appliance it leaves the factory key and the new key for the specializer", () => {
    keys("BURNKEY", "REALKEY");
    const r = run(stepC("export FLAGSHIP_APPLIANCE_PREINSTALLED=1"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("left to the specializer");
    expect(readFileSync(join(dir, "keys"), "utf8")).toBe("BURNKEY\nREALKEY\n");
    expect(existsSync(join(dir, "real"))).toBe(true);
  });
});
