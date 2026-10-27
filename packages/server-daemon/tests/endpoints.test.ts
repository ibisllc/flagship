import { describe, expect, it } from "vitest";
import { AddressPool, EndpointTable, type EndpointKey } from "../src/endpoints.js";

const key: EndpointKey = { serviceId: "svc-a", env: "live", component: "main", role: "http" };
const ep = (incarnation: string, generation = 1) => ({ host: "10.89.1.5", port: 8080, generation, incarnation });
const sock = () => {
  const s = { destroyed: false, destroy() { s.destroyed = true; } };
  return s;
};

describe("EndpointTable", () => {
  it("answers nothing for a service it does not know (fail closed)", () => {
    const t = new EndpointTable();
    expect(t.lookup(key)).toBeNull();
    expect(t.acquire(key)).toBeNull();
  });

  it("keeps live and staging copies of one app apart", () => {
    const t = new EndpointTable();
    t.publish(key, ep("a"));
    expect(t.lookup({ ...key, env: "staging" })).toBeNull();
    expect(t.lookup({ ...key, component: "worker" })).toBeNull();
  });

  it("destroys every bound connection and pending dial on invalidation", () => {
    const t = new EndpointTable();
    t.publish(key, ep("a"));
    const lease = t.acquire(key)!;
    const ws = sock();
    const pending = sock();
    lease.bind(ws);
    const lease2 = t.acquire(key)!; // a dial that has not connected yet
    lease2.bind(pending);
    t.invalidate("svc-a");
    expect(ws.destroyed).toBe(true);
    expect(pending.destroyed).toBe(true);
    expect(lease.current()).toBe(false);
    expect(t.lookup(key)).toBeNull();
    expect(t.openLeases("svc-a")).toBe(0);
  });

  it("destroys a socket bound after the invalidation (the dial that raced)", () => {
    const t = new EndpointTable();
    t.publish(key, ep("a"));
    const lease = t.acquire(key)!;
    t.invalidate("svc-a");
    const late = sock();
    lease.bind(late);
    expect(late.destroyed).toBe(true);
  });

  it("refuses new connections from the start of a stop until the next publish", () => {
    const t = new EndpointTable();
    t.publish(key, ep("a"));
    t.beginStop("svc-a");
    expect(t.acquire(key)).toBeNull();
    t.publish(key, ep("b", 2));
    expect(t.acquire(key)?.endpoint.incarnation).toBe("b");
  });

  it("a lease is not current once the incarnation changed, even if the service is back", () => {
    const t = new EndpointTable();
    t.publish(key, ep("a"));
    const lease = t.acquire(key)!;
    t.publish(key, ep("b"));
    expect(lease.current()).toBe(false);
  });

  it("a restart of the same generation has a different incarnation", () => {
    const t = new EndpointTable();
    t.publish(key, ep("c1:t1", 3));
    const lease = t.acquire(key)!;
    t.invalidate("svc-a");
    t.publish(key, ep("c1:t2", 3));
    expect(lease.current()).toBe(false);
    expect(t.acquire(key)!.current()).toBe(true);
  });

  it("invalidating one service leaves another alone", () => {
    const t = new EndpointTable();
    const other = { ...key, serviceId: "svc-b" };
    t.publish(key, ep("a"));
    t.publish(other, ep("z"));
    const l = t.acquire(other)!;
    t.invalidate("svc-a");
    expect(l.current()).toBe(true);
  });
});

describe("AddressPool", () => {
  it("gives an owner the same address every time and skips .1, the network and broadcast", () => {
    const p = new AddressPool("10.89.1.0/24");
    const a = p.assign("a");
    expect(a).toBe("10.89.1.2");
    expect(p.assign("a")).toBe(a);
    expect(p.assign("b")).toBe("10.89.1.3");
  });

  it("never hands a released address to another owner during the quarantine", () => {
    let now = 0;
    const p = new AddressPool("10.89.1.0/24", { quarantineMs: 1000, now: () => now });
    const a = p.assign("a");
    p.release("a");
    expect(p.assign("b")).not.toBe(a);
    now = 1001;
    const c = p.assign("c");
    expect(c).toBe(a);
  });

  it("skips reserved addresses and reports when full", () => {
    const p = new AddressPool("10.89.1.0/29", { reserved: ["10.89.1.2"] });
    expect(p.assign("a")).toBe("10.89.1.3");
    for (const o of ["b", "c", "d"]) p.assign(o);
    expect(() => p.assign("z")).toThrow(/no free address/);
  });

  it("refuses a subnet that is too small or too large", () => {
    expect(() => new AddressPool("10.0.0.0/30")).toThrow();
    expect(() => new AddressPool("10.0.0.0/8")).toThrow();
  });
});

import { EndpointReconciler, type ContainerObservation, type ExpectedContainer } from "../src/endpoints.js";

describe("EndpointReconciler follows the engine", () => {
  const want: ExpectedContainer = { serviceId: "svc-a", container: "flagship-svc-a", network: "flagship-apps", address: "10.89.1.5", port: 8080, generation: 4 };
  const obs = (over: Partial<ContainerObservation> = {}): ContainerObservation => ({
    containerId: "c1",
    generation: 4,
    serviceLabel: "svc-a",
    running: true,
    startedAt: "t1",
    addresses: { "flagship-apps": "10.89.1.5" },
    ...over,
  });

  it("publishes a running container, invalidates a stopped one, and gives an engine restart a new incarnation", async () => {
    const t = new EndpointTable();
    let current: ContainerObservation | null = obs();
    const r = new EndpointReconciler(t, async () => current);
    r.watch(key, want);
    await r.tick();
    const first = t.acquire(key)!;
    expect(first.endpoint.incarnation).toBe("c1:t1");

    current = obs({ startedAt: "t2" }); // the engine restarted the same container
    const sock1 = sock();
    first.bind(sock1);
    await r.tick();
    expect(sock1.destroyed).toBe(true);
    expect(t.acquire(key)!.endpoint.incarnation).toBe("c1:t2");

    current = obs({ running: false });
    await r.tick();
    expect(t.lookup(key)).toBeNull();

    current = null;
    await r.tick();
    expect(t.lookup(key)).toBeNull();
  });

  it("does not trust a container that moved address or was relabelled", async () => {
    const t = new EndpointTable();
    let current = obs();
    const r = new EndpointReconciler(t, async () => current);
    r.watch(key, want);
    await r.tick();
    current = obs({ addresses: { "flagship-apps": "10.89.1.9" } });
    await r.tick();
    expect(t.lookup(key)).toBeNull();
    current = obs({ generation: 5 });
    await r.tick();
    expect(t.lookup(key)).toBeNull();
  });
});
