/**
 * Architecture v2 pilot, box side against the real `.com` handlers: keyd's hybrid key binds to
 * the STK, the boot-key binding gains its v2 hybrid signature, and the status report passes the
 * gate on a strict installation.
 */
import { describe, expect, it } from "vitest";
import { ed, hybridSigKeygen, hybridSign, messagePurpose } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetBootKey, handleGetPqKeyBinding, handlePostDaemonStatus, handlePutBootKey, handlePutPqKeyBinding } from "@flagship/control-plane";
import { ensureStkPqBinding } from "../src/pqKeyBinding.js";
import { ensureBootKeyBinding } from "../src/bootKeyFiles.js";
import { postDaemonStatus } from "../src/daemonStatusHeartbeat.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const S = "home.alice.flagship.services";
const stkSeed = new Uint8Array(32).fill(0x0b);
const pqSeed = new Uint8Array(32).fill(0x2b);
const stk = { privateKey: stkSeed, publicKey: ed.getPublicKey(stkSeed) };
const mldsaPubHex = hex(hybridSigKeygen(stkSeed, pqSeed).publicKey.subarray(32));
const stkHybrid = (m: Uint8Array) => hybridSign(Uint8Array.from([...stkSeed, ...pqSeed]), messagePurpose(m), m);
const bootPub = ed.getPublicKey(new Uint8Array(32).fill(0x1b));
const BASE = "https://flagshipserver.com";

async function com() {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  await storage.pqTrust.putPolicy({ scopeKind: "installation", scopeId: S, profile: "strict", rollout: "enforced", generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: 1 });
  const pq = { servers: storage.servers, pqTrust: storage.pqTrust };
  const boot = { ...pq, serverBootKeys: storage.serverBootKeys };
  const status = { daemonStatus: storage.daemonStatus, servers: storage.servers, routing: storage.routing, pqTrust: storage.pqTrust };
  const puts: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const put = init?.method === "PUT";
    if (put || init?.method === "POST") puts.push(new URL(url).pathname);
    const res = url.endsWith("/pq-key-binding")
      ? put ? await handlePutPqKeyBinding(pq, S, body) : await handleGetPqKeyBinding(pq, S)
      : url.endsWith("/boot-key")
        ? put ? await handlePutBootKey(boot, S, body) : await handleGetBootKey(boot, S)
        : await handlePostDaemonStatus(status, body);
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  return { storage, fetchImpl, puts };
}

describe("the box's hybrid key on a strict installation", () => {
  it("binds once, re-binds the boot key with both signatures, and reports through the gate", async () => {
    const c = await com();
    const args = { serverDomain: S, stkPubHex: hex(stk.publicKey), mldsaPubHex, stkHybrid, controlPlaneBaseUrl: BASE, fetch: c.fetchImpl };
    expect((await ensureStkPqBinding(args)).status).toBe("bound");
    expect((await ensureStkPqBinding(args)).status).toBe("ok");

    const files = new Map([["/boot/flagship-boot-key.pub", hex(bootPub)]]);
    const deps = { exists: (p: string) => files.has(p), read: async (p: string) => files.get(p)!, write: async () => {} };
    const boot = { serverDomain: S, stkPub: stk.publicKey, signer: stk, controlPlaneBaseUrl: BASE, fetch: c.fetchImpl, files: deps };
    // A strict installation refuses the classical-only binding.
    await expect(ensureBootKeyBinding(boot)).rejects.toThrow(/HTTP 403/);
    expect(await ensureBootKeyBinding({ ...boot, stkHybrid })).toBe("bound");
    expect(await ensureBootKeyBinding({ ...boot, stkHybrid })).toBe("ok");
    expect(typeof (await c.storage.pqTrust.getBootHybrid(S))?.hybridSignatureHex).toBe("string");

    const cert = { certPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n", keyPem: "" } as never;
    c.puts.length = 0;
    await postDaemonStatus({ serverDomain: S, sign: stk, controlPlaneBaseUrl: BASE, cert, certValidUntil: NaN, appsServed: [], fetchImpl: c.fetchImpl });
    expect(await c.storage.daemonStatus.get(S)).toBeUndefined();
    await postDaemonStatus({ serverDomain: S, sign: stk, stkHybrid, controlPlaneBaseUrl: BASE, cert, certValidUntil: NaN, appsServed: [], fetchImpl: c.fetchImpl });
    expect((await c.storage.daemonStatus.get(S))?.serverDomain).toBe(S);
  });
});
