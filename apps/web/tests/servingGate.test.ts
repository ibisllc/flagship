import { describe, expect, it } from "vitest";
import { applyRevocationEntries } from "@flagship/protocol";
import {
  parseComServingRecord,
  ServingGate,
  type ComServingRecord,
  type ServingHello,
  type ServingTunnelHandle,
} from "../src/tunnel/servingGate.js";
import { comRecord, edKey, lease, policy, revocation } from "./support/serving.js";

const ACCOUNT = "alice";

/** A gate on a hand-driven clock and timer queue. */
function rig(fetch: (u: string, b: string) => Promise<ComServingRecord | null>) {
  let now = 10_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const gate = new ServingGate({
    fetchRecord: fetch,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > now) break;
      timers.shift();
      t.fn();
    }
  };
  return { gate, advance, now: () => now };
}

function handle() {
  const calls = { closed: [] as string[], appStreamsClosed: 0, apps: [] as boolean[] };
  const h: ServingTunnelHandle = {
    closeTunnel: (_code, reason) => calls.closed.push(reason),
    closeAppStreams: () => {
      calls.appStreamsClosed += 1;
    },
    onAppsChanged: (apps) => calls.apps.push(apps),
  };
  return { h, calls };
}

function hello(box: string, adminKey: string | null, extra: Partial<ServingHello> = {}): ServingHello {
  return { username: ACCOUNT, boxPub: box, podCanonical: "home.alice.flagship.services", adminKey, policy: null, ...extra };
}

