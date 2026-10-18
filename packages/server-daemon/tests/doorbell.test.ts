/**
 * The box side of the `.com` doorbell: a poll the fresh doorbell says is empty
 * is answered on the box, anything else goes to `.com`, and the doorbell can
 * delay an order by at most its safety interval and never hide one.
 */
import { describe, expect, it, vi } from "vitest";
import { Doorbell } from "../src/doorbell.js";

const HOST = "home.alice.flagship.services";
const BASE = "https://flagshipserver.com";
const stamps = { aliases: "a1", rotations: "r1" };
const ring = (lanes: string[] = [], over: Partial<typeof stamps> = {}) => ({ v: 1, lanes, stamps: { ...stamps, ...over } });

function setup(opts: { safetyMs?: number; freshMs?: number } = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  let aliasBody = JSON.stringify({ aliases: [{ serviceId: "blog" }] });
  const real = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/apps/aliases")) return new Response(aliasBody, { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/update")) return new Response(JSON.stringify({ sealed: "ab" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const bell = new Doorbell({ serverDomain: HOST, username: "alice", fetchImpl: real, now: () => t, ...opts });
  return {
    bell,
    real,
    calls,
    advance: (ms: number) => void (t += ms),
    setAliases: (b: string) => void (aliasBody = b),
  };
}

const lane = (tail: string) => `${BASE}/api/server/${HOST}/${tail}`;

describe("lanes", () => {
  it("passes everything through until a doorbell has been heard", async () => {
    const { bell, real } = setup();
    expect((await bell.fetch(lane("update"))).status).toBe(200);
    expect(real).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a lane the fresh doorbell leaves out, without leaving the box", async () => {
    const { bell, calls } = setup();
    bell.update(ring([]));
    const tails = ["swk-deposit", "cgk-deposit", "pairing-deposit", "entitlement-deposit", "update", "transfer/rehome", "migration-assignment", "decommission"];
    // The first poll of each lane really goes out (a fresh box asks once).
    for (const tail of tails) await bell.fetch(lane(tail), { method: "GET" });
    expect(calls).toHaveLength(tails.length);
    for (const tail of tails) {
      const r = await bell.fetch(lane(tail), { method: "GET" });
      expect(r.status, tail).toBe(404);
      expect(r.headers.get("x-flagship-doorbell")).toBe("skipped");
    }
    expect(calls).toHaveLength(tails.length); // nothing more left the box
    expect(bell.skippedTotal).toBe(tails.length);
  });

  it("lets a lane that is ringing through, query strings and all", async () => {
    const { bell, calls } = setup();
    bell.update(ring(["update"]));
    expect((await bell.fetch(lane("update"), { method: "GET" })).status).toBe(200);
    expect(calls).toEqual(["GET /api/server/home.alice.flagship.services/update"]);
    bell.update(ring(["self-delete"]));
    await bell.fetch(`${lane("self-delete")}?stk=${"11".repeat(32)}`, { method: "GET" });
    expect(calls.at(-1)).toContain("/self-delete");
  });

  it("goes to .com anyway once per safety interval, and at the first poll of a lane", async () => {
    const { bell, calls, advance } = setup({ safetyMs: 60 * 60_000 });
    bell.update(ring([]));
    await bell.fetch(lane("update"), { method: "GET" }); // first: really sent
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      advance(5 * 60_000);
      bell.update(ring([])); // heartbeats keep the doorbell fresh
      await bell.fetch(lane("update"), { method: "GET" });
    }
    // 50 minutes later: still only the first went out
    expect(calls).toHaveLength(1);
    advance(10 * 60_000);
    bell.update(ring([]));
    await bell.fetch(lane("update"), { method: "GET" });
    expect(calls).toHaveLength(2);
  });

  it("ignores a stale doorbell: after two lost beats every poll goes out", async () => {
    const { bell, calls, advance } = setup({ freshMs: 12 * 60_000 });
    bell.update(ring([]));
    await bell.fetch(lane("update"), { method: "GET" });
    await bell.fetch(lane("update"), { method: "GET" });
    expect(calls).toHaveLength(1);
    advance(13 * 60_000);
    await bell.fetch(lane("update"), { method: "GET" });
    await bell.fetch(lane("update"), { method: "GET" });
    expect(calls).toHaveLength(3);
  });

  it("leaves another box's lane, writes and unknown URLs alone", async () => {
    const { bell, calls } = setup();
    bell.update(ring([]));
    await bell.fetch(`${BASE}/api/server/other.alice.flagship.services/update`, { method: "GET" });
    await bell.fetch(lane("update"), { method: "POST", body: "{}" });
    await bell.fetch(`${BASE}/api/accounts/alice/read-token`, { method: "POST" });
    await bell.fetch(`${BASE}/api/server/${HOST}/unlock-key/leases-v2`, { method: "GET" });
    expect(calls).toHaveLength(4);
  });

  it("can be switched off", async () => {
    const { bell, calls } = setup();
    const off = new Doorbell({ serverDomain: HOST, username: "alice", fetchImpl: (async () => { calls.push("x"); return new Response("{}", { status: 404 }); }) as typeof fetch, disabled: true });
    off.update(ring([]));
    await off.fetch(lane("update"), { method: "GET" });
    await off.fetch(lane("update"), { method: "GET" });
    expect(calls).toEqual(["x", "x"]);
    void bell;
  });

  it("rings the consumer the moment a lane starts holding something, and not again while it stays", () => {
    const { bell } = setup();
    const rang: string[] = [];
    bell.onRing("update", () => rang.push("update"));
    bell.update(ring([]));
    bell.update(ring(["update"]));
    bell.update(ring(["update"]));
    expect(rang).toEqual(["update"]);
    bell.update(ring([]));
    bell.update(ring(["update"]));
    expect(rang).toEqual(["update", "update"]);
  });

  it("refuses a malformed doorbell and keeps the old one", async () => {
    const { bell, calls } = setup();
    bell.update(ring(["update"]));
    bell.update({ v: 2, lanes: [], stamps });
    bell.update({ v: 1, lanes: [1], stamps });
    bell.update(null);
    await bell.fetch(lane("update"), { method: "GET" });
    expect(calls).toHaveLength(1); // still ringing: sent
  });
});

describe("lists", () => {
  const aliases = `${BASE}/api/users/alice/apps/aliases`;

  it("replays the last answer while the list's digest is unchanged, and refetches when it moves", async () => {
    const { bell, calls, setAliases } = setup();
    bell.update(ring());
    const first = await bell.fetch(aliases, { headers: { authorization: "Bearer t" } });
    expect(await first.json()).toEqual({ aliases: [{ serviceId: "blog" }] });
    expect(calls).toHaveLength(1);

    const second = await bell.fetch(aliases);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ aliases: [{ serviceId: "blog" }] });
    expect(second.headers.get("x-flagship-doorbell")).toBe("replayed");
    expect(calls).toHaveLength(1);

    setAliases(JSON.stringify({ aliases: [{ serviceId: "blog" }, { serviceId: "wiki" }] }));
    bell.update(ring([], { aliases: "a2" }));
    const third = await bell.fetch(aliases);
    expect(await third.json()).toEqual({ aliases: [{ serviceId: "blog" }, { serviceId: "wiki" }] });
    expect(calls).toHaveLength(2);
    // and now that digest is what is held
    expect((await bell.fetch(aliases)).headers.get("x-flagship-doorbell")).toBe("replayed");
    expect(calls).toHaveLength(2);
  });

  it("rings the alias consumer when its digest changes", () => {
    const { bell } = setup();
    const rang: string[] = [];
    bell.onRing("aliases", () => rang.push("a"));
    bell.update(ring());
    bell.update(ring());
    bell.update(ring([], { aliases: "a2" }));
    expect(rang).toEqual(["a"]);
  });

  it("does not replay a failed answer, and refetches at least once an hour", async () => {
    const { bell, calls, advance } = setup({ safetyMs: 60 * 60_000 });
    bell.update(ring());
    await bell.fetch(aliases);
    for (let i = 0; i < 5; i++) {
      advance(10 * 60_000);
      bell.update(ring());
      await bell.fetch(aliases);
    }
    expect(calls).toHaveLength(1);
    advance(10 * 60_000);
    bell.update(ring());
    await bell.fetch(aliases);
    expect(calls).toHaveLength(2);
  });

  it("without a fresh doorbell always asks", async () => {
    const { bell, calls } = setup();
    await bell.fetch(aliases);
    await bell.fetch(aliases);
    expect(calls).toHaveLength(2);
  });
});
