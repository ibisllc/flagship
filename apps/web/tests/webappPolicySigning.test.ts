// The browser's strict opt-in and hybrid sensitive orders (lib/policySigning.js, lib/adminSigning.js;
// docs/webapp-key-custody.md item 4): a change signed hybrid by the bound admin root passes the same
// policy rules .com and the box apply, and the server order, direct access and update orders carry
// their quantum-safe companion.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DATABASES, makeIndexedDBShim, makeLocalStorage } from "./support/idbShim";

const ROOT = join(__dirname, "../../..");
const WASM = readFileSync(join(ROOT, "apps/web/public/webapp/vendor/mldsa-wasm/mldsa65.wasm"));
/* eslint-disable @typescript-eslint/no-explicit-any */
let ks: any, kc: any, ps: any, ap: any, pb: any, as: any, so: any;
const UMK = new Uint8Array(32).fill(3);
const ADMIN = new Uint8Array(32).fill(5);

function fakeAuth() {
  const prf = async (salt: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([7, ...salt])));
  return { create: async ({ salt }: any) => ({ credentialId: "c", prf: await prf(salt) }), get: async ({ salt }: any) => ({ prf: await prf(salt) }) };
}

describe("webapp policy signing", () => {
  beforeAll(async () => {
    const mw = await import("../public/webapp/lib/mldsaWasm.js");
    mw.setMldsaWasmBytesForTests(new Uint8Array(WASM));
    ks = await import("../public/webapp/keystore.js");
    kc = await import("../public/webapp/lib/keyCustody.js");
    ps = await import("../public/webapp/lib/policySigning.js");
    ap = await import("../public/webapp/lib/assurancePolicy.js");
    pb = await import("../public/webapp/lib/pqBinding.js");
    as = await import("../public/webapp/lib/adminSigning.js");
    so = await import("../public/webapp/lib/serverOrder.js");
  });
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => {
    kc.setCustodyAuthenticatorForTests(null);
    kc.setCustodyBindHook(null);
  });

  async function boundHandle(bound = true) {
    kc.setCustodyAuthenticatorForTests(fakeAuth());
    let wire: any = null;
    kc.setCustodyBindHook(async (seeds: any) => {
      const { signPqKeyBinding } = await import("../public/webapp/lib/pqSign.js");
      wire = await signPqKeyBinding({ role: "admin-root", subjectId: "alice", issuedAt: 1 }, seeds.edSeed, seeds.mldsaSeed);
      return bound;
    });
    await ks.persistAdminRootSeed(UMK, ADMIN);
    const h = await kc.loadAdminRootKey(() => UMK);
    await kc.withAdminRoot(h, async () => {});
    return { h, binding: pb.verifyPqKeyBinding(wire, { role: "admin-root", subjectId: "alice", ed25519PubHex: h.pubHex, now: 2 }) };
  }

  it("computes the affected peers digest as every port does", async () => {
    const want = createHash("sha256").update("a.x|b.x").digest("hex");
    expect(await ps.affectedPeersDigest(["B.x", "a.x", "b.x"])).toBe(want);
  });

  it("turns strict on with a hybrid change that applies, and refuses without an answer", async () => {
    const { h, binding } = await boundHandle();
    const scope = { kind: "installation", id: "home.alice.flagship.services" };
    const state = { ...ap.legacyPolicyState(scope), rollout: "prepared" };
    await expect(ps.strictChange({ account: "alice", scope, state, peers: [], signerKeyId: h.pubHex })).rejects.toThrow();
    const change = await ps.strictChange({ account: "Alice", scope, state, browsersAllowed: true, peers: [scope.id], signerKeyId: h.pubHex, now: 10 });
    expect(change.acknowledgedLoss).toEqual([ps.BROWSER_LOSS]);
    let posted: any = null;
    const code = await ps.signAndPostPolicyChange(change, h, { apex: "https://x", fetch: async (_u: string, init: any) => { posted = JSON.parse(init.body); return new Response("{}"); } });
    expect(code).toBeNull();
    const next = ap.applyPolicyChange(state, posted.change, (msg: Uint8Array) => {
      const v = pb.verifyCriticalSignature({ message: msg, expectedPurpose: ap.TAG_ASSURANCE_POLICY, envelope: posted.signature, signerEd25519PubHex: h.pubHex, binding, policy: { profile: "strict", rollout: "enforced" } });
      return { suiteVerified: v.strict === true, signerActive: true };
    });
    expect(ap.strictInForce(next)).toBe(true);
    const off = await ps.compatibilityChange({ account: "alice", scope, state: next, loss: ps.LEAVING_STRICT_LOSS, peers: [scope.id], signerKeyId: h.pubHex, now: 11 });
    expect(off.acknowledgedLoss).toEqual([...ps.LEAVING_STRICT_LOSS].sort());
  });

  it("a browser whose ML-DSA half isn't on record can't sign policy", async () => {
    const { h } = await boundHandle(false);
    expect(ps.policySignerProblem(h)).toBe("not-bound");
    expect(ps.policySignerProblem(null)).toBe("not-admin");
    const scope = { kind: "installation", id: "s.x" };
    const change = await ps.strictChange({ account: "alice", scope, state: ap.legacyPolicyState(scope), browsersAllowed: false, peers: [], signerKeyId: h.pubHex });
    await expect(ps.signAndPostPolicyChange(change, h)).rejects.toMatchObject({ code: "not-bound" });
  });

  it("the server order carries a companion the box's gate accepts", async () => {
    const { h, binding } = await boundHandle();
    const session = { umk: UMK, adminRootSeed: h, username: "alice" };
    const wire = await so.buildSignedServerOrder({ username: "alice", stks: ["aa".repeat(32)] }, { umk: UMK, sign: as.sensitiveHybridSigner(session), now: () => 5 });
    expect(wire.pqSignature?.suite).toBe("hybrid-ed25519-mldsa65/v1");
    const msg = so.canonicalServerOrderBytes(wire.order);
    expect(await ks.verifyWithEd25519Pub(ks.hexToBytes(h.pubHex), ks.hexToBytes(wire.signature), msg)).toBe(true);
    expect(pb.verifyCriticalSignature({ message: msg, expectedPurpose: "flagship/server-order/v1", envelope: wire.pqSignature, signerEd25519PubHex: h.pubHex, binding, policy: { profile: "strict", rollout: "enforced" } })).toMatchObject({ strict: true });
  });

  it("a non-sensitive message keeps the classical path with no companion", async () => {
    const parts = as.signedParts(new Uint8Array([1, 2]));
    expect(parts.pqSignature).toBeNull();
  });
});
