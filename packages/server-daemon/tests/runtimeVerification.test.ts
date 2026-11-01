import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed } from "../../protocol/src/edSync.js";
import { signRuntimeManifest, type RuntimeManifest } from "../../protocol/src/runtimeManifest.js";
import { RuntimeVerification } from "../src/runtimeVerification.js";

const SEED = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed.getPublicKey(SEED)).toString("hex");
const NOW = 1_800_000_000_000;
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
const EXE = Buffer.from("\x7fELF the official node");

function lockText(version = "24.22.1", exeSha = sha(EXE)): string {
  return JSON.stringify({
    schema: 1,
    runtime: "node",
    version,
    securityFloor: "24.22.1",
    upstream: { base: `https://nodejs.org/dist/v${version}/`, shasums: "SHASUMS256.txt" },
    keyring: { signers: [{ fingerprint: "5be8a3f6c8a5c01d106c0ad820b1a390b168d356" }] },
    targets: { "linux-amd64": { file: `node-v${version}-linux-x64.tar.gz`, sha256: "e".repeat(64), executableSha256: exeSha } },
  });
}

function doc(o: { lock?: string; sequence?: number; validUntil?: number; seed?: Uint8Array; revoked?: string[] } = {}) {
  const lock = o.lock ?? lockText();
  const manifest: RuntimeManifest = {
    runtime: "node",
    version: (JSON.parse(lock) as { version: string }).version,
    lockSha256: sha(lock),
    securityFloor: "24.22.1",
    release: "0.3",
    sequence: o.sequence ?? 5,
    issuedAt: NOW - 1000,
    validUntil: o.validUntil ?? NOW + 30 * 86_400_000,
    revokedSigners: o.revoked ?? [],
  };
  return { manifest, signatures: [signRuntimeManifest(manifest, o.seed ?? SEED)], lockJson: lock };
}

let dir: string;
let served: { status: number; body?: unknown } | Error;
let now: number;

function open(lock = lockText()) {
  writeFileSync(join(dir, "repo/release/runtime-lock.json"), lock);
  return RuntimeVerification.open({
    repoPath: join(dir, "repo"),
    dataDir: join(dir, "data"),
    controlBaseUrl: "https://flagshipserver.com",
    execPath: join(dir, "node"),
    arch: "x64",
    activeVersion: "24.22.1",
    now: () => now,
    fetchImpl: (async (url: string) => {
      expect(url).toBe("https://flagshipserver.com/api/runtime/manifest");
      if (served instanceof Error) throw served;
      return new Response(served.status === 204 ? null : JSON.stringify(served.body), { status: served.status });
    }) as unknown as typeof fetch,
  })!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rtv-"));
  mkdirSync(join(dir, "repo/release"), { recursive: true });
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "repo/release/box-artifact-trust.json"), JSON.stringify({ keys: [PUB], threshold: 1, pq: { keyIds: [], legacyManifests: [] } }));
  writeFileSync(join(dir, "node"), EXE);
  now = NOW;
  served = { status: 200, body: doc() };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runtime verification view", () => {
  it("reports the lock, the local checksum and a verified Flagship signature", async () => {
    const rv = open();
    await rv.refresh();
    const v = rv.view()!;
    expect(v).toMatchObject({
      version: "24.22.1",
      activeVersion: "24.22.1",
      target: "linux-amd64",
      officialUrl: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz",
      shasumsUrl: "https://nodejs.org/dist/v24.22.1/SHASUMS256.txt",
      localExecutableSha256: sha(EXE),
      matchesLock: true,
      upstream: { status: "verified-at-release", signer: "5be8a3f6c8a5c01d106c0ad820b1a390b168d356" },
      flagship: { status: "verified", sequence: 5, release: "0.3", matchesLock: true, expectedArchiveSha256: "e".repeat(64) },
      pageUrl: "https://flagshipserver.com/runtime",
    });
    expect(JSON.parse(readFileSync(join(dir, "data/runtime-manifest.json"), "utf8")).manifest.sequence).toBe(5);
  });

  it("shows a swapped executable", async () => {
    writeFileSync(join(dir, "node"), "something else");
    const rv = open();
    await rv.refresh();
    expect(rv.view()!.matchesLock).toBe(false);
  });

  it("keeps the last accepted manifest when the site is down, until it expires", async () => {
    const rv = open();
    await rv.refresh();
    served = new Error("offline");
    await rv.refresh();
    expect(rv.view()!.flagship).toMatchObject({ status: "verified", sequence: 5 });
    now = NOW + 31 * 86_400_000;
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("expired");
    expect(rv.view()!.matchesLock).toBe(true);
  });

  it("says when nothing is published, and when the site cannot be reached at all", async () => {
    served = { status: 204 };
    const rv = open();
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("not-published");
    served = new Error("offline");
    const none = open();
    await none.refresh();
    expect(none.view()!.flagship.status).toBe("unavailable");
  });

  it("refuses a forged, replayed or substituted manifest and keeps the accepted one", async () => {
    const rv = open();
    await rv.refresh();
    served = { status: 200, body: doc({ seed: new Uint8Array(32).fill(9), sequence: 6 }) };
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("not-enough-signatures");
    served = { status: 200, body: doc({ sequence: 4 }) };
    await rv.refresh();
    expect(rv.view()!.flagship).toMatchObject({ status: "rollback", sequence: 5 });
    served = { status: 200, body: doc({ sequence: 5, validUntil: NOW + 86_400_000 }) };
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("rollback");
    served = { status: 200, body: doc({ sequence: 7, lock: lockText("24.22.1", "0".repeat(64)) }) };
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("runtime-manifest-mismatch");
  });

  it("accepts a release that locks a newer runtime than the published manifest", async () => {
    writeFileSync(join(dir, "node"), EXE);
    const rv = open(lockText("24.23.0"));
    served = { status: 200, body: doc() };
    await rv.refresh();
    expect(rv.view()!.flagship).toMatchObject({ status: "verified", matchesLock: false });
  });

  it("a revoked upstream signer is reported", async () => {
    served = { status: 200, body: doc({ revoked: ["5be8a3f6c8a5c01d106c0ad820b1a390b168d356"] }) };
    const rv = open();
    await rv.refresh();
    expect(rv.view()!.flagship.status).toBe("signer-revoked");
  });

  it("is absent for a release without a runtime lock", () => {
    expect(RuntimeVerification.open({ repoPath: join(dir, "none"), dataDir: dir, controlBaseUrl: "https://x" })).toBeNull();
  });
});

describe("the view matches what the clients read (test-vectors/runtime-verification)", () => {
  it("emits every field the shared vectors' views carry", async () => {
    const V = JSON.parse(readFileSync(join(import.meta.dirname, "../../protocol/test-vectors/runtime-verification/vectors.json"), "utf8"));
    const rv = open();
    await rv.refresh();
    const view = rv.view()! as unknown as Record<string, unknown>;
    const clientView = V.cases[0].view as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(Object.keys(clientView).sort());
    expect(Object.keys(view.flagship as object).sort()).toEqual(Object.keys(clientView.flagship as object).sort());
  });
});
