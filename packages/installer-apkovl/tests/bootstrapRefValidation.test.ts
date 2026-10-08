/**
 * Validates the `validate_ref` shell function inside
 * scripts/flagship-bootstrap.start. The script's whole job is to fetch
 * code from a public URL using a ref string the trailer pins. If a
 * crafted ref slips through with '..' or shell metacharacters, the
 * curl URL turns into "raw.githubusercontent.com/.../foo;cat /etc/...."
 * or escapes to a different repo entirely — both end-of-the-world bad
 * for a script that runs as root at first boot.
 *
 * The validation is shell-side (busybox sh in the apkovl) so we test
 * it by sourcing the script's validate_ref function into a subshell
 * and feeding it candidate refs.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOTSTRAP_PATH = join(
  __dirname,
  "..",
  "scripts",
  "flagship-bootstrap.start",
);

/**
 * Extract just the validate_ref function definition from the bootstrap
 * script and invoke it under a subshell with the candidate. Returns
 * {exitCode, stdout, stderr}. We don't run the whole bootstrap (which
 * would try to mount disks etc.); we just smoke the function in
 * isolation.
 *
 * The function body is delimited by `validate_ref() {` ... `}` and is
 * the only multi-line function in the file, so a simple grep-style
 * extraction is enough — we also assert presence with an unmistakable
 * marker so a future refactor that renames or moves the function
 * causes a loud failure rather than a silent skip.
 */
function runValidate(ref: string): { code: number; stdout: string; stderr: string } {
  const source = readFileSync(BOOTSTRAP_PATH, "utf8");
  const startMarker = "validate_ref() {";
  const startIdx = source.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error(
      `validate_ref function not found in ${BOOTSTRAP_PATH} — refactor broke the contract`,
    );
  }
  // Find the matching closing '}' at column 0.
  const tail = source.slice(startIdx);
  const lines = tail.split("\n");
  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      endLine = i;
      break;
    }
  }
  if (endLine < 0) {
    throw new Error("could not find closing brace for validate_ref()");
  }
  const fn = lines.slice(0, endLine + 1).join("\n");
  // Use `sh -c` to source the function then invoke with the candidate.
  // We pass the ref via argv[1] to avoid quoting headaches.
  const program = `${fn}\nvalidate_ref "$1" "test-label"\n`;
  const res = spawnSync("sh", ["-c", program, "sh", ref], { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

describe("validate_ref — accepts well-formed refs", () => {
  for (const ref of [
    "main",
    "release/2026.05",
    "v1.2.3",
    "v1.2.3-rc.1",
    "feature/my-branch",
    "abc123def456",
    "9e3f1a2b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f", // 40-char SHA
    "wendy/feat-x",
    "release-1.0",
  ]) {
    it(`accepts ${JSON.stringify(ref)}`, () => {
      const r = runValidate(ref);
      expect(r.code).toBe(0);
    });
  }
});

describe("validate_ref — rejects directory-traversal attempts", () => {
  for (const ref of [
    "..",
    "../etc/passwd",
    "main/..",
    "main/../foo",
    "foo/..bar", // contains '..' substring even without separator
    "..foo",
  ]) {
    it(`rejects ${JSON.stringify(ref)}`, () => {
      const r = runValidate(ref);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/refusing to install/);
    });
  }
});

describe("validate_ref — rejects shell-metacharacter injections", () => {
  for (const ref of [
    "main;curl evil",
    "main$(curl evil)",
    "main`whoami`",
    "main|cat",
    "main&exit",
    "main\n/etc/passwd",
    "main ",
    'main"',
    "main'",
    "main\\back",
    "main%20",
    "main:8080",
    "main?q=1",
    "main#frag",
    "main@v1",
  ]) {
    it(`rejects ${JSON.stringify(ref)}`, () => {
      const r = runValidate(ref);
      expect(r.code).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/refusing to install/);
    });
  }
});

describe("validate_ref — rejects empty / null refs", () => {
  it("rejects empty string", () => {
    const r = runValidate("");
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/empty or null/);
  });
  it('rejects "null" (jq -r prints this when the JSON key is absent)', () => {
    const r = runValidate("null");
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/empty or null/);
  });
});

describe("validate_ref is actually wired into the install paths", () => {
  it("calls validate_ref before fetching boot-stage.sh", () => {
    const source = readFileSync(BOOTSTRAP_PATH, "utf8");
    // The "already installed" branch: a malformed /boot/installer-ref
    // must abort before curl runs.
    const alreadyInstalledBlock = source.slice(
      source.indexOf('if [ -f "$INSTALLED_FLAG" ]'),
      source.indexOf("# Find the boot medium"),
    );
    expect(alreadyInstalledBlock).toMatch(
      /validate_ref[^]*?installer-ref[^]*?curl/m,
    );
  });

  it("calls validate_ref before fetching install.sh", () => {
    const source = readFileSync(BOOTSTRAP_PATH, "utf8");
    // The fresh-install branch: jq pulls REF from the trailer JSON;
    // the ref must be validated before it's substituted into the URL.
    const installBlock = source.slice(source.indexOf("installerGitRef"));
    expect(installBlock).toMatch(/validate_ref[^]*?installerGitRef[^]*?INSTALLER_URL/m);
  });
});
