/**
 * End-to-end exercise of the CLI:
 *   - genesis  → writes a self-signed mandate + a track policy file
 *   - mandate  → writes a holder-signed renewal
 *   - verify   → reads everything back and verifies the chain
 *   - status   → identical read path but does not exit on failure
 *
 * Goes through `dispatch()` so we cover the argv → command-dispatch → write
 * path the bin shim actually uses.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeypair } from "@maintainers/protocol";
import { dispatch, type CliEnv } from "../src/index.js";
import { parseArgs } from "../src/lib/args.js";

function keypair(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  return generateKeypair(seed);
}

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  cleanup.length = 0;
});

function setupTmp(): { root: string; cliRoot: string; keys: Record<string, string> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maintainers-cli-e2e-"));
  cleanup.push(tmp);
  const keysDir = path.join(tmp, "keys");
  fs.mkdirSync(keysDir);
  const alice = keypair(1);
  const bob = keypair(2);
  fs.writeFileSync(path.join(keysDir, "alice.pub"), alice.pubKey);
  fs.writeFileSync(path.join(keysDir, "alice.priv"), alice.privKey);
  fs.writeFileSync(path.join(keysDir, "bob.pub"), bob.pubKey);
  fs.writeFileSync(path.join(keysDir, "bob.priv"), bob.privKey);
  return {
    root: tmp,
    cliRoot: path.join(tmp, ".maintainers"),
    keys: {
      "alice.pub": path.join(keysDir, "alice.pub"),
      "alice.priv": path.join(keysDir, "alice.priv"),
      "bob.pub": path.join(keysDir, "bob.pub"),
      "bob.priv": path.join(keysDir, "bob.priv"),
    },
  };
}

function makeUuidFactory(): () => string {
  let counter = 0;
  return () => `00000000-0000-0000-0000-${(counter++).toString(16).padStart(12, "0")}`;
}

function mkEnv(now: Date, lines: string[], errs: string[], uuid: () => string): CliEnv {
  return {
    now: () => now,
    io: { readFileSync: (p: string) => fs.readFileSync(p, "utf8") },
    uuid,
    println: (line: string) => lines.push(line),
    printerr: (line: string) => errs.push(line),
  };
}

describe("end-to-end CLI dispatch", () => {
  it("genesis → mandate → verify exits 0 and reports a valid chain", () => {
    const fx = setupTmp();
    const lines: string[] = [];
    const errs: string[] = [];
    const uuid = makeUuidFactory();

    const env1 = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, uuid);
    const code1 = dispatch(parseArgs([
      "genesis",
      "--track", "release",
      "--duration", "60d",
      "--holder-key", `file:${fx.keys["alice.pub"]}`,
      "--signing-key", `file:${fx.keys["alice.priv"]}`,
      "--successors", `file:${fx.keys["bob.pub"]}`,
      "--output", fx.cliRoot,
    ]), env1);
    expect(code1).toBe(0);
    expect(fs.existsSync(path.join(fx.cliRoot, "tracks/release/policy.json"))).toBe(true);

    const env2 = mkEnv(new Date("2026-02-15T00:00:00Z"), lines, errs, uuid);
    const code2 = dispatch(parseArgs([
      "mandate",
      "--track", "release",
      "--duration", "60d",
      "--signing-key", `file:${fx.keys["alice.priv"]}`,
      "--path", fx.cliRoot,
    ]), env2);
    expect(code2).toBe(0);

    const env3 = mkEnv(new Date("2026-02-20T00:00:00Z"), lines, errs, uuid);
    const code3 = dispatch(parseArgs([
      "verify",
      "--path", fx.cliRoot,
    ]), env3);
    expect(code3).toBe(0);
    expect(lines.join("\n")).toContain("verify: OK");
  });

  it("status does not exit non-zero when policy file is missing", () => {
    const fx = setupTmp();
    const lines: string[] = [];
    const errs: string[] = [];
    const uuid = makeUuidFactory();

    const env1 = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, uuid);
    dispatch(parseArgs([
      "genesis",
      "--track", "release",
      "--duration", "60d",
      "--holder-key", `file:${fx.keys["alice.pub"]}`,
      "--signing-key", `file:${fx.keys["alice.priv"]}`,
      "--output", fx.cliRoot,
    ]), env1);
    fs.unlinkSync(path.join(fx.cliRoot, "tracks/release/policy.json"));

    const env2 = mkEnv(new Date("2026-01-15T00:00:00Z"), lines, errs, uuid);
    const code = dispatch(parseArgs([
      "status",
      "--path", fx.cliRoot,
    ]), env2);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("policy:           MISSING");
  });

  it("verify returns 1 when the policy file is missing", () => {
    const fx = setupTmp();
    const lines: string[] = [];
    const errs: string[] = [];
    const uuid = makeUuidFactory();

    const env1 = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, uuid);
    dispatch(parseArgs([
      "genesis",
      "--track", "release",
      "--duration", "60d",
      "--holder-key", `file:${fx.keys["alice.pub"]}`,
      "--signing-key", `file:${fx.keys["alice.priv"]}`,
      "--output", fx.cliRoot,
    ]), env1);
    fs.unlinkSync(path.join(fx.cliRoot, "tracks/release/policy.json"));

    const env2 = mkEnv(new Date("2026-01-15T00:00:00Z"), lines, errs, uuid);
    const code = dispatch(parseArgs([
      "verify",
      "--path", fx.cliRoot,
    ]), env2);
    expect(code).toBe(1);
  });

  it("unknown command exits 2 with usage on stderr", () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const env = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, makeUuidFactory());
    const code = dispatch(parseArgs(["banana"]), env);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown command");
  });

  it("help prints usage and exits 0", () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const env = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, makeUuidFactory());
    const code = dispatch(parseArgs(["help"]), env);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("authority-management CLI");
  });

  it("CliError from a command translates to exit 1 with an error: prefix", () => {
    const fx = setupTmp();
    const lines: string[] = [];
    const errs: string[] = [];
    const env = mkEnv(new Date("2026-01-01T00:00:00Z"), lines, errs, makeUuidFactory());
    const code = dispatch(parseArgs([
      "mandate",
      "--track", "release",
      "--duration", "60d",
      "--signing-key", `file:${fx.keys["alice.priv"]}`,
      "--path", fx.cliRoot,
    ]), env);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no prior mandates/);
  });
});
