/**
 * V01 adversarial suite: keyd purpose boundary (packages/keyd). The caller is assumed to be a compromised
 * daemon that may send any request keyd's wire accepts. Each test names the boundary and the defect it
 * would catch if the check regressed.
 *
 *   AT-KEY-01  sign: a message without a purpose prefix is refused
 *   AT-KEY-02  sign: owner/admin/account purposes are never box purposes
 *   AT-KEY-03  sign: hybrid-only purposes are refused through the classical `sign`
 *   AT-KEY-04  sign: pq-key-binding names only the box's own two keys as `box-stk`
 *   AT-KEY-05  sign: boot-suspension only `suspend` as `box`; boot-auth only as the box's own key
 *   AT-KEY-06  sign: oversized and empty messages are refused
 *   AT-KEY-07  swk.hkdf: only the listed labels, never a salt
 *   AT-KEY-08  cgk MACs: only gossip / access-sync tagged bytes
 *   AT-KEY-09  unseal: only the pairing-order purpose
 *   AT-KEY-10  wire: unknown op, extra top-level field, extra arg, bad id
 *   AT-KEY-11  deriveServiceSecret / deriveAppCopyEnvKey: shaped inputs only
 *   AT-KEY-12  the known unscoped derivation (REGISTER K01) is recorded, not hidden
 */
import { describe, expect, it } from "vitest";
import { ed } from "../../../packages/protocol/src/index.js";
import { KeydError, KeydService, BOX_SIGN_PURPOSES, HYBRID_ONLY_PURPOSES, SWK_HKDF_LABELS, checkSign, parseRequest } from "../../../packages/keyd/src/index.js";
import { CGK, SEED, SWK } from "../../../packages/keyd/tests/helpers.js";

const te = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const svc = () => new KeydService({ identitySeed: SEED, swk: SWK, cgk: CGK });
const call = (s: KeydService, op: string, args: Record<string, unknown>) => s.handle({ id: 1, op: op as never, args });
const refusedCode = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(KeydError);
    return (e as KeydError).code;
  }
  throw new Error("expected a refusal");
};
const PUB = hex(ed.getPublicKey(SEED));

