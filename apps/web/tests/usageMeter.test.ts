import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_GRANT_BYTES, UsageMeter, accountFromCanonical } from "../src/tunnel/usageMeter.js";

const URL = "https://flagshipserver.com/api/usage/report";
const SECRET = "s3cret";

function meter(fetchImpl: typeof fetch, onFlush?: (i: { sent: number; ok: boolean }) => void) {
  return new UsageMeter({ reportUrl: URL, secret: SECRET, fetchImpl, onFlush });
}

function okResp(results: Array<{ username: string; admit: boolean }>): Response {
  return { ok: true, json: async () => ({ ok: true, results }) } as unknown as Response;
}

describe("accountFromCanonical", () => {
  it("extracts the <user> label from a pod canonical", () => {
    expect(accountFromCanonical("kitchen.john.flagship.services")).toBe("john");
    expect(accountFromCanonical("x.kitchen.john.flagship.services")).toBe("john");
    expect(accountFromCanonical("john.flagship.services")).toBe("john");
    expect(accountFromCanonical("KITCHEN.John.Flagship.Services")).toBe("john");
  });
  it("returns null for non-flagship.services names (un-attributable)", () => {
    expect(accountFromCanonical("example.com")).toBeNull();
    expect(accountFromCanonical("flagship.services")).toBeNull();
  });
});

describe("UsageMeter — accumulate + flush", () => {
  it("batches per-account deltas and POSTs them with the secret header", async () => {
    const fetchImpl = vi.fn(async () => okResp([])) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 100);
    m.add("alice", 50);
    m.add("bob", 10);
    m.add(null, 999); // un-attributable → ignored
    m.add("carol", 0); // zero → ignored
    await m.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(URL);
    expect((init.headers as Record<string, string>)["x-usage-secret"]).toBe(SECRET);
    const body = JSON.parse(init.body as string);
    expect(body.items).toEqual([
      { username: "alice", bytes: 150 },
      { username: "bob", bytes: 10 },
    ]);
  });

  it("a no-op flush (no deltas) makes no request", async () => {
    const fetchImpl = vi.fn(async () => okResp([])) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    await m.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("UsageMeter — the old .com verdict (admit only, no lease)", () => {
  it("admit:false slows the account; a later admit:true clears it", async () => {
    let answer = [
      { username: "alice", admit: false },
      { username: "bob", admit: true },
    ];
    const fetchImpl = vi.fn(async () => okResp(answer)) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    expect(m.admits("alice")).toBe(true); // default-admit before any verdict
    m.add("alice", 1);
    m.add("bob", 1);
    await m.flush();
    expect(m.admits("alice")).toBe(false); // over quota → slowed
    expect(m.admits("bob")).toBe(true);

    answer = [{ username: "alice", admit: true }];
    m.add("alice", 1);
    await m.flush();
    expect(m.admits("alice")).toBe(true);
  });

  it("an admitting old verdict sets no local limit", async () => {
    const m = meter(vi.fn(async () => okResp([{ username: "alice", admit: true }])) as unknown as typeof fetch);
    m.add("alice", 1);
    await m.flush();
    m.add("alice", 10 * 1024 ** 3);
    expect(m.admits("alice")).toBe(true);
  });

  it("un-attributable accounts always admit", () => {
    const m = meter(vi.fn(async () => okResp([])) as unknown as typeof fetch);
    expect(m.admits(null)).toBe(true);
  });
});

type Call = [string, RequestInit];
const bodies = (f: typeof fetch) =>
  (f as unknown as { mock: { calls: Call[] } }).mock.calls.map((c) => JSON.parse(c[1].body as string));

function leaseResp(leases: Record<string, { action: string; grantBytes: number; policy: string; ttlMs: number }>): Response {
  return okResp(
    Object.entries(leases).map(([username, lease]) => ({ username, admit: lease.action === "allow", lease })) as never,
  );
}

describe("UsageMeter — budget leases", () => {
  it("every report carries a 32-hex batch id", async () => {
    const fetchImpl = vi.fn(async () => okResp([])) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 1);
    await m.flush();
    m.add("alice", 1);
    await m.flush();
    const [a, b] = bodies(fetchImpl);
    expect(a.batchId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.batchId).not.toBe(a.batchId);
  });

  it("an account carries its grant at full speed, then is slowed until .com renews", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () =>
      leaseResp({ alice: { action: "allow", grantBytes: 1000, policy: "throttle", ttlMs: 60_000 } }),
    ) as unknown as typeof fetch;
    const m = new UsageMeter({ reportUrl: URL, secret: SECRET, fetchImpl, now: () => now });
    m.add("alice", 1);
    await m.flush();
    m.add("alice", 999);
    expect(m.admits("alice")).toBe(true);
    m.add("alice", 1);
    expect(m.admits("alice")).toBe(false);
    expect(m.throttleDelayMs("alice", 64_000)).toBeGreaterThan(0);
    await m.flush("due");
    expect(m.admits("alice")).toBe(true);
    expect(m.throttleDelayMs("alice", 64_000)).toBe(0);
  });

  it("a throttle lease slows the account at once", async () => {
    const fetchImpl = vi.fn(async () =>
      leaseResp({ alice: { action: "throttle", grantBytes: 0, policy: "throttle", ttlMs: 60_000 } }),
    ) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 1);
    await m.flush();
    expect(m.admits("alice")).toBe(false);
    expect(m.blockedCount()).toBe(1);
  });

  it("before any answer an account may carry 32 MiB", () => {
    const m = meter(vi.fn(async () => okResp([])) as unknown as typeof fetch);
    m.add("alice", INITIAL_GRANT_BYTES - 1);
    expect(m.admits("alice")).toBe(true);
    m.add("alice", 1);
    expect(m.admits("alice")).toBe(false);
  });
});

