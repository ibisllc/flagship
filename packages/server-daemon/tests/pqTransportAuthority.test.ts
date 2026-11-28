/**
 * Strict by default (pq-suites.md §21.1): an order that reached the box over a quantum-safe path
 * (a device's PQ channel, a vouched-for sibling) or the owner's labelled browser exception needs
 * no second hybrid signature; one that came any other way still does.
 */
import { describe, expect, it } from "vitest";
import { ed, type PolicyState } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../src/adminAuthorityLocal.js";
import { withTransportAuthority, type PqAuthorityContext } from "../src/pqAuthority.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);
const root = { seed: seed(2), pub: ed.getPublicKey(seed(2)) };
const irk = { seed: seed(1), pub: ed.getPublicKey(seed(1)) };
const scope = { kind: "installation" as const, id: "home.alice.flagship.services" };
const strict: PolicyState = { scope, profile: "strict", rollout: "enforced", generation: 1, headDigest: "a".repeat(64), enforcedEver: true };
const compat: PolicyState = { scope, profile: "compatibility", rollout: "legacy", generation: 0, headDigest: "0".repeat(64), enforcedEver: false };
const pq = (p: PolicyState): PqAuthorityContext => ({ policy: () => p, bindingFor: () => null });

const order = { what: "set-mode", mode: "open" };
const bytes = (o: typeof order) => new TextEncoder().encode(`test/order/v1|${o.what}|${o.mode}`);
const verify = (o: typeof order, sig: Uint8Array, pub: Uint8Array) => ed.verify(sig, bytes(o), pub);
const signedBy = (k: { seed: Uint8Array }) => ed.sign(bytes(order), k.seed);

const authorize = (p: PolicyState, sig = signedBy(root)) =>
  authorizeSensitiveOrder({ order, signature: sig, verify, ownerIrkPub: irk.pub, adminRootPub: root.pub, username: "alice", pq: pq(p) });

describe("the strict gate and how an order arrived", () => {
  it("refuses a classical-only order that came no quantum-safe way, as before", () => {
    expect(authorize(compat)).toBe(true);
    expect(authorize(strict)).toBe(false);
  });

  it("takes the admin root's order over an admin device's PQ channel, not over a member device's", () => {
    expect(withTransportAuthority({ kind: "device", actsFor: new Set([hex(root.pub), hex(irk.pub)]) }, () => authorize(strict))).toBe(true);
    expect(withTransportAuthority({ kind: "device", actsFor: new Set([hex(irk.pub), "ab".repeat(32)]) }, () => authorize(strict))).toBe(false);
  });

  it("takes entries a vouched-for sibling relayed, and the owner's browser exception", () => {
    expect(withTransportAuthority({ kind: "sibling" }, () => authorize(strict))).toBe(true);
    expect(withTransportAuthority({ kind: "browser" }, () => authorize(strict))).toBe(true);
  });

  it("never lets a transport stand in for the classical signature itself", () => {
    expect(withTransportAuthority({ kind: "browser" }, () => authorize(strict, signedBy({ seed: seed(9) })))).toBe(false);
    expect(withTransportAuthority({ kind: "browser" }, () => authorize(strict, signedBy(irk)))).toBe(false);
  });

  it("keeps the authority across awaits inside the request, and drops it after", async () => {
    const inside = await withTransportAuthority({ kind: "sibling" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return authorize(strict);
    });
    expect(inside).toBe(true);
    expect(authorize(strict)).toBe(false);
  });
});

