/**
 * SEC-LOCK-001: the suspension record and lease release, against both the
 * in-memory store and the production D1 adapter (node:sqlite, every migration).
 */
import { afterAll, describe, expect, it } from "vitest";
import { ed, signBootSuspension, type BootSuspensionOrder } from "@flagship/protocol";
import { InMemoryStorage } from "../src/inMemory.js";
import { D1Storage } from "../src/d1.js";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import type { BoxSealedLeaseRecord, Storage } from "../src/types.js";

const handles: SqliteD1[] = [];
afterAll(() => handles.forEach((h) => h.close()));

const backends: Array<[string, () => Storage]> = [
  ["in-memory", () => new InMemoryStorage()],
  [
    "D1",
    () => {
      const h = createSqliteD1();
      handles.push(h);
      return new D1Storage(h as never);
    },
  ],
];

const D = "home.alice.flagship.services";
const T = 1_800_000_000_000;
const ownerKey = new Uint8Array(32).fill(7);
const boxKey = new Uint8Array(32).fill(11);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const lease = (id: string, over: Partial<BoxSealedLeaseRecord> = {}): BoxSealedLeaseRecord => ({
  serverDomain: D, leaseId: id, stkPubHex: "aa".repeat(32), sealedKeyHex: "bb".repeat(40),
  issuedAt: T, expiresAt: T + 3_600_000, maxUses: null, usesConsumed: 0, signatureHex: "cc".repeat(64), depositedAt: T, ...over,
});
const owner = (epoch: number, action: "suspend" | "resume", at = T): BootSuspensionOrder => ({
  serverDomain: D, epoch, seq: 0, action, reason: action === "suspend" ? "manual-lock" : "owner-resume", signer: "owner", issuedAt: at,
});
const box = (epoch: number, seq: number, at = T): BootSuspensionOrder => ({
  serverDomain: D, epoch, seq, action: "suspend", reason: "dead-man", signer: "box", issuedAt: at,
});
const sig = (o: BootSuspensionOrder) => hex(signBootSuspension(o, o.signer === "owner" ? ownerKey : boxKey));

describe.each(backends)("boot suspension — %s", (_name, make) => {
  it("an unknown server is not suspended and releases its lease", async () => {
    const s = make();
    expect(await s.bootSuspensions.get(D)).toBeUndefined();
    await s.boxSealedLeases.put(lease("L1"));
    expect((await s.boxSealedLeases.release(D, T + 1))?.leaseId).toBe("L1");
  });

  it("a suspended server releases nothing, and a deposit does not lift it", async () => {
    const s = make();
    await s.boxSealedLeases.put(lease("L1"));
    const a = await s.bootSuspensions.apply(owner(1, "suspend"), sig(owner(1, "suspend")), T);
    expect(a.ok && a.state.suspended).toBe(true);
    expect(await s.boxSealedLeases.release(D, T + 1)).toBeUndefined();
    await s.boxSealedLeases.put(lease("L2", { depositedAt: T + 5 }));
    expect(await s.boxSealedLeases.release(D, T + 6)).toBeUndefined();
    expect((await s.bootSuspensions.get(D))?.suspended).toBe(true);
  });

  it("only a newer owner epoch resumes, and the old lease is gone once revoked", async () => {
    const s = make();
    await s.boxSealedLeases.put(lease("L1"));
    await s.bootSuspensions.apply(owner(1, "suspend"), sig(owner(1, "suspend")), T);
    expect(await s.boxSealedLeases.revokeAll(D)).toBe(1);
    const r = await s.bootSuspensions.apply(owner(2, "resume", T + 1000), sig(owner(2, "resume", T + 1000)), T + 1000);
    expect(r.ok && !r.state.suspended).toBe(true);
    expect(await s.boxSealedLeases.release(D, T + 2000)).toBeUndefined();
    await s.boxSealedLeases.put(lease("L3", { depositedAt: T + 3000 }));
    expect((await s.boxSealedLeases.release(D, T + 3001))?.leaseId).toBe("L3");
  });

  it("the box can suspend but never resume, and the record keeps who set it", async () => {
    const s = make();
    await s.bootSuspensions.apply(owner(1, "resume"), sig(owner(1, "resume")), T);
    const down = await s.bootSuspensions.apply(box(1, 1, T + 20_000), sig(box(1, 1, T + 20_000)), T + 20_000);
    expect(down.ok && down.state.suspended && down.state.signer).toBe("box");
    const up = await s.bootSuspensions.apply({ ...box(1, 2, T + 40_000), action: "resume" }, "00", T + 40_000);
    expect(!up.ok && up.code).toBe("box-cannot-resume");
    const rec = await s.bootSuspensions.get(D);
    expect(rec).toMatchObject({ epoch: 1, seq: 1, suspended: true, signer: "box", reason: "dead-man" });
    expect(rec?.signatureHex).toBe(sig(box(1, 1, T + 20_000)));
  });

  it("two concurrent owner writes for the same epoch: exactly one wins", async () => {
    const s = make();
    const a = owner(1, "suspend");
    const b = { ...owner(1, "resume"), reason: "owner-resume" as const };
    const [x, y] = await Promise.all([s.bootSuspensions.apply(a, sig(a), T), s.bootSuspensions.apply(b, sig(b), T)]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect((await s.bootSuspensions.get(D))?.epoch).toBe(1);
  });

  it("revokeAll touches only that server", async () => {
    const s = make();
    await s.boxSealedLeases.put(lease("L1"));
    await s.boxSealedLeases.put(lease("L9", { serverDomain: "other.alice.flagship.services" }));
    expect(await s.boxSealedLeases.revokeAll(D)).toBe(1);
    expect((await s.boxSealedLeases.release("other.alice.flagship.services", T + 1))?.leaseId).toBe("L9");
  });
});

describe("D1: an unreadable suspension record fails closed", () => {
  it("returns no lease when the lookup throws", async () => {
    const h = createSqliteD1();
    handles.push(h);
    const s = new D1Storage(h as never);
    await s.boxSealedLeases.put(lease("L1"));
    const real = (h as never as { prepare: (q: string) => unknown }).prepare.bind(h);
    (h as never as { prepare: (q: string) => unknown }).prepare = (q: string) => {
      if (q.includes("boot_suspensions")) throw new Error("storage down");
      return real(q);
    };
    expect(await s.boxSealedLeases.release(D, T + 1)).toBeUndefined();
  });
});

void ed;
