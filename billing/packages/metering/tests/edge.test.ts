import { describe, expect, it } from "vitest";
import { LeaseBook, type EdgeLease, type LeaseBookOptions } from "../src/index.js";

let ids = 0;
function book(o: Partial<LeaseBookOptions> = {}) {
  return new LeaseBook({ initialGrant: 100, unknownPolicy: "throttle", newBatchId: () => `batch-${++ids}`, ...o });
}
const allow = (grant: number, ttlMs = 60_000, policy: EdgeLease["policy"] = "throttle"): EdgeLease => ({
  action: "allow",
  grant,
  policy,
  ttlMs,
});
const throttle: EdgeLease = { action: "throttle", grant: 0, policy: "throttle", ttlMs: 10_000 };
const leases = (m: Record<string, EdgeLease>) => new Map(Object.entries(m));

describe("LeaseBook — an account without a lease", () => {
  it("is due at once and allowed up to initialGrant, then gets unknownPolicy", () => {
    const b = book();
    expect(b.action("ann")).toBe("allow");
    expect(b.use("ann", 60, 0)).toBe(true);
    expect(b.hasDue(0)).toBe(true);
    expect(b.action("ann")).toBe("allow");
    b.use("ann", 40, 0);
    expect(b.action("ann")).toBe("throttle");
  });

  it("an unknownPolicy of allow never restricts", () => {
    const b = book({ unknownPolicy: "allow" });
    b.use("ann", 1_000, 0);
    expect(b.action("ann")).toBe("allow");
  });
});

describe("LeaseBook — leases", () => {
  it("enforces a grant relative to the batch it answered", () => {
    const b = book();
    b.use("ann", 50, 0);
    const batch = b.takeBatch(0, "due")!;
    expect(batch.items).toEqual([{ account: "ann", amount: 50 }]);
    b.use("ann", 30, 1); // used while the report was in flight
    b.settle(batch, leases({ ann: allow(100) }), 2);
    expect(b.action("ann")).toBe("allow");
    b.use("ann", 69, 3); // 30 + 69 = 99 of 100
    expect(b.action("ann")).toBe("allow");
    b.use("ann", 1, 3);
    expect(b.action("ann")).toBe("throttle");
  });

  it("a spent grant on an allow-policy plan never restricts", () => {
    const b = book();
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "due")!, leases({ ann: allow(10, 60_000, "allow") }), 0);
    b.use("ann", 1_000, 1);
    expect(b.action("ann")).toBe("allow");
  });

  it("a throttle lease restricts at once and keeps restricting after it lapses", () => {
    const b = book();
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "due")!, leases({ ann: throttle }), 0);
    expect(b.action("ann")).toBe("throttle");
    expect(b.restrictedCount()).toBe(1);
    expect(b.use("ann", 1, 20_000)).toBe(true); // lapsed + active ⇒ due for a recheck
    expect(b.action("ann")).toBe("throttle");
    b.settle(b.takeBatch(20_000, "due")!, leases({ ann: allow(100) }), 20_000);
    expect(b.action("ann")).toBe("allow");
    expect(b.restrictedCount()).toBe(0);
  });

  it("accounts missing from the answer keep their lease", () => {
    const b = book();
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "due")!, leases({ ann: throttle }), 0);
    b.use("ann", 1, 1);
    b.settle(b.takeBatch(1, "all")!, leases({}), 1);
    expect(b.action("ann")).toBe("throttle");
  });
});

describe("LeaseBook — adaptive reporting", () => {
  it("an account is due once it has spent renewAt of its grant, or its lease lapsed", () => {
    const b = book();
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "due")!, leases({ ann: allow(100, 1_000) }), 0);
    expect(b.use("ann", 49, 1)).toBe(false);
    expect(b.hasDue(1)).toBe(false);
    expect(b.use("ann", 1, 1)).toBe(true);
    const due = b.takeBatch(1, "due")!;
    expect(due.items).toEqual([{ account: "ann", amount: 50 }]);
    b.settle(due, leases({ ann: allow(100, 1_000) }), 1);
    expect(b.use("ann", 1, 500)).toBe(false);
    expect(b.use("ann", 1, 1_002)).toBe(true);
  });

  it("'due' takes only due accounts; 'all' takes everyone with usage", () => {
    const b = book();
    for (const a of ["ann", "bo"]) b.use(a, 1, 0);
    b.settle(b.takeBatch(0, "all")!, leases({ ann: allow(100), bo: allow(100) }), 0);
    b.use("ann", 60, 1);
    b.use("bo", 10, 1);
    const due = b.takeBatch(1, "due")!;
    expect(due.items.map((i) => i.account)).toEqual(["ann"]);
    b.settle(due, leases({ ann: allow(100) }), 1);
    expect(b.takeBatch(1, "due")).toBeUndefined();
    expect(b.takeBatch(1, "all")!.items).toEqual([{ account: "bo", amount: 10 }]);
  });

  it("caps a batch at maxItems and marks the overflow due", () => {
    const b = book({ maxItems: 2 });
    for (const a of ["a", "b", "c"]) b.use(a, 1, 0);
    const first = b.takeBatch(0, "all")!;
    expect(first.items).toHaveLength(2);
    b.settle(first, leases({}), 0);
    expect(b.hasDue(0)).toBe(true);
    expect(b.takeBatch(0, "due")!.items).toEqual([{ account: "c", amount: 1 }]);
  });

  it("one batch in flight at a time; nothing to send means no batch", () => {
    const b = book();
    expect(b.takeBatch(0, "all")).toBeUndefined();
    b.use("ann", 1, 0);
    const batch = b.takeBatch(0, "all")!;
    b.use("bo", 1, 0);
    expect(b.takeBatch(0, "all")).toBeUndefined();
    expect(b.hasDue(0)).toBe(false);
    b.settle(batch, leases({}), 0);
    expect(b.takeBatch(0, "all")!.items).toEqual([{ account: "bo", amount: 1 }]);
  });
});