describe("ServingGate", () => {
  it("a box nobody set a limit on serves its apps indefinitely", async () => {
    const admin = edKey();
    const box = edKey().pub;
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await gate.attach(hello(box, admin.pub), handle().h);
    expect(b.decision).toEqual({ control: true, apps: true, until: null });
  });

  it("a box that sends no servingAdminKey keeps its control name but serves no app", async () => {
    const admin = edKey();
    const box = edKey().pub;
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await gate.attach(hello(box, null), handle().h);
    expect(b.view()).toEqual({ control: true, apps: false });
    expect(b.decision).toMatchObject({ reason: "admin-keys-differ" });
  });

  it("refuses a box whose pinned admin key differs from .com's", async () => {
    const admin = edKey();
    const other = edKey();
    const box = edKey().pub;
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub }));
    const b = await gate.attach(hello(box, other.pub), handle().h);
    expect(b.view()).toEqual({ control: false, apps: false });
    expect(gate.stats().refusedTunnels).toBe(1);
  });

  it("app routes stop at the lease's end while the control name stays, and come back on a new lease", async () => {
    const admin = edKey();
    const box = edKey().pub;
    const p = policy({ account: ACCOUNT, box, admin });
    let rec: ComServingRecord;
    const { gate, advance, now } = rig(async () => rec);
    rec = comRecord({ adminKey: admin.pub, policy: p, leases: [lease(p, admin, now(), now() + 60_000)] });
    const { h, calls } = handle();
    const b = await gate.attach(hello(box, admin.pub), h);
    expect(b.decision).toEqual({ control: true, apps: true, until: now() + 60_000 });

    advance(59_999);
    expect(b.view().apps).toBe(true);
    advance(1);
    expect(b.view()).toEqual({ control: true, apps: false });
    expect(b.decision).toMatchObject({ reason: "lease-expired" });
    expect(calls.appStreamsClosed).toBe(1);
    expect(calls.apps).toEqual([false]);
    expect(calls.closed).toEqual([]);

    rec = comRecord({ adminKey: admin.pub, policy: p, leases: [lease(p, admin, now(), now() + 3_600_000)] });
    await gate.changed(ACCOUNT, box);
    expect(b.view()).toEqual({ control: true, apps: true });
    expect(calls.apps).toEqual([false, true]);
  });

  it("the box's own stricter policy counts even if .com's copy is older", async () => {
    const admin = edKey();
    const box = edKey().pub;
    const older = policy({ account: ACCOUNT, box, admin, grace: "indefinite", policyGen: 1 });
    const newer = policy({ account: ACCOUNT, box, admin, grace: "7d", policyGen: 2 });
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub, policy: older }));
    const b = await gate.attach(hello(box, admin.pub, { policy: newer }), handle().h);
    expect(b.decision).toMatchObject({ apps: false, reason: "no-lease" });
  });

  it("a revocation of the box ends its tunnel at once", async () => {
    const admin = edKey();
    const rk = edKey();
    const box = edKey().pub;
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub }));
    const { h, calls } = handle();
    const b = await gate.attach(hello(box, admin.pub), h);
    const r = applyRevocationEntries(gate.revocations, [revocation(1, ACCOUNT, box, rk)], rk.pub);
    if (!r.ok) throw new Error(r.reason);
    gate.adoptRevocations(r.state);
    expect(b.view().control).toBe(false);
    expect(calls.closed).toEqual(["revoked"]);
    expect(gate.stats().revoked).toBe(1);
  });

  it("a revoked box is refused again when it reconnects, even without an admin key in its HELLO", async () => {
    const admin = edKey();
    const rk = edKey();
    const box = edKey().pub;
    const { gate } = rig(async () => comRecord({ adminKey: admin.pub }));
    const r = applyRevocationEntries(gate.revocations, [revocation(1, ACCOUNT, box, rk)], rk.pub);
    if (!r.ok) throw new Error(r.reason);
    gate.adoptRevocations(r.state);
    expect((await gate.attach(hello(box, admin.pub), handle().h)).view().control).toBe(false);
    expect((await gate.attach(hello(box, null), handle().h)).view().control).toBe(false);
  });

  it("refuses new tunnels after 60 s without contact and closes every tunnel after 10 min", async () => {
    const admin = edKey();
    const box = edKey().pub;
    const { gate, advance } = rig(async () => comRecord({ adminKey: admin.pub }));
    const { h, calls } = handle();
    await gate.attach(hello(box, admin.pub), h);
    advance(59_999);
    expect(gate.acceptingNewTunnels()).toBe(true);
    advance(1);
    expect(gate.acceptingNewTunnels()).toBe(false);
    expect(gate.contact()).toBe("refuse-new");
    gate.tick();
    expect(calls.closed).toEqual([]);
    advance(10 * 60_000 - 60_000);
    gate.tick();
    gate.tick();
    expect(calls.closed).toEqual(["serving-feed-lost"]);
    gate.noteContact();
    expect(gate.acceptingNewTunnels()).toBe(true);
  });

  it("a record .com cannot give keeps apps off and is asked for again", async () => {
    const admin = edKey();
    const box = edKey().pub;
    let up = false;
    const { gate, advance } = rig(async () => (up ? comRecord({ adminKey: admin.pub }) : null));
    const { h, calls } = handle();
    const b = await gate.attach(hello(box, admin.pub), h);
    expect(b.view()).toEqual({ control: true, apps: false });
    up = true;
    advance(30_000);
    await new Promise((r) => setImmediate(r));
    expect(b.view()).toEqual({ control: true, apps: true });
    expect(calls.apps).toEqual([true]);
  });
});

describe("parseComServingRecord", () => {
  it("joins delegated leases with their delegation and rejects a record without regGen", () => {
    const d = { record: { renewalPub: "02" + "a".repeat(64) }, signature: "s" };
    const r = parseComServingRecord({
      adminKey: "b".repeat(64),
      regGen: 2,
      policy: null,
      leases: [{ lease: { leaseId: "x" }, signature: "s1", delegationPub: "02" + "a".repeat(64) }, { record: { leaseId: "y" }, signature: "s2" }],
      delegations: [d],
    });
    expect(r?.regGen).toBe(2);
    expect(r?.leases[0]?.delegation).toEqual(d);
    // No hint: offered under the admin key and under each delegation.
    expect(r?.leases).toHaveLength(3);
    expect(parseComServingRecord({ adminKey: "b".repeat(64) })).toBeNull();
  });
});
