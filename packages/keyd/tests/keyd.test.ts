import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveBackupManifestKey, deriveServiceSecret, ed, hybridSigKeygen, hybridVerify, openSealedFromEd25519Recipient, sealForEd25519Recipient, sealLlmPayload } from "@flagship/protocol";
import { BOX_SIGN_PURPOSES, FrameReader, KEYD_PROTOCOL_VERSION, KeydClient, KeydError, MAX_FRAME_BYTES, RateLimiter, checkSign, encodeFrame } from "../src/index.js";
const unhex = (v: unknown) => Uint8Array.from(Buffer.from(String(v), "hex"));
import { CGK, PAIRING_ORDER, PQ_SEED, SEED, SWK, startInProcess } from "./helpers.js";

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

describe("the identity the box asserts to its apps", () => {
  const vectors = JSON.parse(
    readFileSync(join(__dirname, "../../protocol/test-vectors/identity-assertion/vectors.json"), "utf8"),
  ) as { cases: { msg: string; expect: string | null }[] };

  it("signs only a member's rank, an anonymous visitor or an API key, in their one shape", () => {
    for (const c of vectors.cases.filter((v) => v.expect !== "not-an-assertion")) {
      const run = () => checkSign(enc(c.msg), hex(PUB));
      if (c.expect === null) expect(run(), c.msg).toBe(c.msg.split("|")[0]);
      else expect(run, c.msg).toThrow(`the box asserts only a member, anonymous or an API key (${c.expect})`);
    }
  });
});

const OWNER_SEED = new Uint8Array(32).fill(0x42);
const OTHER_SEED = new Uint8Array(32).fill(0x43);
const OWNER_PUB = ed.getPublicKey(OWNER_SEED);
const OWNER_FQDN = "home.alice.flagship.services";
/** An owner-signed SWK/CGK delivery as the daemon hands it to keyd (swkDelivery.ts / cgkDelivery.ts). */
function delivery(which: "swk" | "cgk", sealed: Uint8Array, signer = OWNER_SEED, domain = OWNER_FQDN, issuedAt = 1_760_000_000_000) {
  const msg = enc(`flagship/${which}-delivery/v1|${domain}|${hex(sealed)}|${issuedAt}`);
  return { sealed: hex(sealed), serverDomain: domain, issuedAt, signature: hex(ed.sign(msg, signer)) };
}

