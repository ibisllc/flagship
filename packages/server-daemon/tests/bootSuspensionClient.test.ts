/**
 * The box's suspension client against the real boot-worker router (in
 * process): a lapse locks the server durably, the box key cannot undo it,
 * and every failure is reported as unconfirmed rather than locked.
 */
import { describe, expect, it } from "vitest";
import { routeBoot, type BootRouteDeps, type DirectoryClient } from "@flagship/boot-core";
import { InMemoryNonceStore } from "@flagship/boot-core";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { ed, buildAutoUnlockLeaseV2, signAutoUnlockLeaseV2, signBootSuspension } from "@flagship/protocol";
import { KeyCustodian } from "../src/keyCustodian.js";
import { BootSuspensionClient, bootBaseFromControl } from "../src/bootSuspensionClient.js";

const S = "home.alice.flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const boxPriv = new Uint8Array(32).fill(21);
const boxPub = ed.getPublicKey(boxPriv);
const ownerPriv = new Uint8Array(32).fill(22);
const ownerPub = ed.getPublicKey(ownerPriv);
let t = 1_800_000_000_000;

function world() {
  const directory: DirectoryClient = {
    boxStkForDomain: async (d) => (d === S ? hex(boxPub) : null),
    ownerIrkForDomain: async (d) => (d === S ? hex(ownerPub) : null),
    activeBootDelegatesForDomain: async (d) => (d === S ? [] : null),
    usernameForDomain: async (d) => (d === S ? "alice" : null),
  };
  const suspensions = new InMemoryBootSuspensionStorage();
  const deps: BootRouteDeps = {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(suspensions),
    bootSuspensions: suspensions,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { notifyOwner: async () => true },
    gate: { directory, nonces: new InMemoryNonceStore(), now: () => t },
    now: () => t,
  };
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const res = await routeBoot(deps, init.method ?? "GET", u.pathname, (init.headers as Record<string, string>)["authorization"] ?? null, init.body ? JSON.parse(init.body as string) : undefined);
    return new Response(JSON.stringify(res?.body ?? {}), { status: res?.status ?? 404 });
  };
  const custodian = new KeyCustodian({ identityPriv: boxPriv });
  const client = new BootSuspensionClient({
    serverDomain: S,
    bootBase: "https://boot.flagshipserver.com",
    signer: custodian,
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
  return { deps, client, calls, custodian, fetchImpl };
}

async function depositLease(deps: BootRouteDeps) {
  const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: boxPub, leaseId: "a".repeat(32), luksKey: new Uint8Array(32).fill(1), issuedAt: t, expiresAt: t + 3_600_000 });
  await deps.boxSealedLeases.put({
    serverDomain: S, leaseId: lease.leaseId, stkPubHex: hex(boxPub), sealedKeyHex: hex(lease.sealedKey), issuedAt: t, expiresAt: t + 3_600_000,
    maxUses: null, usesConsumed: 0, signatureHex: hex(signAutoUnlockLeaseV2(lease, { privateKey: ownerPriv, publicKey: ownerPub })), depositedAt: t,
  });
}

