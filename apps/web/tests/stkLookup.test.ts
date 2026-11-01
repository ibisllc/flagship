import { describe, expect, it } from "vitest";
import { comStkLookup } from "../src/tunnel/stkLookup.js";

const NAME = "home.alice.flagship.services";
const k1 = new Uint8Array(32).fill(1);
const k2 = new Uint8Array(32).fill(2);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

function rig() {
  let answer: { status: number; body: unknown } | "offline" = { status: 200, body: { identityPubKey: hexOf(k1), revoked: null } };
  let now = 1_000_000;
  const calls: string[] = [];
  const lookup = comStkLookup({
    comBaseUrl: "https://com.test/",
    now: () => now,
    fetchImpl: (async (url: string) => {
      calls.push(url);
      if (answer === "offline") throw new Error("offline");
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
  });
  return {
    lookup,
    calls,
    set: (a: typeof answer) => {
      answer = a;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("comStkLookup", () => {
  it("caches .com's key for a HELLO that presents it", async () => {
    const r = rig();
    expect(await r.lookup(NAME, k1)).toEqual(k1);
    expect(await r.lookup(NAME, k1)).toEqual(k1);
    expect(r.calls).toEqual([`https://com.test/api/server/by-domain/${NAME}`]);
    r.advance(5 * 60_000);
    await r.lookup(NAME, k1);
    expect(r.calls).toHaveLength(2);
  });

  it("a name registered again with a new key: the new key's HELLO is answered from a fresh read at once", async () => {
    const r = rig();
    expect(await r.lookup(NAME, k1)).toEqual(k1);
    r.set({ status: 200, body: { identityPubKey: hexOf(k2), revoked: null } });
    expect(await r.lookup(NAME, k2)).toEqual(k2);
    expect(r.calls).toHaveLength(2);
    // The fresh answer replaced the cached key: the old key gets the new one back, so its HELLO is refused.
    expect(await r.lookup(NAME, k1)).toEqual(k2);
    expect(await r.lookup(NAME, k2)).toEqual(k2);
    expect(r.calls).toHaveLength(3);
  });

  it("a definitive refusal drops the cached key; an outage refuses a key the cache does not vouch for", async () => {
    const r = rig();
    await r.lookup(NAME, k1);
    r.set({ status: 200, body: { identityPubKey: hexOf(k1), revoked: 123 } });
    expect(await r.lookup(NAME, k2)).toBeNull();
    r.set({ status: 404, body: { error: "not found" } });
    expect(await r.lookup(NAME, k1)).toBeNull();
    r.set("offline");
    expect(await r.lookup(NAME, k1)).toBeNull();
    r.set({ status: 200, body: { identityPubKey: hexOf(k1) } });
    expect(await r.lookup(NAME, k1)).toEqual(k1);
    r.set("offline");
    expect(await r.lookup(NAME, k1)).toEqual(k1);
    expect(await r.lookup(NAME, k2)).toBeNull();
  });

  it("asks the in-process registry first", async () => {
    const r = comStkLookup({ comBaseUrl: "https://com.test", local: (id) => (id === NAME ? k2 : null), fetchImpl: (async () => { throw new Error("no"); }) as typeof fetch });
    expect(await r(NAME, k1)).toEqual(k2);
  });
});
