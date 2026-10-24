import { describe, expect, it } from "vitest";
import { ownDepositFetch } from "../src/boxReadToken.js";

const BASE = "https://flagshipserver.com/api/server/home.ada.flagship.services";

describe("the box's own deposit reads", () => {
  it("send each of the four consume-once deposits with the box's read token and nothing else", async () => {
    const viaToken: string[] = [];
    const plain: string[] = [];
    const f = ownDepositFetch(
      { fetch: async (url: string) => (viaToken.push(url), new Response("{}")) },
      async (input) => (plain.push(String(input)), new Response("{}")),
    );
    for (const lane of ["swk", "cgk", "pairing", "entitlement"]) await f(`${BASE}/${lane}-deposit`, { method: "GET" });
    await f(`${BASE}/update`, { method: "GET" });
    await f(`${BASE}/self-delete?stk=ab`, { method: "GET" });
    await f(`${BASE}/swk-deposit-extra`, { method: "GET" });
    expect(viaToken).toEqual(["swk", "cgk", "pairing", "entitlement"].map((l) => `${BASE}/${l}-deposit`));
    expect(plain).toEqual([`${BASE}/update`, `${BASE}/self-delete?stk=ab`, `${BASE}/swk-deposit-extra`]);
  });

  it("falls back to a plain read when no token can be minted (a demo account is let in, a real one gets 401)", async () => {
    const plain: string[] = [];
    const f = ownDepositFetch(
      { fetch: async () => { throw new Error("read token refused: status 503"); } },
      async (input) => (plain.push(String(input)), new Response(null, { status: 401 })),
    );
    const r = await f(`${BASE}/cgk-deposit`);
    expect(r.status).toBe(401);
    expect(plain).toEqual([`${BASE}/cgk-deposit`]);
  });
});
