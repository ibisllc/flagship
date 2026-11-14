/**
 * Which app an app is and which code it ran (docs/restore-into-server.md §1,
 * §2): origins, legacy origins, code histories and the comparisons a restore
 * into a running server is built on.
 */
import { describe, expect, it } from "vitest";
import { ed, signInstallService, verifyInstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import {
  MAX_CODE_HISTORY,
  appendCode,
  carriedLineage,
  compareCode,
  compareSchema,
  compareVersions,
  isLegacyOrigin,
  legacyOrigin,
  manifestCodeDigest,
  migrationsToRun,
  mintOrigin,
  parseLineage,
  schemaGuard,
  treeDigest,
} from "../src/appLineage.js";
import { ServicePlatform, lineageOf } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";
import { InMemoryInstalledServicesStore } from "../src/installedServicesStore.js";

const e = (digest: string, version = "1.0.0", at = 1) => ({ digest, version, at });
const D = (c: string) => `tree:${c.repeat(64)}`;

describe("origins", () => {
  it("a new app's origin is 16 random bytes; a legacy one is the SHA-256 of its id and agrees everywhere", () => {
    const a = mintOrigin();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(mintOrigin()).not.toBe(a);
    expect(isLegacyOrigin(a)).toBe(false);
    const l = legacyOrigin("harry--notes");
    expect(l).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyOrigin("harry--notes")).toBe(l);
    expect(legacyOrigin("sam--notes")).not.toBe(l);
    expect(isLegacyOrigin(l)).toBe(true);
  });

  it("a carried lineage is checked; a missing one becomes the legacy origin of the id it came under", () => {
    expect(parseLineage({ origin: "zz" })).toBeNull();
    expect(parseLineage({ origin: mintOrigin(), codeHistory: [{ digest: "nope", version: "1", at: 1 }] })).toBeNull();
    expect(parseLineage({ origin: mintOrigin(), forkedFrom: "x" })).toBeNull();
    const c = carriedLineage(undefined, "harry--notes");
    expect(c).toEqual({ lineage: { origin: legacyOrigin("harry--notes"), codeHistory: [] } });
    const o = mintOrigin();
    const d = carriedLineage({ origin: o, codeHistory: [e(D("a")), e(D("b"))] }, "harry--notes");
    expect(d.lineage.origin).toBe(o);
    expect(d.codeDigest).toBe(D("b"));
  });
});

describe("code and schema relations", () => {
  it("compares code by history (§2.1)", () => {
    expect(compareCode([e(D("a"))], [e(D("a"))])).toBe("same");
    expect(compareCode([e(D("a"))], [e(D("a")), e(D("b"))])).toBe("backup-older");
    expect(compareCode([e(D("a")), e(D("b"))], [e(D("a"))])).toBe("backup-newer");
    expect(compareCode([e(D("a")), e(D("c"))], [e(D("a")), e(D("b"))])).toBe("diverged");
    expect(compareCode([], [e(D("a"))])).toBe("unknown");
    expect(compareVersions("1.2.0", "1.4.0")).toBe("backup-older");
    expect(compareVersions("2.0.0", "1.4.9")).toBe("backup-newer");
    expect(compareVersions("x", "1.0.0")).toBe("unknown");
  });

  it("compares schemas by applied migrations (§2.2) and lists X∖B in order", () => {
    expect(compareSchema(["001", "002"], ["002", "001"])).toBe("same");
    expect(compareSchema(["001"], ["001", "002"])).toBe("backup-older");
    expect(compareSchema(["001", "002"], ["001"])).toBe("backup-newer");
    expect(compareSchema(["001", "003"], ["001", "002"])).toBe("diverged");
    expect(migrationsToRun(["001.sql"], ["003.sql", "001.sql", "002.sql"])).toEqual(["002.sql", "003.sql"]);
    expect(schemaGuard(["b", "a"])).toBe(schemaGuard(["a", "b"]));
    expect(schemaGuard(["a"])).not.toBe(schemaGuard(["a", "b"]));
  });

  it("a tree digest depends on paths and bytes only, binary or text", () => {
    const t = treeDigest({ "a.js": "x", "b/c.txt": "y" });
    expect(t).toMatch(/^tree:[0-9a-f]{64}$/);
    expect(treeDigest({ "b/c.txt": "y", "a.js": "x" })).toBe(t);
    expect(treeDigest({ "a.js": "x" }, { "b/c.txt": Buffer.from("y") })).toBe(t);
    expect(treeDigest({ "a.js": "x", "b/c.txt": "z" })).not.toBe(t);
    expect(treeDigest({ "a.js": "x", "b/d.txt": "y" })).not.toBe(t);
  });

  it("reads a manifest's code: a WASI digest, an image pinned by digest, else the manifest", () => {
    const h = "1".repeat(64);
    expect(manifestCodeDigest(JSON.stringify({ runtime: { digest: `sha256:${h}` } }))).toBe(`wasi:${h}`);
    expect(manifestCodeDigest(JSON.stringify({ runtime: { image: `ghcr.io/x/y@sha256:${h}` } }))).toBe(`sha256:${h}`);
    expect(manifestCodeDigest(JSON.stringify({ runtime: { image: "x:latest" } }))).toMatch(/^manifest:/);
  });

  it("keeps at most 100 entries and doesn't repeat the newest", () => {
    let h = appendCode(undefined, e(D("a")));
    h = appendCode(h, e(D("a")));
    expect(h).toHaveLength(1);
    for (let i = 0; i < 150; i++) h = appendCode(h, e(`tree:${i.toString(16).padStart(64, "0")}`));
    expect(h).toHaveLength(MAX_CODE_HISTORY);
  });
});