it("without a pinned owner key or a ceremony, nothing fills an empty slot", async () => {
  const k = await startInProcess({ swk: undefined, cgk: undefined }, { rateLimits: { "*": { perSecond: 1000, burst: 1000 } } });
  try {
    const c = new KeydClient({ socketPath: k.sock, component: "test" });
    await c.connect();
    await expect(c.call("provision.swk", { key: hex(SWK), ceremony: hex(new Uint8Array(32)) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(c.call("provision.cgk", delivery("cgk", sealForEd25519Recipient(CGK, PUB)))).rejects.toMatchObject({ code: "forbidden", message: "no owner key is pinned for this box" });
    expect((await c.call("status")).hasSwk).toBe(false);
    c.close();
  } finally {
    await k.stop();
  }
  const token = new Uint8Array(32).fill(5);
  const late = await startInProcess({ swk: undefined, cgk: undefined, ceremony: { token, notAfter: 5_000 }, now: () => 6_000 }, { rateLimits: { "*": { perSecond: 1000, burst: 1000 } } });
  try {
    const c = new KeydClient({ socketPath: late.sock, component: "test" });
    await c.connect();
    await expect(c.call("provision.swk", { key: hex(SWK), ceremony: hex(token) })).rejects.toMatchObject({ code: "forbidden", message: "a raw key is let in only during the boot ceremony" });
    c.close();
  } finally {
    await late.stop();
  }
});

describe("what the box key may sign", () => {
  const ok = (m: string) => checkSign(enc(m), hex(PUB));
  const denied = (m: Uint8Array | string) => expect(() => checkSign(typeof m === "string" ? enc(m) : m, hex(PUB))).toThrow(KeydError);

  it("signs the box's own purposes", () => {
    expect(ok("flagship/secret-request/v1|a|b")).toBe("flagship/secret-request/v1");
    expect(ok("flagship/inject/v1|app|user|member|1")).toBe("flagship/inject/v1");
    expect(ok("pb-put|a|1|2|peer")).toBe("pb-put");
    expect(ok("flagship/app-release/v1|app|1")).toBe("flagship/app-release/v1");
    for (const t of ["pb-checkin", "pb-directory", "pb-tokens", "pb-redeem", "pb-filler-fetch", "pb-filler-proof", "pb-root-deposit"]) {
      expect(ok(`flagship/${t}/v1|home.a.flagship.services|1`)).toBe(`flagship/${t}/v1`);
    }
  });

  it("refuses owner, admin and account purposes, untagged bytes and binary", () => {
    for (const m of [
      "flagship/root-entitlement/v1|x", "flagship/server-update/v1|x", "flagship/order/power-off/v1|x", "flagship/account-self-delete/v1|x",
      "flagship/app-rank/v1|x", "flagship/debug-access/v2|x", "flagship/membership/v1|x", "flagship/service-grant/v1|x", "flagship/server-share/v1|x", "flagship/re-pair-veto/v1|x",
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
      const blob = sealForEd25519Recipient(PAIRING_ORDER, PUB);
      expect(unhex((await c.call("unseal", { blob: hex(blob), purpose: "pairing-order" })).plain)).toEqual(PAIRING_ORDER);
      const other = sealForEd25519Recipient(PAIRING_ORDER, ed.getPublicKey(new Uint8Array(32).fill(9)));
      await expect(c.call("unseal", { blob: hex(other), purpose: "pairing-order" })).rejects.toMatchObject({ code: "failed" });
      // A sealed key, a PEM or any other message never comes back out.
      for (const pt of [SWK, enc("-----BEGIN PRIVATE KEY-----"), enc('{"request":{"type":"x"},"signature":"aa"}'), enc("\ufeff" + new TextDecoder().decode(PAIRING_ORDER))]) {
        await expect(c.call("unseal", { blob: hex(sealForEd25519Recipient(pt, PUB)), purpose: "pairing-order" })).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(c.call("unseal", { blob: hex(blob) })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("unseal", { blob: hex(blob), purpose: "swk" })).rejects.toMatchObject({ code: "forbidden" });
      expect(openSealedFromEd25519Recipient(blob, SEED)).toEqual(PAIRING_ORDER);
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

  it("derives only the two fixed, unsalted subkeys with swk.hkdf", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      const { hkdf } = await import("@noble/hashes/hkdf");
      const { sha256 } = await import("@noble/hashes/sha256");
      expect((await c.call("swk.hkdf", { salt: "", info: "flagship/peer-backup-key/v1" })).key).toBe(hex(hkdf(sha256, SWK, new Uint8Array(0), enc("flagship/peer-backup-key/v1"), 32)));
      expect((await c.call("swk.hkdf", { salt: "", info: "flagship.pb-manifest.v1" })).key).toBe(hex(deriveBackupManifestKey(SWK)));
      // The chunk, LLM, app-secret and TLS-at-rest subkeys stay in keyd.
      for (const info of ["flagship.app-secret.v1", "flagship.llm.v1", "flagship.chunk.v1", "flagship.tls.v1", "flagship/root-entitlement/v1"]) {
        await expect(c.call("swk.hkdf", { salt: "", info })).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(c.call("swk.hkdf", { salt: "aa", info: "flagship/peer-backup-key/v1" })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("swk.hkdf", { salt: "", info: "" })).rejects.toMatchObject({ code: "bad-request" });
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("derives service secrets only for well-formed service ids", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      await c.connect();
      for (const id of ["alice--chess", "habit-tracker", "a--b-", "x"]) expect((await c.call("swk.deriveServiceSecret", { serviceId: id })).secret).toBe(hex(deriveServiceSecret(SWK, id)));
      for (const id of ["Alice--chess", "a--b--c", "a---b", "--b", "a--", "-a", "a b", "a.b", "a/b", "a".repeat(64), "flagship.app-secret.v1"]) {
        await expect(c.call("swk.deriveServiceSecret", { serviceId: id }), id).rejects.toMatchObject({ code: "bad-request" });
      }
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("provisions a key once, only on proof of authority, and refuses a different one", async () => {
    const saved: string[] = [];
    const TOKEN = new Uint8Array(32).fill(0x3c);
    let now = 1_000;
    const k = await startInProcess(
      { swk: undefined, cgk: undefined, store: { save: (n) => void saved.push(n) }, owner: { irkPubHex: hex(OWNER_PUB), serverFqdn: OWNER_FQDN }, ceremony: { token: TOKEN, notAfter: 5_000 }, now: () => now },
      { rateLimits: { "*": { perSecond: 1000, burst: 1000 } } },
    );
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "test" });
      expect((await c.connect()).hasSwk).toBe(false);
      await expect(c.call("swk.seal", { pt: "00" })).rejects.toMatchObject({ code: "not-provisioned" });
      // A raw key: only with the boot ceremony's token, while it is valid.
      await expect(c.call("provision.swk", { key: hex(SWK) })).rejects.toMatchObject({ code: "bad-request", message: "ceremony must be lowercase hex" });
      await expect(c.call("provision.swk", { key: hex(SWK), ceremony: hex(new Uint8Array(32).fill(1)) })).rejects.toMatchObject({ code: "forbidden", message: "a raw key is let in only during the boot ceremony" });
      await expect(c.call("provision.swk", { key: hex(SWK), ceremony: hex(TOKEN), issuedAt: 1 })).rejects.toMatchObject({ code: "bad-request" });
      expect((await c.call("provision.swk", { key: hex(SWK), ceremony: hex(TOKEN) })).stored).toBe(true);
      expect((await c.call("provision.swk", { key: hex(SWK), ceremony: hex(TOKEN) })).already).toBe(true);
      await expect(c.call("provision.swk", { key: hex(new Uint8Array(32).fill(7)), ceremony: hex(TOKEN) })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("provision.swk", { key: "00", ceremony: hex(TOKEN) })).rejects.toMatchObject({ code: "bad-request" });
      expect(saved).toEqual(["swk"]);
      // The owner's sealed delivery: signed under the pinned owner key for this box, opened by keyd.
      const good = delivery("cgk", sealForEd25519Recipient(CGK, PUB));
      await expect(c.call("provision.cgk", { sealed: good.sealed })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("provision.cgk", { ...good, signature: delivery("cgk", sealForEd25519Recipient(CGK, PUB), OTHER_SEED).signature })).rejects.toMatchObject({ code: "forbidden", message: "the owner did not sign this delivery for this box" });
      await expect(c.call("provision.cgk", delivery("swk", sealForEd25519Recipient(CGK, PUB)))).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("provision.cgk", delivery("cgk", sealForEd25519Recipient(CGK, PUB), OWNER_SEED, "home.mallory.flagship.services"))).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("provision.cgk", { ...good, issuedAt: -1 })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("provision.cgk", delivery("cgk", sealForEd25519Recipient(enc("short"), PUB)))).rejects.toMatchObject({ code: "failed" });
      await expect(c.call("provision.cgk", delivery("cgk", sealForEd25519Recipient(CGK, ed.getPublicKey(new Uint8Array(32).fill(9)))))).rejects.toMatchObject({ code: "failed" });
      await expect(c.call("provision.cgk", { key: hex(CGK), ...good })).rejects.toMatchObject({ code: "bad-request" });
      await expect(c.call("provision.cgk", {})).rejects.toMatchObject({ code: "bad-request" });
      expect(await c.call("provision.cgk", good)).toEqual({ stored: true });
      expect(await c.call("provision.cgk", good)).toEqual({ stored: false, already: true });
      await expect(c.call("provision.cgk", delivery("cgk", sealForEd25519Recipient(SWK, PUB)))).rejects.toMatchObject({ code: "forbidden", message: "cgk is already provisioned" });
      await expect(c.call("unseal", { blob: hex(sealForEd25519Recipient(CGK, PUB)), purpose: "pairing-order" })).rejects.toMatchObject({ code: "forbidden" });
      expect(saved).toEqual(["swk", "cgk"]);
      now += 1;
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

describe("hybrid signing (architecture v2)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const pk = hybridSigKeygen(SEED, PQ_SEED).publicKey;
  const ml = hex(pk.subarray(32));
  const pub = hex(ed.getPublicKey(SEED));

  it("signs the box's purposes with both keys and nothing else", async () => {
    const k = await startInProcess({ pqSeed: PQ_SEED });
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "t" });
      await c.connect();
      expect(await c.call("pq.status")).toEqual({ publicKey: pub, mldsaPublicKey: ml });
      const msg = enc("flagship/daemon-status/v1|a|b");
      const sig = Uint8Array.from(Buffer.from(String((await c.call("sign.hybrid", { msg: hex(msg) })).sig), "hex"));
      expect(() => hybridVerify(pk, "flagship/daemon-status/v1", msg, sig)).not.toThrow();
      await expect(c.call("sign.hybrid", { msg: hex(enc("flagship/root-entitlement/v1|x")) })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("sign.hybrid", { msg: hex(enc("pb-put|x")) })).rejects.toMatchObject({ code: "forbidden", message: "that purpose has no hybrid form" });
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("binds only its own two keys, as the box, and never classically", () => {
    const b = (role: string, e: string, m: string) => enc(`flagship/pq-key-binding/v1|${role}|home|${e}|${m}|1`);
    expect(checkSign(b("box-stk", pub, ml), pub, BOX_SIGN_PURPOSES, { mldsaPubHex: ml })).toBe("flagship/pq-key-binding/v1");
    for (const m of [b("admin-root", pub, ml), b("box-stk", "00".repeat(32), ml), b("box-stk", pub, "00".repeat(1952))]) {
      expect(() => checkSign(m, pub, BOX_SIGN_PURPOSES, { mldsaPubHex: ml })).toThrow(KeydError);
    }
    expect(() => checkSign(b("box-stk", pub, ml), pub)).toThrow(/both of its keys/);
    expect(() => checkSign(enc("flagship/boot-key-binding/v2|home|x|1"), pub)).toThrow(/both of its keys/);
  });

  it("signs a PQ session transcript with both keys only, naming one server and one digest", () => {
    const pub = "ab".repeat(32);
    const ml = "cd".repeat(1952);
    const m = (s: string) => new TextEncoder().encode(s);
    const ok = m(`flagship/pq-session-accept/v1|home.alice.flagship.services|${"0f".repeat(64)}`);
    expect(checkSign(ok, pub, BOX_SIGN_PURPOSES, { mldsaPubHex: ml })).toBe("flagship/pq-session-accept/v1");
    expect(() => checkSign(ok, pub, BOX_SIGN_PURPOSES)).toThrow(/both of its keys/);
    for (const bad of [
      `flagship/pq-session-finish/v1|home.alice.flagship.services|${"0f".repeat(63)}`,
      `flagship/pq-session-finish/v1|Home|${"0f".repeat(64)}`,
      `flagship/pq-session-finish/v1|home.alice.flagship.services|${"0f".repeat(64)}|extra`,
    ]) {
      expect(() => checkSign(m(bad), pub, BOX_SIGN_PURPOSES, { mldsaPubHex: ml })).toThrow(KeydError);
    }
  });

  it("answers not-provisioned without an ML-DSA seed", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "t" });
      await c.connect();
      await expect(c.call("pq.status")).rejects.toMatchObject({ code: "not-provisioned" });
      await expect(c.call("sign.hybrid", { msg: hex(enc("flagship/daemon-status/v1|a")) })).rejects.toMatchObject({ code: "not-provisioned" });
      c.close();
    } finally {
      await k.stop();
    }
  });
});

describe("the owner key root keyd pins at the boot ceremony", () => {
  it("comes from root's config, else the install blob, and is rewritten from it", async () => {
    const { mkdtempSync, writeFileSync: write, readFileSync: read } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { writeOwnerAnchorFromConfig, loadOwnerAnchor } = await import("../src/migrate.js");
    const dir = mkdtempSync(join(tmpdir(), "keyd-owner-"));
    const state = join(dir, "state");
    const cfg = join(dir, "server.json");
    const blob = join(dir, "install-blob.json");
    expect(writeOwnerAnchorFromConfig({ serverJson: cfg, installBlob: blob }, state)).toBeNull();
    write(blob, JSON.stringify({ authCode: { userPubKey: "AB".repeat(32) } }));
    expect(writeOwnerAnchorFromConfig({ serverJson: cfg, installBlob: blob }, state)).toEqual({ irkPubHex: "ab".repeat(32) });
    write(cfg, JSON.stringify({ irkPublicKey: "cd".repeat(32) }));
    writeOwnerAnchorFromConfig({ serverJson: cfg, installBlob: blob }, state);
    expect(loadOwnerAnchor(state)).toEqual({ irkPubHex: "cd".repeat(32) });
    expect(JSON.parse(read(join(state, "owner.json"), "utf8"))).toEqual({ irkPubHex: "cd".repeat(32) });
  });
});
