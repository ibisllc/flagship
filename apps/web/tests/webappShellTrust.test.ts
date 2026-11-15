// The verifiable shell (lib/shellTrust.js, lib/swRegister.js vetUpdate, scripts/webapp-shell.ts;
// docs/webapp-key-custody.md item 5): the build's manifest, the release signature over it by the
// ca-track maintainer key (and the release key's PQ half once pinned), and what the page does with
// an unsigned update. Chains are synthetic (a test pin), signed with a test maintainer key.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { generateKeypair, mandatePinHash, signMandate, type Mandate } from "@ibisllc/maintainers";
import { canonicalPqKeyBinding, hybridSigKeygen, hybridSign, releasePqKeyId } from "@flagship/protocol";
import { canonicalShellStatement, manifestBytes, serviceWorkerShell, sha256Hex, shellManifest, stampShell } from "../../../scripts/webapp-shell";
import * as st from "../public/webapp/lib/shellTrust.js";
import { vetUpdate } from "../public/webapp/lib/swRegister.js";

const WEBAPP = resolve(__dirname, "../public/webapp");
const NOW = Date.parse("2026-11-15T12:00:00Z");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function chain(seedByte: number) {
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  const kp = generateKeypair(seed);
  const unsigned: Omit<Mandate, "signatures"> = {
    kind: "Mandate",
    version: 1,
    mandateId: `ca${seedByte.toString(16).padStart(2, "0")}0000-0000-4000-8000-000000000000`,
    track: "ca",
    holder: kp.pubKey,
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2027-03-01T00:00:00.000Z",
    successors: [kp.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * 86400,
    defaultDurationSeconds: 180 * 86400,
    signedBy: kp.pubKey,
  };
  const mandate = signMandate(unsigned, [{ privKey: kp.privKey }]);
  return { kp, mandate, pin: mandatePinHash(mandate) };
}

function manifest(version = "v218") {
  return Buffer.from(JSON.stringify({ v: 1, shellVersion: version, files: { "/app.js": "ab".repeat(32) } }));
}

function signDoc(c: ReturnType<typeof chain>, mBytes: Uint8Array, opts: { version?: string; pq?: boolean } = {}) {
  const statement = { shellVersion: opts.version ?? "v218", manifestSha256: sha256Hex(mBytes), issuedAt: NOW - 1000 };
  const bytes = canonicalShellStatement(statement, c.kp.pubKey);
  const signature = hex(ed25519.sign(bytes, Buffer.from(c.kp.privKey, "hex")));
  let pq: unknown;
  let keyId: string | undefined;
  if (opts.pq) {
    const edSeed = Buffer.from(c.kp.privKey, "hex");
    const { publicKey, secretKey } = hybridSigKeygen(edSeed, new Uint8Array(32).fill(0x42));
    const b = { role: "release-key", subjectId: "flagship-release", ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW - 86_400_000 };
    const binding = { v: 1, ...b, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(b as never), { deterministic: true })) };
    pq = { binding, signature: hex(hybridSign(secretKey, "flagship/webapp-shell/v1", bytes)) };
    keyId = releasePqKeyId(b.ed25519PubHex, b.mldsaPubHex);
  }
  return { doc: { v: 1, ...statement, signedBy: c.kp.pubKey, signature, ...(pq ? { pq } : {}), mandates: [c.mandate] }, keyId };
}

