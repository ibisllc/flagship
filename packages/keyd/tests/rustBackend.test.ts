/**
 * The Rust backend (rust/crates/flagship-keyd) against the TS client and, where results are
 * deterministic, against the TS backend itself: same answers, same error codes and messages,
 * same state files. Skips when the binary has not been built
 * (`cargo build -p flagship-keyd` in rust/, or FLAGSHIP_KEYD_RUST_BIN).
 */
import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pkcs10CertificateRequest, X509CertificateGenerator, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import {
  decryptChunk,
  deriveBackupManifestKey,
  deriveServiceSecret,
  ed,
  encryptChunk,
  openGossip,
  openLlmPayload,
  openSealedFromEd25519Recipient,
  opaqueKey,
  signBootSuspension,
  verifyBootSuspension,
  sealForEd25519Recipient,
  sealGossip,
  sealLlmPayload,
} from "@flagship/protocol";
import { AcmeAccount, FrameReader, KEYD_PROTOCOL_VERSION, KeydClient, KeydServer, KeydService, KeydSyncClient, LETS_ENCRYPT_HOSTS, TlsKeys, encodeFrame, readKeyFile } from "../src/index.js";
import { KeydAcmeIssuer } from "../../server-daemon/src/acme/keydAcme.js";
import { keydAcmeApi } from "../../server-daemon/src/keydAsync.js";
import { MockAcme } from "../../server-daemon/tests/helpers/mockAcme.js";
import { CGK, SEED, SWK } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = process.env.FLAGSHIP_KEYD_RUST_BIN ?? join(ROOT, "rust/target/debug/flagship-keyd");
const HAVE_BIN = existsSync(BIN);
if (!HAVE_BIN) console.warn(`rustBackend.test.ts: skipped, no Rust keyd at ${BIN} (run \`cargo build -p flagship-keyd\` in rust/ or set FLAGSHIP_KEYD_RUST_BIN)`);

const FQDN = "home.alice.flagship.services";
const ALLOWED = new Set([FQDN, `*.${FQDN}`]);
const OPEN_LIMITS = { "*": { perSecond: 100000, burst: 100000 } };
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: unknown) => Uint8Array.from(Buffer.from(String(s), "hex"));
const PUB = ed.getPublicKey(SEED);

interface RustKeyd {
  dir: string;
  sock: string;
  audit: string;
  proc: ChildProcess;
  stop: () => Promise<number | null>;
}

function writeKey(dir: string, name: string, key: Uint8Array): void {
  writeFileSync(join(dir, `${name}.key`), hex(key) + "\n", { mode: 0o400 });
}