function key(): Keypair {
  const p = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: p, publicKey: ed.getPublicKey(p) };
}

const MANIFEST = (image: string, version = "0.1.0") => JSON.stringify({
  schema_version: 1,
  name: "notes",
  version,
  runtime: { image, port: 8080 },
  data: { stores: {} },
  network: {},
  access: { enabled: true, default_role: "viewer" },
  migration: { verification: "standard" },
});

describe("the platform records lineage", () => {
  const cmd: CommandRunner = { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) };
  function world(registry = new InMemoryInstalledServicesStore(), swk = crypto.getRandomValues(new Uint8Array(32)), irk = key()) {
    const platform = new ServicePlatform({
      host: { username: "alice", irkPub: irk.publicKey },
      swk: swkOps(swk),
      appRunner: new AppRunner(cmd),
      dataProvisioner: new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), files: new InMemoryFilesAdmin(), nameKey: "n".repeat(40) }),
      registry,
    });
    return { platform, irk, registry, swk };
  }
  const req = (image: string, version?: string) => ({ serverId: "home.alice.flagship.services", creator: "alice", slug: "notes", manifestJson: MANIFEST(image, version), addOwnerToMembership: false, issuedAt: Date.now() });

  it("an app installed from nothing gets a new origin and its first code; a redeploy adds to the history", async () => {
    const w = world();
    const r1 = req("img:1");
    const a = await w.platform.install({ request: r1, signature: signInstallService(r1, w.irk), verify: verifyInstallService, codeDigest: D("a") });
    if (!a.ok) throw new Error(a.reason);
    expect(a.app.origin).toMatch(/^[0-9a-f]{32}$/);
    expect(a.app.codeHistory!.map((x) => x.digest)).toEqual([D("a")]);
    const r2 = req("img:2", "0.2.0");
    await w.platform.redeploy({ request: r2, signature: signInstallService(r2, w.irk), verify: verifyInstallService, codeDigest: D("b") });
    const now = w.platform.byServiceId("alice--notes")!;
    expect(now.origin).toBe(a.app.origin);
    expect(now.codeHistory!.map((x) => [x.digest, x.version])).toEqual([[D("a"), "0.1.0"], [D("b"), "0.2.0"]]);
    expect(lineageOf(now)).toEqual({ origin: a.app.origin, codeHistory: now.codeHistory });

    await w.platform.flush();
    const again = world(w.registry, w.swk, w.irk);
    await again.platform.restore({ retryDelayMs: 0 });
    expect(lineageOf(again.platform.byServiceId("alice--notes")!)).toEqual(lineageOf(now));
  });

  it("a copy keeps the origin and history it came with", async () => {
    const w = world();
    const o = mintOrigin();
    const r = req("img:1");
    const a = await w.platform.install({ request: r, signature: signInstallService(r, w.irk), verify: verifyInstallService, ...carriedLineage({ origin: o, codeHistory: [e(D("a")), e(D("b"))] }, "bob--notes") });
    if (!a.ok) throw new Error(a.reason);
    expect(a.app.origin).toBe(o);
    expect(a.app.codeHistory!.map((x) => x.digest)).toEqual([D("a"), D("b")]);
  });

  it("an app saved before origins comes back with the legacy origin of its id", async () => {
    const w = world();
    const r = req("img:1");
    await w.platform.install({ request: r, signature: signInstallService(r, w.irk), verify: verifyInstallService });
    await w.platform.flush();
    for (const s of w.registry.saved) {
      delete s.origin;
      delete s.codeHistory;
    }
    const again = world(w.registry, w.swk, w.irk);
    await again.platform.restore({ retryDelayMs: 0 });
    expect(again.platform.byServiceId("alice--notes")!.origin).toBe(legacyOrigin("alice--notes"));
  });
});