describe("webapp shell signature", () => {
  it("accepts the ca-track authority's signature over this manifest", async () => {
    const c = chain(1);
    const m = manifest();
    const { doc } = signDoc(c, m);
    expect(await st.verifyShellSignature(doc, m, { pin: c.pin, pqKeyIds: [], now: NOW })).toMatchObject({ ok: true, shellVersion: "v218" });
  });

  it("refuses another manifest, another version, another signer and a missing signature", async () => {
    const c = chain(2);
    const m = manifest();
    const { doc } = signDoc(c, m);
    const o = { pin: c.pin, pqKeyIds: [], now: NOW };
    expect(await st.verifyShellSignature(doc, manifest("v219"), o)).toMatchObject({ ok: false, reason: "version" });
    expect(await st.verifyShellSignature(doc, Buffer.from(m.toString().replace("ab", "cd")), o)).toMatchObject({ ok: false, reason: "manifest-digest" });
    expect(await st.verifyShellSignature(doc, m, { ...o, pin: chain(3).pin })).toMatchObject({ ok: false, reason: "unauthorized-signer" });
    expect(await st.verifyShellSignature({ ...doc, signature: "00".repeat(64) }, m, o)).toMatchObject({ ok: false, reason: "signature-invalid" });
    expect(await st.verifyShellSignature(null, m, o)).toMatchObject({ ok: false, reason: "unsigned" });
  });

  it("needs the release key's PQ half once the pin names it", async () => {
    const c = chain(4);
    const m = manifest();
    const classical = signDoc(c, m);
    const hybrid = signDoc(c, m, { pq: true });
    const pinned = { pin: c.pin, pqKeyIds: [hybrid.keyId!], now: NOW };
    expect(await st.verifyShellSignature(classical.doc, m, pinned)).toMatchObject({ ok: false, reason: "pq-missing" });
    expect(await st.verifyShellSignature(hybrid.doc, m, pinned)).toMatchObject({ ok: true });
    expect(await st.verifyShellSignature(hybrid.doc, m, { ...pinned, pqKeyIds: ["00".repeat(32)] })).toMatchObject({ ok: false, reason: "pq-key-not-pinned" });
  });

  it("checks the deployed shell against the waiting worker's version", async () => {
    const c = chain(5);
    const m = manifest();
    const { doc } = signDoc(c, m);
    const fetchImpl = async (p: string) => (p === st.SHELL_MANIFEST_PATH ? new Response(m) : new Response(JSON.stringify(doc)));
    expect(await st.checkDeployedShell({ expectVersion: "v218", fetchImpl: fetchImpl as never, now: NOW, pin: c.pin, pqKeyIds: [] })).toMatchObject({ signed: true });
    expect(await st.checkDeployedShell({ expectVersion: "v219", fetchImpl: fetchImpl as never, now: NOW, pin: c.pin, pqKeyIds: [] })).toMatchObject({ signed: false, reason: "version" });
  });
});

describe("the page and an unsigned update", () => {
  const unsigned = async () => ({ signed: false, reason: "unsigned" });
  const signed = async () => ({ signed: true });
  const version = async () => "v218";

  it("offers an unsigned update only while signatures are not required", async () => {
    expect(await vetUpdate({}, { required: false, check: unsigned, version })).toMatchObject({ offer: true, signed: false });
    expect(await vetUpdate({}, { required: true, check: unsigned, version })).toMatchObject({ offer: false });
    expect(await vetUpdate({}, { required: true, check: signed, version })).toMatchObject({ offer: true, signed: true });
  });

  it("refuses to open a signing key under an unsigned shell while required", async () => {
    expect(await st.shellAllowsSigning({ required: false, status: unsigned })).toBe(true);
    expect(await st.shellAllowsSigning({ required: true, status: unsigned })).toBe(false);
    expect(await st.shellAllowsSigning({ required: true, status: signed })).toBe(true);
  });

  it("ships with signatures not yet required (the owner turns it on at a signed release)", () => {
    expect(st.SHELL_SIGNATURE_REQUIRED).toBe(false);
  });
});

describe("the build's manifest (scripts/webapp-shell.ts)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("covers every shell file the worker installs, at the worker's version", () => {
    const sw = serviceWorkerShell(readFileSync(join(WEBAPP, "service-worker.js"), "utf8"));
    const m = shellManifest(WEBAPP);
    expect(m.shellVersion).toBe(sw.version);
    expect(m.files["/app.js"]).toBe(sha256Hex(readFileSync(join(WEBAPP, "app.js"))));
    expect(m.files["/"]).toBe(sha256Hex(readFileSync(join(WEBAPP, "index.html"))));
    expect(m.files["/service-worker.js"]).toBeDefined();
    expect(m.files["/shell-manifest.json"]).toBeUndefined();
    expect(m.files["/vendor/mldsa-wasm/mldsa65.wasm"]).toBeDefined();
  });

  it("stamps a signature only when it signs exactly this build", () => {
    dir = mkdtempSync(join(tmpdir(), "shell-"));
    const web = join(dir, "web");
    const sigs = join(dir, "sigs");
    mkdirSync(sigs);
    cpSync(WEBAPP, web, { recursive: true });
    const first = stampShell(web, sigs);
    expect(first.signed).toBe(false);
    const bytes = readFileSync(join(web, "shell-manifest.json"));
    expect(sha256Hex(bytes)).toBe(first.manifestSha256);
    expect(Buffer.compare(bytes, manifestBytes(shellManifest(web)))).toBe(0);
    writeFileSync(join(sigs, `${first.shellVersion}.json`), JSON.stringify({ v: 1, shellVersion: first.shellVersion, manifestSha256: first.manifestSha256 }));
    expect(stampShell(web, sigs).signed).toBe(true);
    writeFileSync(join(web, "app.js"), "// changed\n");
    expect(stampShell(web, sigs).signed).toBe(false);
  });
});
