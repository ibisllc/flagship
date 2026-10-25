/**
 * Whole-server backups carry a WASI app's exact module (P04 backup/restore):
 * the archive accepts a `module` part only for an app whose signed manifest
 * names that module's digest, and refuses a WASI app without it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealDataFile } from "../../src/serverArchive/format.js";
import { checkArchiveContents } from "../../src/serverArchive/restore.js";

const KEY = Buffer.alloc(32, 7);
const ID = "arch-wasi";
const MODULE = readFileSync(resolve(__dirname, "../../../../rust/crates/flagship-wasi/tests/fixtures/sdk-wasi-fixture.wasm"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DIGEST = `sha256:${sha(MODULE)}`;
const SID = "alice--notes";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "archive-wasi-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manifestJson(digest: string | null): string {
  return JSON.stringify({
    schema_version: 2,
    name: "notes",
    version: "1.0.0",
    runtime: { kind: "wasi", module: "app.wasm", world: "http-proxy", port: 8080, ...(digest ? { digest } : {}) },
    data: {},
    network: { subdomain: "notes" },
    access: { enabled: true, default_role: "viewer" },
    migration: { portable: true, verification: "standard" },
  });
}

async function archive(meta: Record<string, unknown>, withModule: boolean): Promise<string> {
  const pack = tar.pack();
  const add = (name: string, body: Buffer) => pack.entry({ name, size: body.length }, body);
  add("manifest.json", Buffer.from(JSON.stringify({ v: 1, archiveId: ID, createdAt: 1, sourceServer: "home.alice.flagship.services", apps: [{ serviceId: SID, name: "notes" }], left: [], frontPage: null, includes: [], excludes: [] })));
  add(`apps/${SID}/meta.json`, Buffer.from(JSON.stringify(meta)));
  if (withModule) add(`apps/${SID}/module.wasm`, MODULE);
  pack.finalize();
  const out = join(dir, `a-${Math.random().toString(16).slice(2)}.data`);
  await sealDataFile(Readable.from(pack), KEY, ID, out);
  return out;
}

function meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    serviceId: SID,
    creator: "alice",
    slug: "notes",
    name: "notes",
    manifestJson: manifestJson(DIGEST),
    rebuild: "module",
    appliedMigrations: [],
    parts: [{ name: "module", file: `apps/${SID}/module.wasm`, bytes: MODULE.length, sha256: sha(MODULE) }],
    access: null,
    membership: null,
    env: {},
    accessList: null,
    apiKeys: [],
    ...over,
  };
}

describe("a WASI app in a whole-server backup", () => {
  it("carries its module and is accepted", async () => {
    await expect(checkArchiveContents(await archive(meta(), true), KEY, ID)).resolves.toMatchObject({ apps: 1 });
  });

  it("refuses a WASI app that says it carries no module, or names none", async () => {
    await expect(checkArchiveContents(await archive(meta({ rebuild: "pull", parts: [] }), false), KEY, ID)).rejects.toThrow(/carries its module/);
    await expect(checkArchiveContents(await archive(meta({ manifestJson: manifestJson(null) }), true), KEY, ID)).rejects.toThrow(/carries its module/);
    await expect(checkArchiveContents(await archive(meta({ parts: [] }), false), KEY, ID)).rejects.toThrow(/no module/);
  });

  it("refuses a module whose bytes are not the ones recorded", async () => {
    const bad = meta({ parts: [{ name: "module", file: `apps/${SID}/module.wasm`, bytes: MODULE.length, sha256: "0".repeat(64) }] });
    await expect(checkArchiveContents(await archive(bad, true), KEY, ID)).rejects.toThrow();
  });
});
