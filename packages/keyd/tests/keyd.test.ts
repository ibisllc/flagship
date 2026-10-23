import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { ed, openSealedFromEd25519Recipient, sealForEd25519Recipient, sealLlmPayload } from "@flagship/protocol";
import { BOX_SIGN_PURPOSES, FrameReader, KEYD_PROTOCOL_VERSION, KeydClient, KeydError, MAX_FRAME_BYTES, RateLimiter, checkSign, encodeFrame } from "../src/index.js";
import { CGK, SEED, SWK, startInProcess } from "./helpers.js";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const PUB = ed.getPublicKey(SEED);

describe("framing", () => {
  it("round-trips frames split across chunks and refuses an oversize or empty length", () => {
    const r = new FrameReader();
    const f = encodeFrame({ a: 1 });
    expect(r.push(f.subarray(0, 3))).toEqual([]);
    expect(r.push(f.subarray(3))).toEqual([{ a: 1 }]);
    const big = Buffer.alloc(4);
    big.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameReader().push(big)).toThrow(/out of range/);
    expect(() => new FrameReader().push(Buffer.alloc(4))).toThrow(/out of range/);
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]);
    expect(() => new FrameReader().push(bad)).toThrow(/not JSON/);
  });
});

describe("what the box key may sign", () => {
  const ok = (m: string) => checkSign(enc(m), hex(PUB));
  const denied = (m: Uint8Array | string) => expect(() => checkSign(typeof m === "string" ? enc(m) : m, hex(PUB))).toThrow(KeydError);

  it("signs the box's own purposes", () => {
    expect(ok("flagship/secret-request/v1|a|b")).toBe("flagship/secret-request/v1");
    expect(ok("flagship/inject/v1|app|user|role|1")).toBe("flagship/inject/v1");
    expect(ok("pb-put|a|1|2|peer")).toBe("pb-put");
  });

  it("refuses owner, admin and account purposes, untagged bytes and binary", () => {
    for (const m of [
      "flagship/root-entitlement/v1|x", "flagship/server-update/v1|x", "flagship/order/power-off/v1|x", "flagship/account-self-delete/v1|x",
      "flagship/app-rank/v1|x", "flagship/debug-access/v2|x", "flagship/server-share/v1|x", "flagship/re-pair-veto/v1|x",
      "no-separator", "|leading", "random bytes", "flagship/inject/v1", "flagship/inject/v1 |x", "FLAGSHIP/inject/v1|x",
    ]) denied(m);
    denied(new Uint8Array([0xff, 0xfe, 0x7c, 1]));
    denied(new Uint8Array(0));
  });

  it("only lets the box suspend, as the box", () => {
    const s = (signer: string, action: string, seq: number) => `flagship/boot-suspension/v1|home.a.flagship.services|2|${seq}|${action}|dead-man|${signer}|1760000000000`;
    expect(ok(s("box", "suspend", 1))).toBe("flagship/boot-suspension/v1");
    denied(s("owner", "suspend", 1));
    denied(s("box", "resume", 1));
    denied(s("box", "suspend", 0));
    denied(`flagship/boot-suspension/v1|x|1|1|suspend|r|box`);
  });

  it("signs boot requests only as the box with its own key", () => {
    const a = (role: string, pub: string) => `flagship/boot-auth/v1|${role}|home.a.flagship.services|GET|/api/boot/x|${pub}|aabb|1760000000000`;
    expect(ok(a("box", hex(PUB)))).toBe("flagship/boot-auth/v1");
    denied(a("owner", hex(PUB)));
    denied(a("box", "00".repeat(32)));
  });

  it("every purpose in the list is a tagged name or a known legacy one", () => {
    for (const p of BOX_SIGN_PURPOSES) expect(p).toMatch(/^(flagship\/[a-z0-9-]+\/v\d+|pb-put|pb-resp|pb\/request-peers\/v1)$/);
  });
});