describe("UsageMeter — adaptive reporting", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("due accounts report within the due check; the rest wait for the slow pass", async () => {
    const fetchImpl = vi.fn(async () =>
      leaseResp({
        alice: { action: "allow", grantBytes: 1000, policy: "throttle", ttlMs: 600_000 },
        bob: { action: "allow", grantBytes: 1000, policy: "throttle", ttlMs: 600_000 },
      }),
    ) as unknown as typeof fetch;
    const m = new UsageMeter({ reportUrl: URL, secret: SECRET, fetchImpl, now: () => Date.now(), flushIntervalMs: 60_000 });
    m.start();
    m.add("alice", 1);
    m.add("bob", 1);
    await vi.advanceTimersByTimeAsync(500); // both new ⇒ due
    expect(bodies(fetchImpl).at(-1).items).toHaveLength(2);

    m.add("alice", 600); // past half its grant ⇒ due
    m.add("bob", 10);
    await vi.advanceTimersByTimeAsync(500);
    expect(bodies(fetchImpl).at(-1).items).toEqual([{ username: "alice", bytes: 600 }]);

    const before = bodies(fetchImpl).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bodies(fetchImpl)).toHaveLength(before); // bob waits
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bodies(fetchImpl).at(-1).items).toEqual([{ username: "bob", bytes: 10 }]);
    m.stop();
  });

  it("forgets idle accounts on the slow pass", async () => {
    const fetchImpl = vi.fn(async () =>
      leaseResp({ alice: { action: "allow", grantBytes: 1000, policy: "throttle", ttlMs: 1_000 } }),
    ) as unknown as typeof fetch;
    const m = new UsageMeter({
      reportUrl: URL,
      secret: SECRET,
      fetchImpl,
      now: () => Date.now(),
      flushIntervalMs: 60_000,
      leases: { forgetAfterMs: 10_000 },
    });
    m.start();
    m.add("alice", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(m.trackedCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.trackedCount()).toBe(0);
    m.stop();
  });
});

describe("UsageMeter — failures", () => {
  it("a failed report is retried with the same batch id; new usage goes in the next batch", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return okResp([]);
    }) as unknown as typeof fetch;
    const flushes: Array<{ sent: number; ok: boolean }> = [];
    const m = meter(fetchImpl, (i) => flushes.push(i));

    m.add("alice", 100);
    await m.flush();
    expect(flushes[0]).toEqual({ sent: 1, ok: false });

    m.add("alice", 5);
    await m.flush();
    const [first, retry, next] = bodies(fetchImpl);
    expect(retry).toEqual(first);
    expect(retry.items).toEqual([{ username: "alice", bytes: 100 }]);
    expect(next.batchId).not.toBe(first.batchId);
    expect(next.items).toEqual([{ username: "alice", bytes: 5 }]);
  });

  it("a 4xx refusal drops the batch; a 5xx keeps it for a retry", async () => {
    const statuses = [400, 503, 200];
    const fetchImpl = vi.fn(async () => {
      const status = statuses.shift()!;
      return { ok: status === 200, status, json: async () => ({ ok: true, results: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 1);
    await m.flush(); // 400: dropped
    m.add("alice", 2);
    await m.flush(); // 503: kept
    await m.flush(); // retried
    const b = bodies(fetchImpl);
    expect(b.map((x) => x.items[0].bytes)).toEqual([1, 2, 2]);
    expect(b[2].batchId).toBe(b[1].batchId);
  });

  it("flush never throws (fail-open keeps the data plane alive)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 1);
    await expect(m.flush()).resolves.toBeUndefined();
  });
});
