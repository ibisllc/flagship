import { describe, expect, it } from "vitest";
import { ed, verifyBoxReadTokenRequest } from "@flagship/protocol";
import { BoxReadToken } from "../src/boxReadToken.js";

const seed = new Uint8Array(32).fill(7);
const pub = ed.getPublicKey(seed);
const NOW = 1_900_000_000_000;

function harness(opts: { refuseFirstRead?: boolean } = {}) {
  const calls: Array<{ url: string; auth: string | null; body?: any }> = [];
  let minted = 0;
  let now = NOW;
  let refuse = opts.refuseFirstRead ?? false;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    if (url.endsWith("/read-token")) {
      const body = JSON.parse(String(init.body));
      calls.push({ url, auth, body });
      minted += 1;
      return new Response(JSON.stringify({ token: `art1.t${minted}.m`, expiresAt: now + 24 * 3_600_000 }), { status: 200 });
    }
    calls.push({ url, auth });
    if (refuse) {
      refuse = false;
      return new Response("{}", { status: 401 });
    }
    return new Response(JSON.stringify({ aliases: [] }), { status: 200 });
  }) as typeof fetch;
  const token = new BoxReadToken({
    comBaseUrl: "https://flagshipserver.com/",
    username: "Plucky-Avocet",
    serverFqdn: "home3.plucky-avocet.flagship.services",
    boxPublicKey: () => pub,
    signAsBox: (m) => ed.sign(m, seed),
    fetchImpl,
    now: () => now,
  });
  return { token, calls, advance: (ms: number) => { now += ms; } };
}

const ALIASES = "https://flagshipserver.com/api/users/plucky-avocet/apps/aliases";

describe("the box's account read token", () => {
  it("mints with its STK and sends the token as a bearer", async () => {
    const h = harness();
    await h.token.fetch(ALIASES);
    const mint = h.calls[0]!;
    expect(mint.url).toBe("https://flagshipserver.com/api/accounts/plucky-avocet/read-token");
    expect(mint.body.box).toMatchObject({
      username: "plucky-avocet",
      serverDomain: "home3.plucky-avocet.flagship.services",
      stkPubHex: Buffer.from(pub).toString("hex"),
    });
    expect(verifyBoxReadTokenRequest(mint.body.box, mint.body.signature, pub)).toBe(true);
    expect(h.calls[1]).toEqual({ url: ALIASES, auth: "Bearer art1.t1.m" });
  });

  it("reuses the token until shortly before it expires", async () => {
    const h = harness();
    await h.token.fetch(ALIASES);
    await h.token.fetch(ALIASES);
    expect(h.calls.filter((c) => c.url.endsWith("/read-token"))).toHaveLength(1);
    h.advance(24 * 3_600_000 - 60_000);
    await h.token.fetch(ALIASES);
    expect(h.calls.filter((c) => c.url.endsWith("/read-token"))).toHaveLength(2);
  });

  it("mints again once when .com refuses the token", async () => {
    const h = harness({ refuseFirstRead: true });
    const r = await h.token.fetch(ALIASES);
    expect(r.status).toBe(200);
    expect(h.calls.map((c) => c.auth)).toEqual([null, "Bearer art1.t1.m", null, "Bearer art1.t2.m"]);
  });

  it("gives up on a .com that never answers, on the mint and on the read", async () => {
    const hang = ((_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
      })) as unknown as typeof fetch;
    const mk = (fetchImpl: typeof fetch) =>
      new BoxReadToken({
        comBaseUrl: "https://flagshipserver.com",
        username: "alice",
        serverFqdn: "home.alice.flagship.services",
        boxPublicKey: () => pub,
        signAsBox: (m) => ed.sign(m, seed),
        fetchImpl,
        timeoutMs: 40,
      });
    const started = Date.now();
    await expect(mk(hang).fetch(ALIASES)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);

    // Minting works but the read hangs: it still gives up.
    const slowRead = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/read-token")) return new Response(JSON.stringify({ token: "art1.t1.m", expiresAt: NOW + 24 * 3_600_000 }), { status: 200 });
      return hang(url, init);
    }) as typeof fetch;
    await expect(mk(slowRead).fetch(ALIASES)).rejects.toBeDefined();
  });
});
