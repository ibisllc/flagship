/**
 * W12 — verify build-flagship-netboot-iso.sh's argument parsing + path
 * validation logic without actually fetching the Debian ISO or
 * repacking with xorriso (those steps take minutes and need the
 * upstream Debian mirror reachable).
 *
 * Strategy:
 *   - bash -n on the script — catches every syntax error.
 *   - run with empty argv → must exit non-zero with the expected
 *     usage message.
 *   - run with a placeholder output path against an inject dir that's
 *     missing one of the four required files → must exit non-zero with
 *     the expected "missing inject source" message.
 *
 * We deliberately do NOT exercise the curl/xorriso path here. The
 * `--fetch-only` flag in the script lets a CI smoke run validate the
 * upstream pin separately; that's an operator-driven check, not a
 * vitest one (each call costs ~200MB of bandwidth).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "build-flagship-netboot-iso.sh");

describe("build-flagship-netboot-iso.sh", () => {
  it("is syntactically valid bash (bash -n + sh -n)", () => {
    for (const shell of ["bash", "sh"]) {
      const r = spawnSync(shell, ["-n", SCRIPT], { encoding: "utf8" });
      expect(r.status, `${shell} -n stderr: ${r.stderr}`).toBe(0);
    }
  });

  it("exits non-zero on missing $1", () => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage|out\.iso/i);
  });

  it("exits non-zero with a recognizable error if an inject source is missing", () => {
    // The script reads from $REPO_ROOT/packages/installer-netboot/. We
    // can't mutate the real tree, but the script resolves
    // SCRIPT_DIR=$(cd $(dirname $0) && pwd) — so if we copy the script
    // alone into a tmpdir, REPO_ROOT becomes $tmpdir/.. and the
    // packages/installer-netboot/ check fires before any network.
    const td = mkdtempSync(join(tmpdir(), "flagship-iso-test-"));
    try {
      const scriptDir = join(td, "scripts");
      mkdirSync(scriptDir, { recursive: true });
      const copied = join(scriptDir, "build-flagship-netboot-iso.sh");
      // Copy the script verbatim.
      writeFileSync(
        copied,
        require("node:fs").readFileSync(SCRIPT, "utf8"),
        { mode: 0o755 },
      );
      // No packages/installer-netboot/ in $td — the script must fail
      // before xorriso/curl.
      const r = spawnSync("bash", [copied, join(td, "out.iso")], {
        encoding: "utf8",
        env: { ...process.env, SOURCE_DATE_EPOCH: "1700000000" },
        timeout: 10_000,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(
        /missing inject source|preseed\.cfg|installer-netboot/,
      );
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("contains the expected deterministic xorriso flags", () => {
    const src = require("node:fs").readFileSync(SCRIPT, "utf8") as string;
    // Volume-id must be parameterized on the Debian version so two
    // builds at different pins don't collide.
    expect(src).toContain("-volid \"FLAGSHIP_DEBIAN_");
    // SOURCE_DATE_EPOCH must be plumbed into volume_date.
    expect(src).toContain("volume_date");
    expect(src).toContain("SOURCE_DATE_EPOCH");
    // Auto-preseed kernel args MUST land in the rewritten isolinux
    // + grub configs.
    // mini.iso flavor doesn't auto-mount /cdrom; preseed lives at
    // /preseed.cfg in the initrd root (overlay cpio).
    expect(src).toContain("auto=true priority=critical preseed/file=/preseed.cfg");
    // sha256 verification happens BEFORE any extract/repack work.
    expect(src).toMatch(/sha256sum.*\$DEBIAN_ISO/);
  });

  it("pins the Debian netinst sha256 in a documented format", () => {
    const src = require("node:fs").readFileSync(SCRIPT, "utf8") as string;
    // declare -A DEBIAN_SHA256 + at least one entry of the form
    //   DEBIAN_SHA256["<v>-<arch>"]="<64 hex chars>"
    expect(src).toContain("declare -A DEBIAN_SHA256");
    // Release id can be a code-name ("trixie") or a numeric version
    // ("12.5.0"); we just require something that looks like a release-arch key.
    expect(src).toMatch(/DEBIAN_SHA256\["[a-z0-9.]+-[a-z0-9]+"\]="[0-9a-f]{64}"/);
  });
});
