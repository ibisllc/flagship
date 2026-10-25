/**
 * The TS broker and the Rust broker (rust/crates/flagship-broker) give the same verdict, code and
 * message for every request in the corpus, and the same exact command when they allow one.
 *
 * - vectors/v1-policy.json holds the corpus and the TS verdicts; this test fails when the TS policy
 *   drifts from the file (rewrite it with UPDATE_PRIVD_VECTORS=1 after a deliberate change) and the
 *   Rust test privd_conformance.rs fails when the Rust policy does.
 * - When the Rust binary is built (`cargo build -p flagship-broker` in rust/, or
 *   FLAGSHIP_BROKER_RUST_BIN), the corpus also runs through `flagship-broker check-v1` live,
 *   including the release trust each binary was built with.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrivdError, THIS_RELEASE_TRUST, validateRequest, type Exec, type Op, type PolicyContext, type ReleaseTrust } from "../src/index.js";
import { CORPUS, TEST_TRUST, type CorpusCase } from "./corpus.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VECTORS = fileURLToPath(new URL("./vectors/v1-policy.json", import.meta.url));
const BIN = process.env.FLAGSHIP_BROKER_RUST_BIN ?? join(ROOT, "rust/target/debug/flagship-broker");
const DEFAULTS = { engine: "docker" as const, mounts: "", arch: "amd64", trust: TEST_TRUST };

type Verdict = { ok: true; exec: Record<string, unknown> } | { ok: false; code: string; message: string };

function execJson(e: Exec): Record<string, unknown> {
  return {
    file: e.file,
    args: e.args,
    timeoutMs: e.timeoutMs,
    ...(e.input !== undefined ? { input: e.input } : {}),
    ...(e.stdinFile !== undefined ? { stdinFile: e.stdinFile } : {}),
    ...(e.stdoutFile !== undefined ? { stdoutFile: e.stdoutFile } : {}),
    ...(e.env && Object.keys(e.env).length ? { env: e.env } : {}),
    ...(e.copyIn?.length ? { copyIn: e.copyIn } : {}),
  };
}

function tsVerdict(c: Pick<CorpusCase, "op" | "args" | "engine" | "mounts" | "arch">, trust: ReleaseTrust): Verdict {
  const mounts = c.mounts ?? DEFAULTS.mounts;
  const ctx: PolicyContext = { engine: c.engine ?? DEFAULTS.engine, mounts: () => mounts, trust, arch: c.arch ?? DEFAULTS.arch };
  try {
    return { ok: true, exec: execJson(validateRequest(c.op as Op, c.args as Record<string, unknown>, ctx)) };
  } catch (e) {
    return { ok: false, code: e instanceof PrivdError ? e.code : "bad-request", message: (e as Error).message };
  }
}

// As the broker receives them: through JSON, so an own `__proto__` key stays a key.
const wire: CorpusCase[] = JSON.parse(JSON.stringify(CORPUS)) as CorpusCase[];
const computed = wire.map((c) => ({ ...c, expect: tsVerdict(c, (c.trust as unknown as ReleaseTrust) ?? DEFAULTS.trust) }));

describe("the shared v1 policy vectors", () => {
  it("are what the TS broker answers", () => {
    const file = { about: "privd v1 policy vectors: generated from packages/privd/tests/corpus.ts by conformance.test.ts (UPDATE_PRIVD_VECTORS=1); the Rust broker must give the same verdicts (privd_conformance.rs).", defaults: DEFAULTS, cases: computed };
    if (process.env.UPDATE_PRIVD_VECTORS === "1") writeFileSync(VECTORS, `${JSON.stringify(file, null, 1)}\n`);
    const stored = JSON.parse(readFileSync(VECTORS, "utf8")) as typeof file;
    expect(stored.defaults).toEqual(DEFAULTS);
    expect(stored.cases.length).toBe(computed.length);
    for (let i = 0; i < computed.length; i++) expect(stored.cases[i], computed[i]!.name).toEqual(computed[i]);
  });

  it("cover every op, both engines, allowed and refused", () => {
    const ops = new Set(computed.map((c) => c.op));
    for (const op of ["power", "systemd.restart", "systemctl", "docker", "docker.file", "host", "iptables.restore", "nft.apply", "release", "wipe", "setup"]) {
      expect(computed.some((c) => c.op === op && c.expect.ok), `${op} allowed`).toBe(true);
      expect(computed.some((c) => c.op === op && !c.expect.ok), `${op} refused`).toBe(true);
      expect(ops.has(op)).toBe(true);
    }
    expect(computed.filter((c) => c.engine === "podman" && c.expect.ok).length).toBeGreaterThan(20);
    expect(computed.length).toBeGreaterThan(400);
  });
});

describe.skipIf(!existsSync(BIN))("the Rust broker, live", () => {
  it("gives the TS verdict for every request, and checks a release against the same trust", () => {
    const releaseCases = [
      { op: "release", args: { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, arch: "amd64" },
      { op: "release", args: { action: "install", commit: "b".repeat(40), sha256: "c".repeat(64) }, arch: "arm64" },
    ];
    const lines = [
      ...computed.map((c) => ({ op: c.op, args: c.args, engine: c.engine ?? DEFAULTS.engine, mounts: c.mounts ?? DEFAULTS.mounts, arch: c.arch ?? DEFAULTS.arch, trust: c.trust ?? DEFAULTS.trust })),
      ...releaseCases.map((c) => ({ ...c, engine: "docker", mounts: "", trust: "release" })),
    ];
    const r = spawnSync(BIN, ["check-v1"], { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const rust = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Verdict);
    expect(rust.length).toBe(lines.length);
    const mismatches: string[] = [];
    computed.forEach((c, i) => {
      if (JSON.stringify(sortKeys(rust[i])) !== JSON.stringify(sortKeys(c.expect))) mismatches.push(`${c.name}: ts=${JSON.stringify(c.expect)} rust=${JSON.stringify(rust[i])}`);
    });
    expect(mismatches).toEqual([]);
    releaseCases.forEach((c, i) => {
      expect(sortKeys(rust[computed.length + i])).toEqual(sortKeys(tsVerdict({ ...c, engine: "docker" }, THIS_RELEASE_TRUST)));
    });
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