describe("LeaseBook — failures", () => {
  it("retries a failed batch with the same id and contents, after a backoff", () => {
    const b = book();
    b.use("ann", 10, 0);
    const batch = b.takeBatch(0, "all")!;
    b.failed(batch, 0, true);
    b.use("ann", 5, 1);
    expect(b.hasDue(500)).toBe(false);
    expect(b.hasDue(1_000)).toBe(true);
    const retry = b.takeBatch(1_000, "all")!;
    expect(retry.id).toBe(batch.id);
    expect(retry.items).toEqual([{ account: "ann", amount: 10 }]);
    expect(retry.attempts).toBe(2);
    b.settle(retry, leases({ ann: allow(100) }), 1_000);
    const next = b.takeBatch(1_000, "all")!;
    expect(next.id).not.toBe(batch.id);
    expect(next.items).toEqual([{ account: "ann", amount: 5 }]);
  });

  it("drops a batch central refused, and one still failing after retryForMs", () => {
    const b = book({ retryForMs: 5_000 });
    b.use("ann", 10, 0);
    b.failed(b.takeBatch(0, "all")!, 0, false);
    expect(b.droppedBatches).toBe(1);
    b.use("ann", 1, 1);
    b.failed(b.takeBatch(1, "all")!, 1, true);
    b.use("ann", 2, 2);
    const after = b.takeBatch(6_000, "all")!;
    expect(after.items).toEqual([{ account: "ann", amount: 2 }]);
    expect(b.droppedBatches).toBe(2);
  });

  it("fails open while central is unreachable, but keeps explicit throttles", () => {
    const b = book();
    for (const a of ["ann", "bo"]) b.use(a, 1, 0);
    b.settle(b.takeBatch(0, "all")!, leases({ ann: allow(10), bo: throttle }), 0);
    b.use("ann", 20, 1);
    expect(b.action("ann")).toBe("throttle");
    b.failed(b.takeBatch(1, "all")!, 1, true);
    expect(b.centralUnreachable).toBe(true);
    expect(b.action("ann")).toBe("allow");
    expect(b.action("bo")).toBe("throttle");
    b.use("carl", 1_000, 2);
    expect(b.action("carl")).toBe("allow");
  });

  it("failOpen: false keeps enforcing a spent grant during an outage", () => {
    const b = book({ failOpen: false });
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "all")!, leases({ ann: allow(10) }), 0);
    b.use("ann", 20, 1);
    b.failed(b.takeBatch(1, "all")!, 1, true);
    expect(b.action("ann")).toBe("throttle");
  });
});

describe("LeaseBook — memory", () => {
  it("forgets idle accounts forgetAfterMs after their lease lapsed", () => {
    const b = book({ forgetAfterMs: 1_000 });
    b.use("ann", 1, 0);
    b.settle(b.takeBatch(0, "all")!, leases({ ann: allow(100, 500) }), 0);
    b.prune(1_000);
    expect(b.size()).toBe(1);
    b.prune(1_500);
    expect(b.size()).toBe(0);
  });

  it("never forgets an account with unreported usage", () => {
    const b = book({ forgetAfterMs: 1 });
    b.use("ann", 1, 0);
    b.prune(10_000);
    expect(b.size()).toBe(1);
  });

  it("makes 32-hex-digit batch ids by default", () => {
    const b = new LeaseBook({ initialGrant: 1, unknownPolicy: "throttle" });
    b.use("ann", 1, 0);
    expect(b.takeBatch(0, "all")!.id).toMatch(/^[0-9a-f]{32}$/);
  });
});