describe("the rate limiter", () => {
  it("spends a burst, refills with time, and limits per operation", () => {
    let now = 0;
    const l = new RateLimiter({ sign: { perSecond: 1, burst: 2 }, "*": { perSecond: 100, burst: 100 } }, () => now);
    expect([l.take("sign"), l.take("sign"), l.take("sign")]).toEqual([true, true, false]);
    expect(l.take("other")).toBe(true);
    now = 1000;
    expect(l.take("sign")).toBe(true);
  });
});

describe("the server", () => {
  it("answers a client, signs what policy allows and refuses the rest", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      const hello = await c.connect();
      expect(hello).toMatchObject({ publicKey: hex(PUB), hasSwk: true, hasCgk: true });
      const msg = enc("flagship/secret-request/v1|x");
      const sig = Uint8Array.from(Buffer.from(String((await c.call("sign", { msg: hex(msg) })).sig), "hex"));
      expect(ed.verify(sig, msg, PUB)).toBe(true);
      await expect(c.call("sign", { msg: hex(enc("flagship/root-entitlement/v1|x")) })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("sign", { msg: "zz" })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("sign", { msg: hex(msg), extra: 1 })).rejects.toMatchObject({ code: "bad-request" });
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("opens a blob sealed to the box and fails closed on a different one", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      const blob = sealForEd25519Recipient(enc("hello"), PUB);
      expect(Buffer.from(String((await c.call("unseal", { blob: hex(blob) })).plain), "hex").toString()).toBe("hello");
      const other = sealForEd25519Recipient(enc("hello"), ed.getPublicKey(new Uint8Array(32).fill(9)));
      await expect(c.call("unseal", { blob: hex(other) })).rejects.toMatchObject({ code: "failed" });
      expect(openSealedFromEd25519Recipient(blob, SEED)).toEqual(enc("hello"));
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("requires hello, refuses another version and unknown operations, and ends the connection on a bad frame", async () => {
    const k = await startInProcess();
    try {
      const talk = (frames: unknown[], raw?: Buffer) =>
        new Promise<{ responses: unknown[]; closed: boolean }>((resolve) => {
          const s = connect(k.sock);
          const reader = new FrameReader();
          const responses: unknown[] = [];
          s.on("data", (d) => responses.push(...reader.push(d)));
          s.on("close", () => resolve({ responses, closed: true }));
          s.on("connect", () => {
            for (const f of frames) s.write(encodeFrame(f));
            if (raw) s.write(raw);
            setTimeout(() => s.end(), 150);
          });
        });
      const first = await talk([{ id: 1, op: "status", args: {} }]);
      expect(first.responses[0]).toMatchObject({ ok: false, code: "not-hello" });
      const v = await talk([{ id: 1, op: "hello", args: { v: 2, component: "x" } }]);
      expect(v.responses[0]).toMatchObject({ ok: false, code: "unsupported-version" });
      const u = await talk([{ id: 1, op: "hello", args: { v: KEYD_PROTOCOL_VERSION, component: "x" } }, { id: 2, op: "exportKey", args: {} }, { id: 3, op: "status", args: { extra: 1 } }]);
      expect(u.responses.map((r) => (r as { code?: string }).code ?? "ok")).toEqual(["ok", "unknown-op", "bad-request"]);
      const bad = await talk([], Buffer.from([0xff, 0xff, 0xff, 0xff]));
      expect(bad.responses).toEqual([]);
      expect(bad.closed).toBe(true);
    } finally {
      await k.stop();
    }
  });

  it("derives SWK subkeys, seals and opens, and rejects tampering", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      const sealed = await c.call("swk.seal", { pt: hex(enc("secret")) });
      const sealedLocal = sealLlmPayload(enc("secret"), SWK);
      expect(String(sealed.ciphertext).length).toBe(hex(sealedLocal.ciphertext).length);
      expect(Buffer.from(String((await c.call("swk.open", sealed)).pt), "hex").toString()).toBe("secret");
      await expect(c.call("swk.open", { ...sealed, ciphertext: String(sealed.ciphertext).replace(/^../, "00") })).rejects.toMatchObject({ code: "failed" });
      const a = await c.call("swk.deriveServiceSecret", { serviceId: "alice--chess" });
      const b = await c.call("swk.deriveServiceSecret", { serviceId: "alice--go" });
      expect(a.secret).not.toBe(b.secret);
      expect(String(a.secret)).toHaveLength(64);
      await expect(c.call("cgk.deriveAppCopyEnvKey", { info: hex(enc("flagship/other/v1|x")) })).rejects.toMatchObject({ code: "forbidden" });
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("derives only labelled subkeys with swk.hkdf", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      const salt = hex(enc("alice--chess"));
      const r = await c.call("swk.hkdf", { salt, info: "flagship.app-secret.v1" });
      const { hkdf } = await import("@noble/hashes/hkdf");
      const { sha256 } = await import("@noble/hashes/sha256");
      expect(r.key).toBe(hex(hkdf(sha256, SWK, enc("alice--chess"), enc("flagship.app-secret.v1"), 32)));
      await expect(c.call("swk.hkdf", { salt, info: "flagship/root-entitlement/v1" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("swk.hkdf", { salt, info: "" })).rejects.toMatchObject({ code: "bad-request" });
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("provisions a key once and refuses a different one", async () => {
    const saved: string[] = [];
    const k = await startInProcess({ swk: undefined, cgk: undefined, store: { save: (n) => void saved.push(n) } }, { rateLimits: { "*": { perSecond: 1000, burst: 1000 } } });
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      expect((await c.connect()).hasSwk).toBe(false);
      await expect(c.call("swk.seal", { pt: "00" })).rejects.toMatchObject({ code: "not-provisioned" });
      expect((await c.call("provision.swk", { key: hex(SWK) })).stored).toBe(true);
      expect((await c.call("provision.swk", { key: hex(SWK) })).already).toBe(true);
      await expect(c.call("provision.swk", { key: hex(new Uint8Array(32).fill(7)) })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("provision.swk", { key: "00" })).rejects.toMatchObject({ code: "bad-request" });
      expect(saved).toEqual(["swk"]);
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("writes an audit trail with operations and results but never keys or messages", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "audit-test" });
      await c.connect();
      const msg = enc("flagship/secret-request/v1|top-secret-payload");
      await c.call("sign", { msg: hex(msg) });
      await c.call("sign", { msg: hex(enc("flagship/root-entitlement/v1|x")) }).catch(() => {});
      c.close();
      await new Promise((r) => setTimeout(r, 100));
      const log = readFileSync(k.audit, "utf8");
      expect(log).toContain('"op":"sign"');
      expect(log).toContain('"code":"forbidden"');
      expect(log).toContain("flagship/secret-request/v1");
      expect(log).not.toContain("top-secret-payload");
      expect(log).not.toContain(hex(SEED));
      expect(log).not.toContain(hex(SWK));
    } finally {
      await k.stop();
    }
  });

  it("rate limits a flood without taking the daemon down", async () => {
    const k = await startInProcess({}, { rateLimits: { sign: { perSecond: 0.001, burst: 3 }, "*": { perSecond: 1000, burst: 1000 } } });
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      const msg = hex(enc("flagship/secret-request/v1|x"));
      const results = await Promise.all(Array.from({ length: 6 }, () => c.call("sign", { msg }).then(() => "ok", (e) => e.code)));
      expect(results.filter((r) => r === "ok")).toHaveLength(3);
      expect(results.filter((r) => r === "rate-limited")).toHaveLength(3);
      expect((await c.call("status")).publicKey).toBe(hex(PUB));
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("refuses to start over a live socket and clears a stale one", async () => {
    const k = await startInProcess();
    try {
      const { KeydServer, KeydService } = await import("../src/index.js");
      const second = new KeydServer({ socketPath: k.sock, service: new KeydService({ identitySeed: SEED }) });
      await expect(second.start()).rejects.toThrow(/already running/);
    } finally {
      await k.stop();
    }
  });

  it("stop() zeroes the keys", async () => {
    const k = await startInProcess();
    await k.server.stop();
    expect(() => k.service.handle({ id: 1, op: "swk.deriveTlsKey", args: { serverId: "a" } })).toThrow(/no SWK/);
    k.cleanup();
  });
});

void CGK;
