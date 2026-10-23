// The shared boot-unseal vectors (packages/protocol/test-vectors/boot-unseal)
// through the BUILT Go helper and, when a Rust toolchain is present, the
// BUILT Rust flagship-boot binary in its v1-compatible mode. Both must give
// the vector's secret or fail with the vector's message, byte for byte.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const V = JSON.parse(readFileSync(join(repoRoot, "packages/protocol/test-vectors/boot-unseal/vectors.json"), "utf8"));

function findTool(names: string[]): string | null {
  for (const c of names) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      try {
        execFileSync(c, ["version"], { stdio: "ignore" });
        return c;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

const go = findTool(["go", "/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go"]);
const cargo = findTool(["cargo", "/opt/homebrew/opt/rustup/bin/cargo", `${process.env.HOME}/.cargo/bin/cargo`]);
const bins: Record<string, string> = {};

beforeAll(() => {
  if (go) {
    const out = join(mkdtempSync(join(tmpdir(), "flagship-unseal-")), "flagship-unseal");
    execFileSync(go, ["build", "-o", out, "."], { cwd: join(repoRoot, "installer/unseal-helper"), stdio: "pipe", env: { ...process.env, CGO_ENABLED: "0" } });
    bins.go = out;
  }
  if (cargo) {
    execFileSync(cargo, ["build", "-p", "flagship-boot", "--bin", "flagship-boot"], { cwd: join(repoRoot, "rust"), stdio: "pipe" });
    const out = join(repoRoot, "rust/target/debug/flagship-boot");
    if (existsSync(out)) bins.rust = out;
  }
}, 600_000);

function run(bin: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

for (const impl of ["go", "rust"] as const) {
  const available = impl === "go" ? go !== null : cargo !== null;
  describe.skipIf(!available)(`boot-unseal vectors through the ${impl} binary`, () => {
    for (const c of V.unseal) {
      it(c.name, () => {
        const args = ["--identity-priv-hex", c.identityPrivHex, "--sealed-hex", c.sealedHex];
        if (c.kind === "response") args.push("--response", "--nonce-hex", c.nonceHex, "--purpose", c.purpose);
        const r = run(bins[impl]!, args);
        if (c.expect.ok) {
          expect(r).toEqual({ code: 0, stdout: `${c.expect.secretHex}\n`, stderr: "" });
        } else {
          expect(r).toEqual({ code: 1, stdout: "", stderr: `flagship-unseal: ${c.expect.error}\n` });
        }
      });
    }
  });
}
