import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { AccountGoneGate, accountOfPath } from "../src/accountGone.js";
import { BoxReadToken } from "../src/boxReadToken.js";
import { Doorbell } from "../src/doorbell.js";

const seed = new Uint8Array(32).fill(9);
const GONE = () => new Response(JSON.stringify({ error: "account-not-found", code: "account-not-found" }), { status: 404 });
const BASE = "https://flagshipserver.com";

function world() {
  let now = 1_900_000_000_000;
  const gate = new AccountGoneGate(() => now);
  const calls: string[] = [];
  let gone = true;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (gone) return GONE();
    if (url.endsWith("/read-token")) return new Response(JSON.stringify({ token: "art1.t.m", expiresAt: now + 86_400_000 }), { status: 200 });
    return new Response(JSON.stringify({ pods: [] }), { status: 200 });
  }) as typeof fetch;
  const reader = new BoxReadToken({
    comBaseUrl: BASE,
    username: "gone-user",
    serverFqdn: "home.gone-user.flagship.services",
    boxPublicKey: () => ed.getPublicKey(seed),
    signAsBox: (m) => ed.sign(m, seed),
    fetchImpl,
    now: () => now,
    gate,
  });
  return { gate, calls, reader, fetchImpl, advance: (ms: number) => { now += ms; }, revive: () => { gone = false; } };
}

describe("a box whose account was removed (journal F15)", () => {
  it("stops asking .com after the first account-not-found, then asks again after a growing hold", async () => {
    const w = world();
    const PODS = `${BASE}/api/users/gone-user/pods`;
    expect((await w.reader.fetch(PODS)).status).toBe(404);
    expect(w.calls).toEqual([`${BASE}/api/accounts/gone-user/read-token`]);
    // A poll a minute for the next 14 minutes never leaves the box.
    for (let i = 0; i < 14; i++) {
      w.advance(60_000);
      const r = await w.reader.fetch(PODS);
      expect(r.status).toBe(404);
      expect(r.headers.get("x-flagship-account-gone")).toBe("held");
    }
    expect(w.calls).toHaveLength(1);
    w.advance(2 * 60_000);
    await w.reader.fetch(PODS);
    expect(w.calls).toHaveLength(2);
    expect(w.gate.holdMs("gone-user")).toBe(30 * 60_000);
    for (let i = 0; i < 10; i++) w.gate.noteGone("gone-user");
    expect(w.gate.holdMs("gone-user")).toBe(6 * 3_600_000);
  });

  it("lets everything through again once .com answers otherwise", async () => {
    const w = world();
    const PODS = `${BASE}/api/users/gone-user/pods`;
    await w.reader.fetch(PODS);
    w.revive();
    w.advance(16 * 60_000);
    expect((await w.reader.fetch(PODS)).status).toBe(200);
    expect(w.gate.held("gone-user")).toBe(false);
    expect((await w.reader.fetch(PODS)).status).toBe(200);
  });

  it("the doorbell holds the pollers' calls about the account, not other calls", async () => {
    const w = world();
    const bell = new Doorbell({ serverDomain: "home.gone-user.flagship.services", username: "gone-user", fetchImpl: w.fetchImpl, gate: w.gate });
    const TRUST = `${BASE}/api/users/gone-user/trust-exceptions`;
    expect((await bell.fetch(TRUST)).status).toBe(404);
    expect((await bell.fetch(TRUST)).headers.get("x-flagship-account-gone")).toBe("held");
    expect((await bell.fetch(`${BASE}/api/accounts/Gone-User/direct-access`, { method: "POST" })).status).toBe(404);
    await bell.fetch(`${BASE}/api/server/home.gone-user.flagship.services/update`);
    expect(w.calls).toEqual([TRUST, `${BASE}/api/server/home.gone-user.flagship.services/update`]);
  });

  it("a 404 that is not account-not-found, or a server error, starts no hold", async () => {
    const gate = new AccountGoneGate();
    await gate.observe("a", new Response("{}", { status: 404 }));
    await gate.observe("a", new Response("not json", { status: 404 }));
    await gate.observe("a", new Response("{}", { status: 503 }));
    expect(gate.held("a")).toBe(false);
    expect(accountOfPath("/api/users/Bob/pods")).toBe("bob");
    expect(accountOfPath("/api/accounts/bob/read-token")).toBe("bob");
    expect(accountOfPath("/api/server/x/update")).toBeNull();
  });
});