describe("BootSuspensionClient", () => {
  it("derives the boot host from the control host", () => {
    expect(bootBaseFromControl("https://flagshipserver.com")).toBe("https://boot.flagshipserver.com");
    expect(bootBaseFromControl("https://gym.flagshipserver.com/")).toBe("https://boot.gym.flagshipserver.com");
    expect(bootBaseFromControl("https://boot.flagshipserver.com")).toBe("https://boot.flagshipserver.com");
  });

  it("locks the server durably: leases revoked, nothing released, and the box cannot undo it", async () => {
    const { deps, client } = world();
    await depositLease(deps);
    const r = await client.suspend("dead-man", 5000);
    expect(r).toMatchObject({ confirmed: true, alreadySuspended: false, epoch: 0, seq: 1 });
    expect(await deps.boxSealedLeases.release(S, t)).toBeUndefined();
    expect(await deps.boxSealedLeases.list(S, t)).toEqual([]);
    expect(await deps.bootSuspensions.get(S)).toMatchObject({ suspended: true, signer: "box", reason: "dead-man" });
    // A second lapse is idempotent, not an error.
    expect(await client.suspend("dead-man", 5000)).toMatchObject({ confirmed: true, alreadySuspended: true });
  });

  it("the box's own signature cannot resume: only the owner's next epoch does", async () => {
    const { deps, client, custodian } = world();
    await client.suspend("manual-lock", 5000);
    expect(() => custodian.signBootSuspension({ serverDomain: S, epoch: 0, seq: 2, action: "resume", reason: "dead-man", signer: "box", issuedAt: t })).toThrow();
    expect(() => custodian.signBootSuspension({ serverDomain: S, epoch: 0, seq: 2, action: "suspend", reason: "dead-man", signer: "owner", issuedAt: t })).toThrow();
    const resume = { serverDomain: S, epoch: 1, seq: 0, action: "resume" as const, reason: "owner-resume" as const, signer: "owner" as const, issuedAt: t };
    const out = await deps.bootSuspensions.apply(resume, hex(signBootSuspension(resume, ownerPriv)), t);
    expect(out.ok && !out.state.suspended).toBe(true);
  });

  it("the custodian will not sign a boot request as anyone but the box", () => {
    const { custodian } = world();
    const base = { serverDomain: S, method: "GET", path: "/x", pubKeyHex: hex(boxPub), nonceHex: "0".repeat(64), issuedAt: t };
    expect(() => custodian.signBootAuthHeader({ ...base, role: "owner" })).toThrow();
    expect(() => custodian.signBootAuthHeader({ ...base, role: "box", pubKeyHex: hex(ownerPub) })).toThrow();
    expect(custodian.signBootAuthHeader({ ...base, role: "box" })).toMatch(/^Flagship-Boot-v1 /);
  });

  it("reports unconfirmed when the worker is unreachable, refuses, or cannot record", async () => {
    const down = world();
    const c1 = new BootSuspensionClient({ serverDomain: S, bootBase: "https://boot.x", signer: down.custodian, fetch: async () => { throw new Error("offline"); }, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(await c1.suspend("dead-man", 3000)).toEqual({ confirmed: false, why: "unreachable" });

    const w = world();
    w.deps.bootSuspensions = { get: async () => undefined, apply: async () => { throw new Error("storage down"); } };
    expect(await w.client.suspend("dead-man", 3000)).toEqual({ confirmed: false, why: "not-durable" });

    const w2 = world();
    const wrongKey = new BootSuspensionClient({
      serverDomain: S, bootBase: "https://boot.x", signer: new KeyCustodian({ identityPriv: new Uint8Array(32).fill(99) }),
      fetch: w2.fetchImpl, now: () => t, sleep: async (ms) => void (t += ms),
    });
    expect((await wrongKey.suspend("dead-man", 3000)).confirmed).toBe(false);
  });

  it("re-reads and retries when the record moved underneath it", async () => {
    const { deps, client, fetchImpl } = world();
    let first = true;
    const racing = new BootSuspensionClient({
      serverDomain: S, bootBase: "https://boot.x", signer: new KeyCustodian({ identityPriv: boxPriv }),
      fetch: async (url, init) => {
        // Between the box's read and its post, the owner resumes at epoch 1 (so the box's epoch 0 is stale).
        if (first && init.method === "POST") {
          first = false;
          const o = { serverDomain: S, epoch: 1, seq: 0, action: "resume" as const, reason: "owner-resume" as const, signer: "owner" as const, issuedAt: t };
          await deps.bootSuspensions.apply(o, hex(signBootSuspension(o, ownerPriv)), t);
        }
        return fetchImpl(url, init);
      },
      now: () => t, sleep: async (ms) => void (t += ms),
    });
    void client;
    const r = await racing.suspend("dead-man", 20_000);
    expect(r).toMatchObject({ confirmed: true });
    expect(await deps.bootSuspensions.get(S)).toMatchObject({ suspended: true, epoch: 1 });
  });
});
