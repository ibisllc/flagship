import { describe, expect, it } from "vitest";
import { ed, verifiedBootKey } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetBootKey, handlePutBootKey } from "@flagship/control-plane";
import { ensureBootKeyBinding, rebindBootKey, syncOwnerKeyFile } from "../src/bootKeyFiles.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const S = "home.alice.flagship.services";
const stk = kp(0x0b);
const stk2 = kp(0x0d);
const boot = kp(0x1b);

function files(initial: Record<string, string>) {
  const fs = new Map(Object.entries(initial));
  return {
    fs,
    deps: {
      exists: (p: string) => fs.has(p),
      read: async (p: string) => {
        const v = fs.get(p);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
      write: async (p: string, d: string) => void fs.set(p, d),
    },
  };
}

async function comWith(stkPub: Uint8Array) {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stkPub), registeredAt: 1 });
  const deps = { servers: storage.servers, serverBootKeys: storage.serverBootKeys };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const res = init?.method === "PUT" ? await handlePutBootKey(deps, S, JSON.parse(String(init.body))) : await handleGetBootKey(deps, S);
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  return { storage, deps, fetchImpl };
}

describe("boot key files", () => {
  it("keeps the owner key file in step with the account key, only on a boot-key box", async () => {
    const f = files({ "/boot/flagship-boot-key.pub": hex(boot.publicKey) });
    expect(await syncOwnerKeyFile("ab".repeat(32), f.deps)).toBe(true);
    expect(f.fs.get("/boot/flagship-owner-key.pub")).toBe(`${"ab".repeat(32)}\n`);
    expect(await syncOwnerKeyFile("ab".repeat(32), f.deps)).toBe(false);
    const legacy = files({});
    expect(await syncOwnerKeyFile("ab".repeat(32), legacy.deps)).toBe(false);
    expect(legacy.fs.size).toBe(0);
  });

  it("signs the binding again when .com's binding is missing or from another STK", async () => {
    const f = files({ "/boot/flagship-boot-key.pub": `${hex(boot.publicKey)}\n` });
    const com = await comWith(stk.publicKey);
    const args = { serverDomain: S, stkPub: stk.publicKey, signer: stk, controlPlaneBaseUrl: "https://flagshipserver.com", fetch: com.fetchImpl, files: f.deps };
    expect(await ensureBootKeyBinding(args)).toBe("bound");
    expect(await ensureBootKeyBinding(args)).toBe("ok");
    // The STK changed (rotation): the new STK vouches for the same boot key.
    await com.storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk2.publicKey), registeredAt: 1 });
    expect(await ensureBootKeyBinding({ ...args, stkPub: stk2.publicKey, signer: stk2 })).toBe("bound");
    const served = (await handleGetBootKey(com.deps, S)).body;
    expect(verifiedBootKey(served, { serverDomain: S, stkPubHex: hex(stk2.publicKey) })).toBe(hex(boot.publicKey));
  });

  it("does nothing on a box without a boot key, and reports a refused binding", async () => {
    const com = await comWith(stk.publicKey);
    expect(await rebindBootKey({ serverDomain: S, stk, controlPlaneBaseUrl: "https://x", fetch: com.fetchImpl, files: files({}).deps })).toBe("no-boot-key");
    const f = files({ "/boot/flagship-boot-key.pub": hex(boot.publicKey) });
    await expect(rebindBootKey({ serverDomain: S, stk: stk2, controlPlaneBaseUrl: "https://x", fetch: com.fetchImpl, files: f.deps })).rejects.toThrow(/HTTP 403/);
  });
});
