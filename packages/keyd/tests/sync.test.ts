import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed, opaqueKey, signBootSuspension, verifyBootSuspension, sealForEd25519Recipient, openSealedFromEd25519Recipient } from "@flagship/protocol";
import { KeydSyncClient } from "../src/index.js";
import { SEED, startInWorker } from "./helpers.js";

const PUB = ed.getPublicKey(SEED);
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let keyd: Awaited<ReturnType<typeof startInWorker>>;
let client: KeydSyncClient;
beforeAll(async () => {
  keyd = await startInWorker();
  client = new KeydSyncClient({ socketPath: keyd.sock, component: "sync-test" });
  client.connect();
});
afterAll(async () => {
  client.close();
  await keyd.stop();
});

describe("the synchronous client", () => {
  it("signs inline and reports refusals as errors", () => {
    const msg = enc("flagship/secret-request/v1|x");
    const sig = Uint8Array.from(Buffer.from(String(client.call("sign", { msg: hex(msg) }).sig), "hex"));
    expect(ed.verify(sig, msg, PUB)).toBe(true);
    expect(() => client.call("sign", { msg: hex(enc("flagship/server-update/v1|x")) })).toThrow(/does not sign/);
  });

  it("answers many calls in a row", () => {
    for (let i = 0; i < 200; i++) {
      const r = client.call("swk.deriveServiceSecret", { serviceId: `alice--app${i}` });
      expect(String(r.secret)).toHaveLength(64);
    }
  });

  it("makes an opaque key usable by the protocol's own signers and sealed-blob opener", () => {
    const key = opaqueKey({
      publicKey: PUB,
      sign: (m) => Uint8Array.from(Buffer.from(String(client.call("sign", { msg: hex(m) }).sig), "hex")),
      unseal: (b) => Uint8Array.from(Buffer.from(String(client.call("unseal", { blob: hex(b) }).plain), "hex")),
    });
    const order = { serverDomain: "home.a.flagship.services", epoch: 1, seq: 1, action: "suspend" as const, reason: "dead-man", signer: "box" as const, issuedAt: 1760000000000 };
    expect(verifyBootSuspension(order, signBootSuspension(order, key), PUB)).toBe(true);
    const blob = sealForEd25519Recipient(enc("sealed"), PUB);
    expect(new TextDecoder().decode(openSealedFromEd25519Recipient(blob, key))).toBe("sealed");
    // keyd still refuses what policy forbids, even through the protocol's signers.
    const bad = { ...order, signer: "owner" as const };
    expect(() => signBootSuspension(bad, key)).toThrow();
  });

  it("fails clearly when keyd is not there", () => {
    const dead = new KeydSyncClient({ socketPath: "/nonexistent/keyd.sock", component: "x", timeoutMs: 2000 });
    expect(() => dead.connect()).toThrow(/keyd/);
  });
});
