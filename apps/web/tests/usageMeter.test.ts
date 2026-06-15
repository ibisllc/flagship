import { describe, expect, it, vi } from "vitest";
import { UsageMeter, accountFromCanonical } from "../src/tunnel/usageMeter.js";

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

describe("UsageMeter — blocklist from the .com verdict", () => {
  it("admit:false blocks the account; admit:true clears it", async () => {
    const fetchImpl = vi.fn(async () => okResp([
      { username: "alice", admit: false },
      { username: "bob", admit: true },
    ])) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    expect(m.admits("alice")).toBe(true); // default-admit before any verdict
    m.add("alice", 1);
    m.add("bob", 1);
    await m.flush();
    expect(m.admits("alice")).toBe(false); // over quota → blocked
    expect(m.admits("bob")).toBe(true);

    // A later flush where alice is back under quota clears the block.
    const fetch2 = vi.fn(async () => okResp([{ username: "alice", admit: true }])) as unknown as typeof fetch;
    const m2 = new UsageMeter({ reportUrl: URL, secret: SECRET, fetchImpl: fetch2 });
    // seed the block then clear
    (m2 as unknown as { blocked: Set<string> }).blocked.add("alice");
    m2.add("alice", 1);
    await m2.flush();
    expect(m2.admits("alice")).toBe(true);
  });

  it("un-attributable accounts always admit", () => {
    const m = meter(vi.fn(async () => okResp([])) as unknown as typeof fetch);
    expect(m.admits(null)).toBe(true);
  });
});

describe("UsageMeter — approximate-by-design failure handling", () => {
  it("reset-before-flush: a failed flush DROPS the deltas (under-count, never double-count)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return okResp([]);
    }) as unknown as typeof fetch;
    const flushes: Array<{ sent: number; ok: boolean }> = [];
    const m = meter(fetchImpl, (i) => flushes.push(i));

    m.add("alice", 100);
    await m.flush(); // throws internally → fail-open, deltas dropped
    expect(flushes[0]).toEqual({ sent: 1, ok: false });

    // The dropped 100 bytes are NOT re-sent on the next flush (no double-count).
    m.add("alice", 5);
    await m.flush();
    const body = JSON.parse(
      (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]![1].body as string,
    );
    expect(body.items).toEqual([{ username: "alice", bytes: 5 }]);
  });

  it("flush never throws (fail-open keeps the data plane alive)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const m = meter(fetchImpl);
    m.add("alice", 1);
    await expect(m.flush()).resolves.toBeUndefined();
  });
});
