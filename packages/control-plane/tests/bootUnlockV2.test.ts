import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bootKeyBindingToWire, ed, signBootKeyBinding } from "@flagship/protocol";
import { InMemoryPqTrustStorage, InMemoryStorage } from "@flagship/storage";
import { handleGetBootKey, handlePutBootKey } from "../src/bootKeys.js";
import { routeBoot } from "../../boot-core/src/routes.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/boot-unlock-v2/vectors.json"), "utf8"));
const S: string = V.serverDomain;
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const stk = { privateKey: unhex(V.keys.stk.edSeed), publicKey: unhex(V.keys.stk.publicKey.slice(0, 64)) };
const T: number = V.now;

async function world() {
  const storage = new InMemoryStorage();
  const pqTrust = new InMemoryPqTrustStorage();
  await storage.servers.put({ serverDomain: S, username: "john", identityPubKeyHex: V.keys.stk.publicKey.slice(0, 64), registeredAt: T - 10_000 });
  const b = V.stkBinding;
  await pqTrust.putBinding({ role: b.role, subjectId: b.subjectId, ed25519PubHex: b.ed25519PubHex, mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt, signatureHex: b.signature, storedAt: T });
  return { storage, pqTrust, deps: { servers: storage.servers, serverBootKeys: storage.serverBootKeys, pqTrust, now: () => T } };
}
const v1 = () => {
  const b = { serverDomain: S, bootPubHex: V.keys.boot.pubHex, issuedAt: T - 300 };
  return bootKeyBindingToWire(b, signBootKeyBinding(b, stk));
};

describe("boot unlock v2 on .com", () => {
  it("stores the boot key's v2 material only when the STK's hybrid key vouches for it, and serves it", async () => {
    const { deps } = await world();
    expect((await handlePutBootKey(deps, S, { ...v1(), pq: V.material.wire })).status).toBe(200);
    const got = await handleGetBootKey(deps, S);
    expect((got.body as { pq: unknown }).pq).toEqual(V.material.wire);
    for (const c of V.material.cases.filter((x: { expect: string; bootPubHex: string }) => x.expect !== "ok" && x.bootPubHex === V.keys.boot.pubHex)) {
      const { deps: d } = await world();
      const res = await handlePutBootKey(d, S, { ...v1(), pq: c.wire });
      expect(res.status, c.name).toBe(403);
      expect(String((res.body as { error: string }).error), c.name).toContain(c.expect);
    }
  });

  it("refuses v2 material without the STK's binding on file", async () => {
    const { storage } = await world();
    const deps = { servers: storage.servers, serverBootKeys: storage.serverBootKeys, pqTrust: new InMemoryPqTrustStorage(), now: () => T };
    expect((await handlePutBootKey(deps, S, { ...v1(), pq: V.material.wire })).status).toBe(403);
  });

  it("stops serving it once the boot key changes", async () => {
    const { deps } = await world();
    await handlePutBootKey(deps, S, { ...v1(), pq: V.material.wire });
    const other = { privateKey: new Uint8Array(32).fill(0x0c), publicKey: ed.getPublicKey(new Uint8Array(32).fill(0x0c)) };
    const b = { serverDomain: S, bootPubHex: Buffer.from(other.publicKey).toString("hex"), issuedAt: T };
    expect((await handlePutBootKey(deps, S, bootKeyBindingToWire(b, signBootKeyBinding(b, stk)))).status).toBe(200);
    expect((await handleGetBootKey(deps, S)).body).not.toHaveProperty("pq");
  });

  it("the boot worker parks a v2 request's extension and refuses a malformed one", async () => {
    const pqTrust = new InMemoryPqTrustStorage();
    const puts: string[] = [];
    const base = {
      boxSealedLeases: null as never,
      bootSuspensions: null as never,
      secretMailbox: null as never,
      directory: null as never,
      notify: null as never,
      gate: null as never,
      requestPq: { put: async (d: string, n: string, j: string, e: number) => { puts.push(j); await pqTrust.putRequestPq(d, n, j, e); } },
    };
    const req = { serverDomain: S, stkPub: V.keys.boot.pubHex, purpose: "unlock-key", nonce: V.request.fields.nonceHex, issuedAt: T };
    const bad = await routeBoot(base, "POST", "/api/boot/request", null, { request: req, signature: "00".repeat(64), pq: { ...V.request.pq, extra: 1 } });
    expect(bad?.status).toBe(400);
    const ent = await routeBoot(base, "POST", "/api/boot/request", null, { request: { ...req, purpose: "entitlement" }, signature: "00".repeat(64), pq: V.request.pq });
    expect(ent?.status).toBe(400);
    expect(puts).toEqual([]);
  });
});