function stateDir(opts: { swk?: boolean; cgk?: boolean; fqdn?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rkeyd-"));
  writeKey(dir, "identity", SEED);
  if (opts.swk !== false) writeKey(dir, "swk", SWK);
  if (opts.cgk !== false) writeKey(dir, "cgk", CGK);
  if (opts.fqdn !== null) writeFileSync(join(dir, "policy.json"), JSON.stringify({ serverFqdn: opts.fqdn ?? FQDN }), { mode: 0o400 });
  return dir;
}

function spawnRust(dir: string, env: Record<string, string> = {}): Promise<RustKeyd> {
  const sock = join(dir, "k.sock");
  const proc = spawn(BIN, ["serve"], {
    env: { PATH: process.env.PATH ?? "", FLAGSHIP_KEYD_STATE: dir, FLAGSHIP_KEYD_SOCKET: sock, FLAGSHIP_KEYD_RATE_LIMITS: JSON.stringify(OPEN_LIMITS), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  let err = "";
  proc.stderr!.on("data", (d) => (err += String(d)));
  return new Promise((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += String(d);
      if (out.includes("flagship-keyd serving")) {
        resolve({
          dir,
          sock,
          audit: join(dir, "audit.log"),
          proc,
          stop: async () => {
            if (proc.exitCode === null) proc.kill("SIGTERM");
            return exited;
          },
        });
      }
    });
    void exited.then((code) => reject(new Error(`rust keyd exited ${code}: ${err}`)));
  });
}

async function startRust(opts: Parameters<typeof stateDir>[0] = {}, env: Record<string, string> = {}): Promise<RustKeyd & { cleanup: () => Promise<void> }> {
  const k = await spawnRust(stateDir(opts), env);
  return { ...k, cleanup: async () => (await k.stop(), rmSync(k.dir, { recursive: true, force: true })) };
}

async function client(sock: string, component = "rust-test"): Promise<KeydClient> {
  const c = new KeydClient({ socketPath: sock, component });
  await c.connect();
  return c;
}

/** Raw frames on one connection; resolves with every response and whether the server closed it. */
function talk(sock: string, frames: unknown[], raw?: Buffer, waitMs = 200): Promise<{ responses: Array<Record<string, unknown>>; closed: boolean }> {
  return new Promise((resolve) => {
    const s = connect(sock);
    const reader = new FrameReader();
    const responses: Array<Record<string, unknown>> = [];
    let closed = false;
    s.on("data", (d) => responses.push(...(reader.push(d) as Array<Record<string, unknown>>)));
    s.on("error", () => {});
    s.on("end", () => (closed = true));
    s.on("close", () => resolve({ responses, closed: true }));
    s.on("connect", () => {
      for (const f of frames) s.write(encodeFrame(f));
      if (raw) s.write(raw);
      setTimeout(() => {
        if (!closed) resolve({ responses, closed: false });
        s.destroy();
      }, waitMs);
    });
  });
}

async function issueFor(csrDer: Uint8Array, opts: { names?: string[]; days?: number } = {}): Promise<string> {
  cryptoProvider.set(globalThis.crypto);
  const ca = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const caCert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01", name: "CN=Test CA", notBefore: new Date(Date.now() - 86400_000), notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys: ca,
  });
  const csr = new Pkcs10CertificateRequest(Buffer.from(csrDer));
  expect(await csr.verify()).toBe(true);
  const sans = new SubjectAlternativeNameExtension(csr.extensions.find((e) => e.type === "2.5.29.17")!.rawData).names.items.map((n) => n.value);
  const leaf = await X509CertificateGenerator.create({
    serialNumber: "02", subject: csr.subject, issuer: caCert.subject, notBefore: new Date(Date.now() - 3600_000), notAfter: new Date(Date.now() + (opts.days ?? 90) * 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, publicKey: csr.publicKey, signingKey: ca.privateKey,
    extensions: [new SubjectAlternativeNameExtension((opts.names ?? sans).map((value) => ({ type: "dns" as const, value })))],
  });
  return leaf.toString("pem") + "\n" + caCert.toString("pem") + "\n";
}

/** A TS keyd over the same seed, keys and names, for differential checks. */
async function startTs(dir: string | null = null) {
  const t = mkdtempSync(join(tmpdir(), "tkeyd-"));
  const tls = new TlsKeys(ALLOWED, dir ? join(dir, "tls") : null);
  const acme = new AcmeAccount(tls, undefined, dir ? join(dir, "acme-account.key") : null);
  const service = new KeydService({ identitySeed: SEED, swk: SWK, cgk: CGK, tls, acme });
  const server = new KeydServer({ socketPath: join(t, "k.sock"), service, rateLimits: OPEN_LIMITS });
  await server.start();
  return { sock: join(t, "k.sock"), tls, stop: async () => (await server.stop(), rmSync(t, { recursive: true, force: true })) };
}

describe.skipIf(!HAVE_BIN)("the Rust keyd backend", () => {
  it("answers the TS client, signs what policy allows and refuses the rest", async () => {
    const k = await startRust();
    try {
      const c = await client(k.sock);
      expect(c.publicKeyHex).toBe(hex(PUB));
      const msg = enc("flagship/secret-request/v1|x");
      const sig = unhex((await c.call("sign", { msg: hex(msg) })).sig);
      expect(ed.verify(sig, msg, PUB)).toBe(true);
      expect(hex(sig)).toBe(hex(ed.sign(msg, SEED)));
      await expect(c.call("sign", { msg: hex(enc("flagship/root-entitlement/v1|x")) })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("sign", { msg: "zz" })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("sign", { msg: hex(msg), extra: 1 })).rejects.toMatchObject({ code: "bad-request" });
      for (const m of ["flagship/server-update/v1|x", "flagship/order/power-off/v1|x", "flagship/app-rank/v1|x", "no-separator", "|leading"]) {
        await expect(c.call("sign", { msg: hex(enc(m)) }), m).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(c.call("sign", { msg: hex(Uint8Array.of(0xff, 0xfe, 0x7c, 1)) })).rejects.toMatchObject({ code: "forbidden" });
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("serves the synchronous client behind the protocol's opaque key", async () => {
    const k = await startRust();
    const sync = new KeydSyncClient({ socketPath: k.sock, component: "sync-test" });
    try {
      expect(sync.connect().publicKey).toBe(hex(PUB));
      const key = opaqueKey({
        publicKey: PUB,
        sign: (m) => unhex(sync.call("sign", { msg: hex(m) }).sig),
        unseal: (b) => unhex(sync.call("unseal", { blob: hex(b) }).plain),
      });
      const order = { serverDomain: "home.a.flagship.services", epoch: 1, seq: 1, action: "suspend" as const, reason: "dead-man", signer: "box" as const, issuedAt: 1760000000000 };
      expect(verifyBootSuspension(order, signBootSuspension(order, key), PUB)).toBe(true);
      expect(() => signBootSuspension({ ...order, signer: "owner" as const }, key)).toThrow();
      expect(new TextDecoder().decode(openSealedFromEd25519Recipient(sealForEd25519Recipient(enc("sealed"), PUB), key))).toBe("sealed");
      for (let i = 0; i < 200; i++) expect(String(sync.call("swk.deriveServiceSecret", { serviceId: `alice--app${i}` }).secret)).toBe(hex(deriveServiceSecret(SWK, `alice--app${i}`)));
    } finally {
      sync.close();
      await k.cleanup();
    }
  });

  it("opens a blob sealed to the box and fails closed on a different one", async () => {
    const k = await startRust();
    try {
      const c = await client(k.sock);
      const blob = sealForEd25519Recipient(enc("hello"), PUB);
      expect(Buffer.from(unhex((await c.call("unseal", { blob: hex(blob) })).plain)).toString()).toBe("hello");
      const other = sealForEd25519Recipient(enc("hello"), ed.getPublicKey(new Uint8Array(32).fill(9)));
      await expect(c.call("unseal", { blob: hex(other) })).rejects.toMatchObject({ code: "failed" });
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("requires hello, refuses another version and unknown operations, and ends the connection on a bad frame", async () => {
    const k = await startRust();
    try {
      const first = await talk(k.sock, [{ id: 1, op: "status", args: {} }]);
      expect(first.responses[0]).toMatchObject({ id: 1, ok: false, code: "not-hello", message: "say hello first" });
      const v = await talk(k.sock, [{ id: 1, op: "hello", args: { v: 2, component: "x" } }, { id: 2, op: "status", args: {} }]);
      expect(v.responses).toEqual([{ id: 1, ok: false, code: "unsupported-version", message: "keyd speaks protocol 1 only" }]);
      expect(v.closed).toBe(true);
      const u = await talk(k.sock, [{ id: 1, op: "hello", args: { v: KEYD_PROTOCOL_VERSION, component: "x" } }, { id: 2, op: "exportKey", args: {} }, { id: 3, op: "status", args: { extra: 1 } }]);
      expect(u.responses.map((r) => r.code ?? "ok")).toEqual(["ok", "unknown-op", "bad-request"]);
      const bad = await talk(k.sock, [], Buffer.from([0xff, 0xff, 0xff, 0xff]));
      expect(bad).toEqual({ responses: [], closed: true });
      const zero = await talk(k.sock, [], Buffer.from([0, 0, 0, 0]));
      expect(zero).toEqual({ responses: [], closed: true });
      const notJson = await talk(k.sock, [], Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]));
      expect(notJson).toEqual({ responses: [], closed: true });
      // Still serving after all of that.
      const c = await client(k.sock);
      expect((await c.call("status")).publicKey).toBe(hex(PUB));
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("derives, seals and opens exactly as @flagship/protocol does", async () => {
    const k = await startRust();
    try {
      const c = await client(k.sock);
      const sealed = await c.call("swk.seal", { pt: hex(enc("secret")) });
      expect(Buffer.from(openLlmPayload({ ciphertext: unhex(sealed.ciphertext), nonce: unhex(sealed.nonce) }, SWK)).toString()).toBe("secret");
      const local = sealLlmPayload(enc("other"), SWK);
      expect(Buffer.from(unhex((await c.call("swk.open", { ciphertext: hex(local.ciphertext), nonce: hex(local.nonce) })).pt)).toString()).toBe("other");
      await expect(c.call("swk.open", { ...sealed, ciphertext: String(sealed.ciphertext).replace(/^../, "00") })).rejects.toMatchObject({ code: "failed" });
      const chunk = await c.call("swk.encryptChunk", { pt: hex(enc("chunk")) });
      expect(Buffer.from(decryptChunk({ ciphertext: unhex(chunk.ciphertext), nonce: unhex(chunk.nonce), contentHash: unhex(chunk.contentHash) }, SWK)).toString()).toBe("chunk");
      const tsChunk = encryptChunk(enc("ts chunk"), SWK);
      expect(Buffer.from(unhex((await c.call("swk.decryptChunk", { ciphertext: hex(tsChunk.ciphertext), nonce: hex(tsChunk.nonce), contentHash: hex(tsChunk.contentHash) })).pt)).toString()).toBe("ts chunk");
      expect((await c.call("swk.deriveServiceSecret", { serviceId: "alice--chess" })).secret).toBe(hex(deriveServiceSecret(SWK, "alice--chess")));
      expect((await c.call("swk.deriveBackupManifestKey")).key).toBe(hex(deriveBackupManifestKey(SWK)));
      expect((await c.call("swk.deriveTlsKey", { serverId: FQDN })).key).toBe(hex(hkdf(sha256, SWK, enc(FQDN), enc("flagship.tls.v1"), 32)));
      const salt = hex(enc("alice--chess"));
      expect((await c.call("swk.hkdf", { salt, info: "flagship.app-secret.v1" })).key).toBe(hex(hkdf(sha256, SWK, enc("alice--chess"), enc("flagship.app-secret.v1"), 32)));
      await expect(c.call("swk.hkdf", { salt, info: "flagship/root-entitlement/v1" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("swk.hkdf", { salt, info: "" })).rejects.toMatchObject({ code: "bad-request" });
      const g = await c.call("cgk.seal", { pt: hex(enc("gossip")) });
      expect(Buffer.from(openGossip(unhex(g.blob), CGK)).toString()).toBe("gossip");
      expect(Buffer.from(unhex((await c.call("cgk.open", { blob: hex(sealGossip(enc("back"), CGK)) })).pt)).toString()).toBe("back");
      const info = enc("flagship/app-copy-env/v1|alice--chess|home");
      expect((await c.call("cgk.deriveAppCopyEnvKey", { info: hex(info) })).key).toBe(hex(hkdf(sha256, CGK, new Uint8Array(0), info, 32)));
      await expect(c.call("cgk.deriveAppCopyEnvKey", { info: hex(enc("flagship/other/v1|x")) })).rejects.toMatchObject({ code: "forbidden" });
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("provisions a key once, refuses a different one, and writes the file the TS backend reads", async () => {
    const k = await startRust({ swk: false, cgk: false });
    try {
      const c = await client(k.sock);
      const hello = await c.call("status");
      expect(hello).toMatchObject({ hasSwk: false, hasCgk: false });
      await expect(c.call("swk.seal", { pt: "00" })).rejects.toMatchObject({ code: "not-provisioned" });
      expect((await c.call("provision.swk", { key: hex(SWK) })).stored).toBe(true);
      expect((await c.call("provision.swk", { key: hex(SWK) })).already).toBe(true);
      await expect(c.call("provision.swk", { key: hex(new Uint8Array(32).fill(7)) })).rejects.toMatchObject({ code: "forbidden", message: "swk is already provisioned" });
      await expect(c.call("provision.swk", { key: "00" })).rejects.toMatchObject({ code: "bad-request" });
      c.close();
      const file = join(k.dir, "swk.key");
      expect(statSync(file).mode & 0o777).toBe(0o400);
      expect(readFileSync(file, "utf8")).toBe(hex(SWK) + "\n");
      expect(readKeyFile(file)).toEqual(SWK);
      expect(existsSync(join(k.dir, "cgk.key"))).toBe(false);
    } finally {
      await k.cleanup();
    }
  });

  it("applies the default rate limits like the TS service", async () => {
    const k = await startRust({ cgk: false }, { FLAGSHIP_KEYD_RATE_LIMITS: JSON.stringify({ "provision.cgk": { perSecond: 0.1, burst: 3 }, "*": { perSecond: 5000, burst: 10000 } }) });
    try {
      const c = await client(k.sock);
      const results: string[] = [];
      for (let i = 0; i < 5; i++) results.push(await c.call("provision.cgk", { key: hex(CGK) }).then(() => "ok", (e) => e.code));
      expect(results).toEqual(["ok", "ok", "ok", "rate-limited", "rate-limited"]);
      expect((await c.call("status")).publicKey).toBe(hex(PUB));
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("rate limits a flood without taking the daemon down", async () => {
    const k = await startRust({}, { FLAGSHIP_KEYD_RATE_LIMITS: JSON.stringify({ sign: { perSecond: 0.001, burst: 3 }, "*": { perSecond: 1000, burst: 1000 } }) });
    try {
      const c = await client(k.sock);
      const msg = hex(enc("flagship/secret-request/v1|x"));
      const results = await Promise.all(Array.from({ length: 6 }, () => c.call("sign", { msg }).then(() => "ok", (e) => e.code)));
      expect(results.filter((r) => r === "ok")).toHaveLength(3);
      expect(results.filter((r) => r === "rate-limited")).toHaveLength(3);
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("writes the TS audit line, never keys or messages", async () => {
    const k = await startRust();
    try {
      const c = await client(k.sock, "audit-test");
      await c.call("sign", { msg: hex(enc("flagship/secret-request/v1|top-secret-payload")) });
      await c.call("sign", { msg: hex(enc("flagship/root-entitlement/v1|x")) }).catch(() => {});
      c.close();
      await new Promise((r) => setTimeout(r, 100));
      const lines = readFileSync(k.audit, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.map((l) => Object.keys(l))).toEqual([
        ["t", "key", "op", "component", "ok"],
        ["t", "key", "op", "component", "ok", "purpose"],
        ["t", "key", "op", "component", "ok", "code"],
      ]);
      expect(lines[1]).toMatchObject({ key: hex(PUB).slice(0, 16), op: "sign", component: "audit-test", ok: true, purpose: "flagship/secret-request/v1" });
      expect(lines[2]).toMatchObject({ op: "sign", ok: false, code: "forbidden" });
      const log = readFileSync(k.audit, "utf8");
      for (const secret of ["top-secret-payload", hex(SEED), hex(SWK), hex(CGK)]) expect(log).not.toContain(secret);
    } finally {
      await k.cleanup();
    }
  });

  it("refuses a caller whose uid is not allowed, before reading anything", async () => {
    const other = String((process.getuid?.() ?? 0) + 4242);
    const k = await startRust({}, { FLAGSHIP_KEYD_ALLOW_UIDS: other, FLAGSHIP_KEYD_ALLOW_GIDS: "" });
    try {
      const r = await talk(k.sock, [{ id: 1, op: "hello", args: { v: 1, component: "x" } }]);
      expect(r).toEqual({ responses: [], closed: true });
      await expect(client(k.sock)).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(readFileSync(k.audit, "utf8")).toContain('"op":"connect","component":"-","ok":false,"code":"forbidden"');
    } finally {
      await k.cleanup();
    }
  });

  it("refuses to start over a live socket, and SIGTERM removes the socket", async () => {
    const k = await startRust();
    try {
      await expect(spawnRust(k.dir)).rejects.toThrow(/already running/);
      expect(await k.stop()).toBe(0);
      expect(existsSync(k.sock)).toBe(false);
      // A stale socket file from a crash is cleared on the next start.
      writeFileSync(k.sock, "");
      const again = await spawnRust(k.dir);
      expect(await again.stop()).toBe(0);
    } finally {
      await k.cleanup();
    }
  });

  it("refuses group- or world-readable key files, like readKeyFile", async () => {
    const dir = stateDir();
    try {
      rmSync(join(dir, "swk.key"));
      writeFileSync(join(dir, "swk.key"), hex(SWK) + "\n", { mode: 0o440 });
      await expect(spawnRust(dir)).rejects.toThrow(/must not be readable by group or others/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the same answer, code and message as the TS backend for the same requests", async () => {
    const rust = await startRust();
    const ts = await startTs();
    try {
      const big = "61".repeat(256 * 1024 + 1);
      const boot = (role: string, key: string) => hex(enc(`flagship/boot-auth/v1|${role}|${FQDN}|GET|/x|${key}|aabb|1`));
      const susp = (seq: string, action = "suspend", signer = "box") => hex(enc(`flagship/boot-suspension/v1|${FQDN}|2|${seq}|${action}|r|${signer}|1`));
      const blob = (n: number) => "00".repeat(n);
      // [op, args, compare the whole result?]
      const cases: Array<[string, Record<string, unknown>, boolean]> = [
        ["status", {}, true], ["status", { extra: 1 }, true], ["status", { "2": 1, b: 1, "10": 1 }, true],
        ["sign", { msg: hex(enc("flagship/inject/v1|a|b")) }, true], ["sign", { msg: hex(enc("﻿flagship/inject/v1|a")) }, true],
        ["sign", { msg: "" }, true], ["sign", { msg: "0" }, true], ["sign", { msg: "AA" }, true], ["sign", {}, true], ["sign", { msg: 7 }, true],
        ["sign", { msg: big }, true], ["sign", { msg: hex(enc("flagship/root-entitlement/v1|x")) }, true], ["sign", { msg: hex(enc("x".repeat(300) + "|")) }, true],
        ["sign", { msg: susp("1") }, true], ["sign", { msg: susp("0") }, true], ["sign", { msg: susp(" 7 ") }, true], ["sign", { msg: susp("1e1") }, true], ["sign", { msg: susp("Infinity") }, true],
        ["sign", { msg: susp("1", "resume") }, true], ["sign", { msg: susp("1", "suspend", "owner") }, true],
        ["sign", { msg: boot("box", hex(PUB)) }, true], ["sign", { msg: boot("box", "00") }, true], ["sign", { msg: boot("owner", hex(PUB)) }, true],
        ["unseal", { blob: blob(43) }, true], ["unseal", { blob: blob(44) }, true], ["unseal", { blob: blob(100) }, true], ["unseal", { blob: blob(10), x: 1 }, true],
        ["swk.hkdf", { salt: "aa", info: "flagship.llm.v1" }, true], ["swk.hkdf", { salt: "aa", info: "nope" }, true], ["swk.hkdf", { salt: "a", info: "flagship.llm.v1" }, true],
        ["swk.hkdf", { info: "flagship.llm.v1" }, true], ["swk.hkdf", { salt: blob(513), info: "flagship.llm.v1" }, true], ["swk.hkdf", { salt: "", info: "x".repeat(129) }, true],
        ["swk.open", { ciphertext: blob(16), nonce: blob(11) }, true], ["swk.open", { ciphertext: blob(15), nonce: blob(12) }, true], ["swk.open", { ciphertext: blob(16), nonce: blob(12) }, true],
        ["swk.decryptChunk", { ciphertext: blob(16), nonce: blob(12), contentHash: blob(31) }, true], ["swk.decryptChunk", { ciphertext: blob(20), nonce: blob(12), contentHash: blob(32) }, true],
        ["swk.seal", { pt: "zz" }, true], ["swk.seal", { pt: "", more: 1 }, true], ["swk.encryptChunk", {}, true],
        ["swk.deriveServiceSecret", { serviceId: "alice--chess" }, true], ["swk.deriveServiceSecret", { serviceId: "" }, true], ["swk.deriveServiceSecret", { serviceId: "x".repeat(201) }, true],
        ["swk.deriveServiceSecret", { serviceId: "a\u0001" }, true], ["swk.deriveServiceSecret", { serviceId: "\u{1F600}".repeat(100) }, true], ["swk.deriveServiceSecret", { serviceId: "\u{1F600}".repeat(101) }, true],
        ["swk.deriveTlsKey", { serverId: FQDN }, true], ["swk.deriveTlsKey", { serverId: 3 }, true], ["swk.deriveBackupManifestKey", {}, true], ["swk.deriveBackupManifestKey", { a: 1 }, true],
        ["cgk.open", { blob: blob(27) }, true], ["cgk.open", { blob: blob(28) }, true],
        ["cgk.deriveAppCopyEnvKey", { info: hex(enc("flagship/app-copy-env/v1|a")) }, true], ["cgk.deriveAppCopyEnvKey", { info: hex(enc("﻿flagship/app-copy-env/v1|a")) }, true],
        ["cgk.deriveAppCopyEnvKey", { info: "" }, true], ["cgk.deriveAppCopyEnvKey", { info: hex(enc("flagship/app-copy-env/v2|a")) }, true],
        ["tls.createKey", { names: FQDN }, true], ["tls.createKey", { names: [1] }, true], ["tls.createKey", { names: [] }, true], ["tls.createKey", { names: ["evil.example.com"] }, true],
        ["tls.createKey", { names: ["not a name"] }, true], ["tls.createKey", { names: Array(9).fill(FQDN) }, true], ["tls.createKey", { names: [`x.${FQDN}`] }, true],
        ["tls.createKey", { names: [FQDN.toUpperCase()] }, false],
        ["tls.csr", { handle: "nope" }, true], ["tls.csr", { handle: blob(16) }, true], ["tls.csr", {}, true],
        ["tls.install", { handle: blob(16), chain: "not pem!" }, true], ["tls.install", { handle: blob(16), chain: "abc" }, true], ["tls.install", { handle: "x", chain: "abc" }, true],
        ["tls.activate", { handle: blob(16) }, true], ["tls.sign", { handle: blob(16), digest: blob(31) }, true], ["tls.sign", { handle: blob(16), digest: blob(32) }, true],
        ["tls.remove", { handle: blob(16) }, true], ["tls.active", {}, true], ["tls.list", { x: 1 }, true],
        ["acme.jwk", {}, true], ["acme.sign", { kind: "newOrder" }, true], ["acme.sign", { kind: "x", url: "u", nonce: "n" }, true],
        ["acme.sign", { kind: "newOrder", url: "https://acme-v02.api.letsencrypt.org/acme/new-order", nonce: "abcdefghij", names: [FQDN] }, true],
        ["acme.sign", { kind: "postAsGet", url: "https://acme-v02.api.letsencrypt.org/acme/order/1", nonce: "abcdefghij", kid: "k" }, true],
        ["acme.sign", { kind: "revoke", url: "u", nonce: "n", kid: "k", certificate: "00" }, true], ["acme.sign", { bogus: 1 }, true],
        ["acme.importGranted", { blob: blob(43) }, true], ["acme.importGranted", { blob: blob(60) }, true],
        ["provision.swk", { key: hex(SWK) }, true], ["provision.swk", { key: blob(32) }, true], ["provision.cgk", { key: blob(31) }, true], ["provision.cgk", {}, true],
      ];
      const frames = [{ id: 1, op: "hello", args: { v: 1, component: "diff" } }, ...cases.map(([op, args], i) => ({ id: i + 2, op, args }))];
      const strip = (r: Record<string, unknown>, whole: boolean) => (whole || r.ok === false ? r : { id: r.id, ok: r.ok });
      const a = await talk(rust.sock, frames, undefined, 1500);
      const b = await talk(ts.sock, frames, undefined, 1500);
      expect(a.responses).toHaveLength(frames.length);
      for (let i = 0; i < cases.length; i++) {
        const whole = cases[i]![2];
        expect(strip(a.responses[i + 1]!, whole), JSON.stringify(cases[i]).slice(0, 200)).toEqual(strip(b.responses[i + 1]!, whole));
      }
      // Request-level refusals answer with id 0, in both.
      const bad = [{ id: 1, op: "hello", args: { v: 1, component: "x" } }, { id: -1, op: "status" }, { id: 1.5, op: "status" }, { id: 2, op: "status", args: [] }, [], { id: 3, op: 4 }, { id: 4, op: "status", zz: 1 }];
      expect((await talk(rust.sock, bad)).responses).toEqual((await talk(ts.sock, bad)).responses);
    } finally {
      await rust.cleanup();
      await ts.stop();
    }
  });
});

describe.skipIf(!HAVE_BIN)("TLS keys in the Rust keyd", () => {
  it("works over the socket and never returns the private key", async () => {
    const k = await startRust();
    try {
      const c = await client(k.sock, "acme");
      const created = await c.call("tls.createKey", { names: [FQDN, `*.${FQDN}`] });
      const csr = unhex((await c.call("tls.csr", { handle: created.handle })).csr);
      const parsed = new Pkcs10CertificateRequest(Buffer.from(csr));
      expect(parsed.subject).toContain(FQDN);
      await expect(c.call("tls.sign", { handle: created.handle, digest: hex(sha256(new Uint8Array(3))) })).rejects.toMatchObject({ code: "forbidden", message: "this key has no certificate" });
      await expect(c.call("tls.activate", { handle: created.handle })).rejects.toMatchObject({ code: "forbidden" });
      const chain = await issueFor(csr);
      const info = await c.call("tls.install", { handle: created.handle, chain });
      expect(info.names).toEqual([FQDN, `*.${FQDN}`].sort());
      await c.call("tls.activate", { handle: created.handle });
      const listed = await c.call("tls.list");
      expect(JSON.stringify(listed)).not.toMatch(/priv/i);
      expect(listed.allowedNames).toEqual([FQDN, `*.${FQDN}`]);
      expect((await c.call("tls.active")).active).toMatchObject({ handle: created.handle, names: [FQDN, `*.${FQDN}`].sort(), legacy: false });
      await expect(c.call("tls.createKey", { names: ["evil.example.com"] })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("tls.sign", { handle: created.handle, digest: "00" })).rejects.toMatchObject({ code: "bad-request" });
      for (const len of [32, 48]) {
        const digest = new Uint8Array(len).fill(3);
        const sig = unhex((await c.call("tls.sign", { handle: created.handle, digest: hex(digest) })).sig);
        const raw = new X509Certificate(chain).publicKey.export({ type: "spki", format: "der" });
        expect(p256.verify(sig, digest, Uint8Array.from(raw.subarray(raw.length - 65)), { prehash: false, format: "der" })).toBe(true);
      }
      await expect(c.call("tls.remove", { handle: created.handle })).rejects.toMatchObject({ code: "forbidden", message: "the key in service cannot be removed" });
      // A certificate for another key or for more names is refused.
      const b = await c.call("tls.createKey", { names: [FQDN] });
      await expect(c.call("tls.install", { handle: b.handle, chain })).rejects.toMatchObject({ code: "forbidden", message: "the certificate is not for this key" });
      const bCsr = unhex((await c.call("tls.csr", { handle: b.handle })).csr);
      await expect(c.call("tls.install", { handle: b.handle, chain: await issueFor(bCsr, { names: [FQDN, "evil.example.com"] }) })).rejects.toMatchObject({ message: "the certificate names more than this key was made for" });
      await expect(c.call("tls.install", { handle: b.handle, chain: await issueFor(bCsr, { days: -2 }) })).rejects.toMatchObject({ message: "the certificate is not valid now" });
      expect((await c.call("tls.remove", { handle: b.handle })).removed).toBe(true);
      c.close();
    } finally {
      await k.cleanup();
    }
  });

  it("shares its TLS state files with the TS backend, both ways, with identical CSRs and signatures", async () => {
    const dir = stateDir();
    try {
      // TS makes and activates a key; Rust serves it.
      const tsTls = new TlsKeys(ALLOWED, join(dir, "tls"));
      const { handle } = tsTls.createKey([FQDN]);
      tsTls.install(handle, await issueFor(tsTls.csr(handle)));
      tsTls.activate(handle);
      const k = await spawnRust(dir);
      const c = await client(k.sock);
      expect(((await c.call("tls.active")).active as { handle: string }).handle).toBe(handle);
      const digest = sha256(enc("transcript"));
      expect((await c.call("tls.sign", { handle, digest: hex(digest) })).sig).toBe(hex(tsTls.sign(handle, digest)));
      expect((await c.call("tls.csr", { handle })).csr).toBe(hex(tsTls.csr(handle)));
      // Rust makes and activates a new one; TS loads it.
      const r = await c.call("tls.createKey", { names: [FQDN, `*.${FQDN}`] });
      const rh = String(r.handle);
      await c.call("tls.install", { handle: rh, chain: await issueFor(unhex((await c.call("tls.csr", { handle: rh })).csr)) });
      await c.call("tls.activate", { handle: rh });
      const keyFile = join(dir, "tls", `${rh}.json`);
      expect(statSync(keyFile).mode & 0o777).toBe(0o400);
      expect(Object.keys(JSON.parse(readFileSync(keyFile, "utf8")))).toEqual(["names", "privHex", "spkiHex", "createdAt", "chainPem", "notBefore", "notAfter"]);
      const again = new TlsKeys(ALLOWED, join(dir, "tls"));
      expect(again.active()?.handle).toBe(rh);
      expect(hex(again.sign(rh, digest))).toBe((await c.call("tls.sign", { handle: rh, digest: hex(digest) })).sig);
      expect(hex(again.csr(rh))).toBe((await c.call("tls.csr", { handle: rh })).csr);
      expect(again.list().find((x) => x.handle === rh)?.spkiHex).toBe(r.spki);
      c.close();
      await k.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const STAGING = "acme-staging-v02.api.letsencrypt.org";

async function acmeHarness() {
  const k = await startRust();
  const c = await client(k.sock, "acme");
  const mock = new MockAcme();
  (mock as unknown as { host: string }).host = STAGING;
  const issuer = new KeydAcmeIssuer({
    keyd: keydAcmeApi(c),
    directoryUrl: `https://${STAGING}/directory`,
    email: "ops@example.com",
    dns: {
      publishTxt: async (host, value) => {
        (mock.txt.get(host) ?? mock.txt.set(host, new Set()).get(host)!).add(value);
        return async () => {
          mock.txt.get(host)?.delete(value);
          if (mock.txt.get(host)?.size === 0) mock.txt.delete(host);
        };
      },
    },
    fetchImpl: mock.fetch,
    dns01PropagationDelayMs: 0,
    pollIntervalMs: 1,
  });
  return { k, c, mock, issuer, close: async () => (c.close(), await k.cleanup()) };
}

describe.skipIf(!HAVE_BIN)("ACME through the Rust keyd", () => {
  it("runs the whole order with the TS issuer: account, order, DNS-01, finalize, install, revoke", async () => {
    const h = await acmeHarness();
    try {
      const out = await h.issuer.issue([FQDN, `*.${FQDN}`]);
      const leaf = new X509Certificate(out.chainPem);
      expect((leaf.subjectAltName ?? "").split(", ").map((s) => s.replace("DNS:", "")).sort()).toEqual([FQDN, `*.${FQDN}`].sort());
      await h.c.call("tls.activate", { handle: out.handle });
      const kinds = h.mock.log.requests.map((r) => r.kind).filter(Boolean);
      expect(kinds[0]).toBe("newAccount");
      expect(kinds).toContain("finalize");
      expect(h.mock.txt.size).toBe(0);
      await h.issuer.issue([FQDN]);
      expect(h.mock.log.requests.filter((r) => r.kind === "newAccount")).toHaveLength(1);
      await h.issuer.revoke(leaf.raw, 1);
      expect(h.mock.revoked).toHaveLength(1);
      expect(statSync(join(h.k.dir, "acme-account.key")).mode & 0o777).toBe(0o400);
      const seen = JSON.stringify([await h.c.call("acme.jwk"), await h.c.call("tls.list")]);
      expect(seen).not.toMatch(/"d"|priv/i);
      await expect(h.issuer.issue(["evil.example.com"])).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await h.close();
    }
  });

  it("refuses requests of any shape but the known ones, or to hosts it does not talk to", async () => {
    const h = await acmeHarness();
    try {
      await h.issuer.issue([FQDN]);
      const kid = `https://${STAGING}/acme/acct/acct1`;
      const bad: Array<Record<string, unknown>> = [
        { kind: "newOrder", url: "https://evil.example/acme/new-order", nonce: "abcdefghij", kid, names: [FQDN] },
        { kind: "newOrder", url: `http://${STAGING}/acme/new-order`, nonce: "abcdefghij", kid, names: [FQDN] },
        { kind: "newOrder", url: `https://${STAGING}:8443/acme/new-order`, nonce: "abcdefghij", kid, names: [FQDN] },
        { kind: "newOrder", url: `https://${STAGING}/acme/new-order`, nonce: "abcdefghij", kid: `https://${STAGING}/other`, names: [FQDN] },
        { kind: "newOrder", url: `https://${STAGING}/acme/new-order`, nonce: "abcdefghij", kid, names: ["evil.example.com"] },
        { kind: "finalize", url: `https://${STAGING}/acme/new-order`, nonce: "abcdefghij", kid, handle: "00".repeat(16) },
        { kind: "newAccount", url: `https://${STAGING}/acme/new-acct`, nonce: "abcdefghij", contact: "mailto:a@b.c\nmailto:x@y.z" },
        { kind: "newAccount", url: `https://${STAGING}/acme/new-acct`, nonce: "x", contact: "mailto:a@example.com" },
        { kind: "revoke", url: `https://${STAGING}/acme/revoke-cert`, nonce: "abcdefghij", kid, certificate: "00".repeat(64), reason: 3 },
        { kind: "anything", url: `https://${STAGING}/x`, nonce: "abcdefghij" },
      ];
      for (const args of bad) await expect(h.c.call("acme.sign", args), JSON.stringify(args)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });

  it("signs byte-identical JWS to the TS backend for the same granted account key", async () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const blob = hex(sealForEd25519Recipient(enc(pem), PUB));
    const rust = await startRust();
    const ts = await startTs();
    try {
      const rc = await client(rust.sock);
      const tc = await client(ts.sock);
      const rj = await rc.call("acme.importGranted", { blob });
      expect(rj).toEqual(await tc.call("acme.importGranted", { blob }));
      await expect(rc.call("acme.importGranted", { blob })).rejects.toMatchObject({ code: "forbidden" });
      expect(await rc.call("acme.jwk")).toEqual(await tc.call("acme.jwk"));
      const LE = `https://${LETS_ENCRYPT_HOSTS[0]}`;
      const kid = `${LE}/acme/acct/123`;
      const reqs: Array<Record<string, unknown>> = [
        { kind: "newAccount", url: `${LE}/acme/new-acct`, nonce: "abcdefghij", contact: "mailto:ops@example.com" },
        { kind: "newOrder", url: `${LE}/acme/new-order`, nonce: "abcdefghij", kid, names: [FQDN.toUpperCase(), `*.${FQDN}`, FQDN] },
        { kind: "postAsGet", url: `${LE}/acme/order/1/2`, nonce: "abcdefghij", kid },
        { kind: "challenge", url: `${LE}/acme/chall-v3/1/x`, nonce: "abcdefghij", kid },
        { kind: "newOrder", url: `${LE}/acme/new-order`, nonce: "abcdefghij", kid, names: ["evil.example.com"] },
        { kind: "newAccount", url: `${LE}/acme/new-acct`, nonce: "abcdefghij", contact: "ops@example.com" },
        { kind: "challenge", url: `${LE}/acme/order/1`, nonce: "abcdefghij", kid },
        { kind: "postAsGet", url: `${LE}/acme/order/1`, nonce: "abcdefghij", kid: `${LE}/acme/new-acct` },
      ];
      for (const r of reqs) {
        const a = await rc.call("acme.sign", r).catch((e) => ({ code: e.code, message: e.message }));
        const b = await tc.call("acme.sign", r).catch((e) => ({ code: e.code, message: e.message }));
        expect(a, JSON.stringify(r)).toEqual(b);
      }
      // Refused when not P-256 or not sealed to this box.
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      const fresh = await startRust();
      const fc = await client(fresh.sock);
      await expect(fc.call("acme.importGranted", { blob: hex(sealForEd25519Recipient(enc(rsa), PUB)) })).rejects.toMatchObject({ code: "bad-request" });
      await expect(fc.call("acme.importGranted", { blob: hex(sealForEd25519Recipient(enc(pem), ed.getPublicKey(new Uint8Array(32).fill(1)))) })).rejects.toMatchObject({ code: "failed" });
      const sec1 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" }) as string;
      expect(((await fc.call("acme.importGranted", { blob: hex(sealForEd25519Recipient(enc(sec1), PUB)) })).jwk as { crv: string }).crv).toBe("P-256");
      fc.close();
      await fresh.cleanup();
      rc.close();
      tc.close();
    } finally {
      await rust.cleanup();
      await ts.stop();
    }
  });

  it("is absent when keyd has no policy (no TLS names)", async () => {
    const k = await startRust({ fqdn: null });
    try {
      const c = await client(k.sock);
      await expect(c.call("tls.list")).rejects.toMatchObject({ code: "not-provisioned", message: "this keyd serves no TLS keys" });
      await expect(c.call("acme.jwk")).rejects.toMatchObject({ code: "not-provisioned", message: "this keyd serves no ACME account" });
      c.close();
    } finally {
      await k.cleanup();
    }
  });
});