describe("keyd purpose boundary (V01)", () => {
  it("AT-KEY-01 sign refuses bytes with no purpose prefix (catches: keyd as a raw signing oracle)", () => {
    const s = svc();
    for (const m of [te.encode("no bar here"), te.encode("|leading-bar"), new Uint8Array([0xff, 0xfe, 0x7c, 0x41])]) {
      expect(refusedCode(() => call(s, "sign", { msg: hex(m) }))).toBe("forbidden");
    }
  });

  it("AT-KEY-02 sign refuses purposes an owner, admin or account key signs (catches: daemon minting owner authority)", () => {
    const s = svc();
    const ownerPurposes = [
      "flagship/server-order/v1", "flagship/update-order/v1", "flagship/app-access/v1", "flagship/app-rank/v1",
      "flagship/server-wildcard-grant/v1", "flagship/debug-access/v2", "flagship/release-endorsement/v2",
      "flagship/assurance-policy/v1", "flagship/chat-approval/v1", "flagship/browser-grant/v1",
    ];
    for (const p of ownerPurposes) {
      expect(BOX_SIGN_PURPOSES.has(p), p).toBe(false);
      expect(refusedCode(() => call(s, "sign", { msg: hex(te.encode(`${p}|x|1`)) })), p).toBe("forbidden");
    }
    // Case and whitespace variants are different purposes, not aliases.
    expect(refusedCode(() => call(s, "sign", { msg: hex(te.encode("FLAGSHIP/daemon-status/v1|x")) }))).toBe("forbidden");
    expect(refusedCode(() => call(s, "sign", { msg: hex(te.encode(" flagship/daemon-status/v1|x")) }))).toBe("forbidden");
  });

  it("AT-KEY-03 hybrid-only purposes are refused through classical sign (catches: a classical-only binding a strict verifier might accept)", () => {
    const s = svc();
    for (const p of HYBRID_ONLY_PURPOSES) {
      expect(refusedCode(() => call(s, "sign", { msg: hex(te.encode(`${p}|a|b|c|d|1`)) })), p).toBe("forbidden");
    }
  });

  it("AT-KEY-04 pq-key-binding binds only this box's own keys as box-stk (catches: daemon binding a foreign ML-DSA key to the STK)", () => {
    const mldsa = "ab".repeat(16);
    const ok = te.encode(`flagship/pq-key-binding/v1|box-stk|home.alice.flagship.services|${PUB}|${mldsa}|1`);
    expect(checkSign(ok, PUB, BOX_SIGN_PURPOSES, { mldsaPubHex: mldsa })).toBe("flagship/pq-key-binding/v1");
    const variants = [
      `flagship/pq-key-binding/v1|device|home.alice.flagship.services|${PUB}|${mldsa}|1`,
      `flagship/pq-key-binding/v1|box-stk|home.alice.flagship.services|${"00".repeat(32)}|${mldsa}|1`,
      `flagship/pq-key-binding/v1|box-stk|home.alice.flagship.services|${PUB}|${"cd".repeat(16)}|1`,
      `flagship/pq-key-binding/v1|box-stk|home.alice.flagship.services|${PUB}|${mldsa}|1|extra`,
    ];
    for (const v of variants) {
      expect(() => checkSign(te.encode(v), PUB, BOX_SIGN_PURPOSES, { mldsaPubHex: mldsa }), v).toThrow(KeydError);
    }
  });

  it("AT-KEY-05 boot-suspension signs only a suspend as box; boot-auth only as the box's key (catches: daemon unsuspending itself)", () => {
    const sus = (action: string, signer: string, seq = "1") => te.encode(`flagship/boot-suspension/v1|home.alice.flagship.services|1|${seq}|${action}|r|${signer}|1`);
    expect(checkSign(sus("suspend", "box"), PUB)).toBe("flagship/boot-suspension/v1");
    for (const m of [sus("resume", "box"), sus("suspend", "owner"), sus("suspend", "box", "0")]) expect(() => checkSign(m, PUB)).toThrow(KeydError);
    const auth = (role: string, key: string) => te.encode(`flagship/boot-auth/v1|${role}|home.alice.flagship.services|POST|/x|${key}|00|1`);
    expect(checkSign(auth("box", PUB), PUB)).toBe("flagship/boot-auth/v1");
    expect(() => checkSign(auth("owner", PUB), PUB)).toThrow(KeydError);
    expect(() => checkSign(auth("box", "11".repeat(32)), PUB)).toThrow(KeydError);
  });

  it("AT-KEY-06 empty and oversized sign requests are refused (catches: unbounded work per request)", () => {
    expect(() => checkSign(new Uint8Array(0), PUB)).toThrow(KeydError);
    const big = new Uint8Array(256 * 1024 + 1).fill(0x41);
    big.set(te.encode("flagship/daemon-status/v1|"));
    expect(() => checkSign(big, PUB)).toThrow(KeydError);
  });

  it("AT-KEY-07 swk.hkdf derives only listed labels, unsalted (catches: SWK subkeys for chunk/LLM/app secrets leaving keyd)", () => {
    const s = svc();
    for (const label of SWK_HKDF_LABELS) expect(call(s, "swk.hkdf", { info: label, salt: "" }).result.key).toMatch(/^[0-9a-f]{64}$/);
    for (const label of ["flagship.tls.v1", "flagship/llm-payload/v1", "flagship.pb-manifest.v1 ", "x"]) {
      expect(refusedCode(() => call(s, "swk.hkdf", { info: label, salt: "" })), label).toBe("forbidden");
    }
    expect(() => call(s, "swk.hkdf", { info: [...SWK_HKDF_LABELS][0], salt: "00" })).toThrow(KeydError);
  });

  it("AT-KEY-08 the CGK MACs only its two tagged message kinds (catches: CGK as a general MAC oracle forging other box-to-box MACs)", () => {
    const s = svc();
    expect(call(s, "cgk.gossipMac", { msg: hex(te.encode("flagship/gossip/v2|x")) }).result.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(call(s, "cgk.accessSyncMac", { msg: hex(te.encode("flagship/access-sync/v1|x")) }).result.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(refusedCode(() => call(s, "cgk.gossipMac", { msg: hex(te.encode("flagship/access-sync/v1|x")) }))).toBe("forbidden");
    expect(refusedCode(() => call(s, "cgk.accessSyncMac", { msg: hex(te.encode("flagship/gossip/v2|x")) }))).toBe("forbidden");
    expect(refusedCode(() => call(s, "cgk.gossipMac", { msg: hex(te.encode("other|x")) }))).toBe("forbidden");
    // The two MAC keys differ, so one kind's MAC never stands for the other.
    const g = call(s, "cgk.gossipMac", { msg: hex(te.encode("flagship/gossip/v2|same")) }).result.mac;
    const a = call(s, "cgk.accessSyncMac", { msg: hex(te.encode("flagship/access-sync/v1|same")) }).result.mac;
    expect(g).not.toBe(a);
  });

  it("AT-KEY-09 unseal opens only the pairing-order purpose (catches: keyd returning sealed SWK/CGK/ACME keys)", () => {
    const s = svc();
    for (const p of ["swk", "cgk", "acme", "luks", "pairing-order "]) {
      expect(refusedCode(() => call(s, "unseal", { blob: "00".repeat(64), purpose: p })), p).toBe("forbidden");
    }
  });

  it("AT-KEY-10 the wire refuses unknown ops and fields (catches: an asserted identity or hidden flag in the request)", () => {
    expect(refusedCode(() => parseRequest({ id: 1, op: "getPrivateKey", args: {} }))).toBe("unknown-op");
    expect(refusedCode(() => parseRequest({ id: 1, op: "sign", args: {}, uid: 0 }))).toBe("bad-request");
    expect(refusedCode(() => parseRequest({ id: -1, op: "sign", args: {} }))).toBe("bad-request");
    expect(refusedCode(() => parseRequest({ id: 1, op: "sign", args: [] }))).toBe("bad-request");
    const s = svc();
    expect(refusedCode(() => call(s, "sign", { msg: hex(te.encode("flagship/daemon-status/v1|x")), role: "owner" }))).toBe("bad-request");
  });

  it("AT-KEY-11 derivations take only shaped inputs (catches: one app's secret derived under another's id)", () => {
    const s = svc();
    for (const id of ["Alice--chess", "a--b--c", "../x", "", "a b"]) expect(() => call(s, "swk.deriveServiceSecret", { serviceId: id }), id).toThrow(KeydError);
    const one = call(s, "swk.deriveServiceSecret", { serviceId: "alice--chess" }).result.secret;
    const two = call(s, "swk.deriveServiceSecret", { serviceId: "alice--notes" }).result.secret;
    expect(one).not.toBe(two);
    expect(refusedCode(() => call(s, "cgk.deriveAppCopyEnvKey", { info: hex(te.encode("other/v1|x")) }))).toBe("forbidden");
  });

  it("AT-KEY-12 swk.deriveTlsKey takes any server id string (known gap, REGISTER K01: unscoped derivation; tracked, not a new finding)", () => {
    const s = svc();
    const k = call(s, "swk.deriveTlsKey", { serverId: "not-this-box.example" }).result.key;
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});