describe("orders a phone deposits through .com carry their own hybrid signature", async () => {
  const { canonicalPqKeyBinding, canonicalServerDecommission, canonicalServersSelfDelete, hybridSign, hybridSigKeygen, messagePurpose, signServerDecommission, signServersSelfDelete, verifyPqKeyBinding } = await import("@flagship/protocol");
  const { setPqAuthority } = await import("../src/pqAuthority.js");
  const { decodeAndVerifyDecommissionOrder } = await import("../src/decommissionConsumer.js");
  const { decodeAndVerifySelfDeleteCarrier } = await import("../src/selfDeleteConsumer.js");
  const sk = Uint8Array.from([...root.seed, ...seed(102)]);
  const hyb = (m: Uint8Array) => ({ suite: "hybrid-ed25519-mldsa65/v1", signature: hex(hybridSign(sk, messagePurpose(m), m)) });
  const T = 1_790_000_000_000;
  const st = { role: "admin-root" as const, subjectId: "alice", ed25519PubHex: hex(root.pub), mldsaPubHex: hex(hybridSigKeygen(root.seed, seed(102)).publicKey.subarray(32)), issuedAt: T };
  const rootBinding = verifyPqKeyBinding({ v: 1, ...st, signature: hyb(canonicalPqKeyBinding(st)).signature }, { role: "admin-root", subjectId: "alice", ed25519PubHex: hex(root.pub), now: T });
  const strictCtx = { policy: () => strict, bindingFor: (p: string) => (p === hex(root.pub) ? rootBinding : null) };
  const kp = { privateKey: root.seed, publicKey: root.pub } as never;

  it("a decommission: refused classical-only under strict, taken with its hybrid half", () => {
    const order = { podCanonical: "home.alice.flagship.services", retiredStkPubHex: "ab".repeat(32), finalBackup: false, diskDisposition: "wipe-now" as const, backupEpoch: 0, nonce: "cd".repeat(16), issuedAt: T };
    const sig = hex(signServerDecommission(order, kp));
    const args = (json: unknown) => ({ orderJson: JSON.stringify(json), orderSignatureHex: sig, ownerIrkPub: irk.pub, adminRootPub: root.pub, username: "alice" });
    setPqAuthority(strictCtx);
    try {
      expect(() => decodeAndVerifyDecommissionOrder(args(order))).toThrow(/not authorized/);
      expect(decodeAndVerifyDecommissionOrder(args({ ...order, pqSignature: hyb(canonicalServerDecommission(order)) })).nonce).toBe(order.nonce);
      expect(() => decodeAndVerifyDecommissionOrder(args({ ...order, pqSignature: hyb(canonicalServerDecommission({ ...order, nonce: "ee".repeat(16) })) }))).toThrow(/not authorized/);
    } finally {
      setPqAuthority(null);
    }
  });

  it("an account's self-delete: the same", () => {
    const order = { username: "alice", issuedAt: T };
    const sig = hex(signServersSelfDelete(order, kp));
    const carrier = (extra: object) => Buffer.from(JSON.stringify({ request: order, signature: sig, ...extra })).toString("hex");
    setPqAuthority(strictCtx);
    try {
      expect(() => decodeAndVerifySelfDeleteCarrier({ sealedHex: carrier({}), ownerIrkPub: irk.pub, adminRootPub: root.pub, username: "alice", now: T })).toThrow(/not authorized/);
      expect(decodeAndVerifySelfDeleteCarrier({ sealedHex: carrier({ pqSignature: hyb(canonicalServersSelfDelete(order)) }), ownerIrkPub: irk.pub, adminRootPub: root.pub, username: "alice", now: T }).username).toBe("alice");
    } finally {
      setPqAuthority(null);
    }
  });
});

describe("app copies while strict", async () => {
  const { strictAwareLanFetch } = await import("../src/appCopy/lanFetch.js");
  it("skip the local network, so the order goes over the PQ channel through the relay", async () => {
    let calls = 0;
    const lan = async () => (calls++, new Response("ok"));
    let strictNow = true;
    const f = strictAwareLanFetch(() => strictNow, lan as never);
    await expect(f({ address: "192.168.1.2", port: 443 } as never, "https://x", {})).rejects.toThrow(/relay/);
    strictNow = false;
    expect((await f({ address: "192.168.1.2", port: 443 } as never, "https://x", {})).status).toBe(200);
    expect(calls).toBe(1);
  });
});
