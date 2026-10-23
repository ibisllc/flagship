import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signAuthTime, type CaTrustChain } from "@flagship/protocol";
import { AuthClock, AuthTimeSource, FreshnessLeases, LocalCheckpoints, CURRENT_WITHIN_MS } from "../../src/authority/index.js";

const PIN_CHAIN = (keys: string[]) => ({ authorizedCaKeys: () => keys }) as unknown as CaTrustChain;
const priv = new Uint8Array(32).fill(7);
const ca = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
const caHex = Buffer.from(ca.publicKey).toString("hex");
const NONCE = "0123456789abcdef0123456789abcdef";

let mono = 1_000;
const clock = () => new AuthClock({ mono: () => mono });

function answering(nowMs: number, over: Record<string, unknown> = {}) {
  return (async () => ({ ok: true, status: 200, json: async () => ({ stamp: { ...signAuthTime(NONCE, nowMs, ca), ...over } }) })) as unknown as typeof fetch;
}

describe("AuthTimeSource", () => {
  const mk = (c: AuthClock, fetchImpl: typeof fetch, chain: CaTrustChain | null = PIN_CHAIN([caHex])) =>
    new AuthTimeSource({ controlPlaneBaseUrl: "https://flagshipserver.com", clock: c, chain: () => chain, mono: () => mono, fetchImpl, nonce: () => NONCE });

  it("anchors the clock to a verified answer and counts forward on the monotonic clock", async () => {
    mono = 1_000;
    const c = clock();
    const r = await mk(c, answering(5_000_000)).refresh();
    expect(r).toEqual({ ok: true, nowMs: 5_000_000 });
    mono += 2_500;
    expect(c.now()).toBe(5_002_500);
  });

  it("changes nothing for an unverifiable, wrong-nonce, replayed-old or unreachable answer", async () => {
    mono = 1_000;
    const c = clock();
    expect((await mk(c, answering(9, { signature: "00".repeat(64) })).refresh()).ok).toBe(false);
    expect((await mk(c, answering(9), null).refresh()).ok).toBe(false);
    const other = { ...signAuthTime("f".repeat(32), 9, ca) };
    expect((await mk(c, (async () => ({ ok: true, json: async () => ({ stamp: other }) })) as unknown as typeof fetch).refresh()).ok).toBe(false);
    expect((await mk(c, (async () => { throw new Error("offline"); }) as unknown as typeof fetch).refresh()).ok).toBe(false);
    expect(c.synced).toBe(false);
  });

  it("a stamp older than what the clock already knows cannot wind it back", async () => {
    mono = 1_000;
    const c = clock();
    await mk(c, answering(5_000_000)).refresh();
    await mk(c, answering(1_000)).refresh();
    expect(c.now()).toBe(5_000_000);
  });

  it("a slow answer is not trusted to place the stamp", async () => {
    mono = 1_000;
    const c = clock();
    const slow = (async () => { mono += 20_000; return { ok: true, json: async () => ({ stamp: signAuthTime(NONCE, 5, ca) }) }; }) as unknown as typeof fetch;
    expect(await mk(c, slow).refresh()).toEqual({ ok: false, reason: "slow-answer" });
    expect(c.synced).toBe(false);
  });
});

describe("LocalCheckpoints", () => {
  async function rig() {
    mono = 1_000;
    const dir = await mkdtemp(join(tmpdir(), "cp-"));
    const c = clock();
    c.observe(10_000_000);
    const leases = new FreshnessLeases(join(dir, "f.json"), c);
    await leases.load();
    let wall = 50_000_000;
    let answered: number | null = 50_000_000;
    let digest = "d1";
    let state = { shared: true, catchingUp: false, hasPeers: true, lastSyncAt: 50_000_000 as number | null };
    const cp = new LocalCheckpoints(leases, c, {
      apps: () => ["alice--chess"], digestOf: () => digest, state: () => state, revocationAnsweredAt: () => answered,
      authorityEpoch: () => 1, wallNow: () => wall,
    });
    return { c, leases, cp, set: { wall: (v: number) => (wall = v), answered: (v: number | null) => (answered = v), digest: (v: string) => (digest = v), state: (v: Partial<typeof state>) => (state = { ...state, ...v }) } };
  }

  it("a current list with trusted time authorizes guests, and the authorization lapses", async () => {
    const { leases, cp, c } = await rig();
    expect(leases.externalAccessAllowed("alice--chess", 0)).toBe(false);
    expect(await cp.renewAll()).toEqual(["alice--chess"]);
    expect(leases.externalAccessAllowed("alice--chess", 0)).toBe(true);
    mono += 11 * 60_000;
    expect(c.now()).toBeGreaterThan(0);
    expect(leases.externalAccessAllowed("alice--chess", 0)).toBe(false);
  });

  it("no trusted time, a late revocation poll, a late peer comparison or a catching-up app each refuse to renew", async () => {
    const r = await rig();
    r.set.answered(50_000_000 - CURRENT_WITHIN_MS - 1);
    expect(await r.cp.renewAll()).toEqual([]);
    r.set.answered(50_000_000);
    r.set.state({ lastSyncAt: 50_000_000 - CURRENT_WITHIN_MS - 1 });
    expect(await r.cp.renewAll()).toEqual([]);
    r.set.state({ lastSyncAt: 50_000_000, catchingUp: true });
    expect(await r.cp.renewAll()).toEqual([]);
    expect(r.leases.externalAccessAllowed("alice--chess", 0)).toBe(false);
    const unsynced = new LocalCheckpoints(r.leases, new AuthClock({ mono: () => mono }), {
      apps: () => ["alice--chess"], digestOf: () => "d", state: () => ({ shared: false, catchingUp: false, hasPeers: false, lastSyncAt: null }),
      revocationAnsweredAt: () => 50_000_000, authorityEpoch: () => 1, wallNow: () => 50_000_000,
    });
    expect(await unsynced.renewAll()).toEqual([]);
  });

  it("an app no other server runs needs no peer comparison", async () => {
    const r = await rig();
    r.set.state({ hasPeers: false, lastSyncAt: null });
    expect(await r.cp.renewAll()).toEqual(["alice--chess"]);
  });

  it("a changed list moves the revision forward and is still accepted", async () => {
    const r = await rig();
    await r.cp.renewAll();
    mono += 30_000;
    r.set.digest("d2");
    expect(await r.cp.renewAll()).toEqual(["alice--chess"]);
    expect(r.leases.status("alice--chess").policyRevision).toBeGreaterThan(10_000_000);
  });
});
