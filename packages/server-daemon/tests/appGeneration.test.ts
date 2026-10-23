import { describe, expect, it } from "vitest";
import { buildGenerationGate, GENERATION_COOKIE, GENERATION_PATH, originGeneration } from "../src/appGeneration.js";
import type { HttpRequest } from "../src/runtime.js";

const KEY = "ab".repeat(32);
const nav = (path: string, cookie?: string): HttpRequest =>
  ({ method: "GET", path, headers: { "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) }, body: Buffer.alloc(0) }) as unknown as HttpRequest;

describe("origin generations", () => {
  it("change with the host account and a new author, never with the same author's updates", () => {
    const base = originGeneration({ hostAccountKeyHex: KEY, app: "alice--chess" });
    expect(originGeneration({ hostAccountKeyHex: KEY, app: "alice--chess" })).toBe(base);
    expect(originGeneration({ hostAccountKeyHex: "cd".repeat(32), app: "alice--chess" })).not.toBe(base); // a reclaimed name
    expect(originGeneration({ hostAccountKeyHex: KEY, app: "alice--chess", authorChanges: 1 })).not.toBe(base); // an approved new author
    expect(originGeneration({ hostAccountKeyHex: KEY, app: "alice--chess", identityGeneration: 2 })).not.toBe(base);
  });

  it("sends a stale browser through one clean-up and back, keeping only the box's own cookies", async () => {
    const gen = originGeneration({ hostAccountKeyHex: KEY, app: "alice--chess" });
    const gate = buildGenerationGate({ generationOf: () => gen, boxCookies: ["Flagship-App-Session"] });
    const first = await gate(nav("/board?x=1", `${GENERATION_COOKIE}=old; app_sid=s1; Flagship-App-Session=k`), "alice--chess");
    expect(first?.status).toBe(303);
    expect(first?.headers?.["clear-site-data"]).toBe(`"storage", "cache", "executionContexts"`);
    expect(first?.headers?.["clear-site-data"]).not.toContain("cookies");
    expect(first?.headers?.["set-cookie"]).toBe("app_sid=; Path=/; Max-Age=0; Secure");
    const loc = new URL(first!.headers!.location!, "https://chess.alice.flagship.services");
    expect(loc.pathname).toBe(GENERATION_PATH);
    const set = await gate(nav(`${loc.pathname}${loc.search}`), "alice--chess");
    expect(set?.headers?.["set-cookie"]).toContain(`${GENERATION_COOKIE}=${gen};`);
    const back = new URL(set!.headers!.location!, "https://x");
    expect(`${back.pathname}${back.search}`).toBe("/board?x=1&__flagship_gen=1");
    // With the cookie the marker is dropped from the address, then the app sees the request.
    const clean = await gate(nav(`${back.pathname}${back.search}`, `${GENERATION_COOKIE}=${gen}`), "alice--chess");
    expect(clean?.headers?.location).toBe("/board?x=1");
    expect(await gate(nav("/board?x=1", `${GENERATION_COOKIE}=${gen}`), "alice--chess")).toBeNull();
  });

  it("lets a cookie-less browser through instead of looping, ignores API calls, and stays out without a generation", async () => {
    const gate = buildGenerationGate({ generationOf: (ref) => (ref === "alice--chess" ? "g1" : null), boxCookies: [] });
    expect(await gate(nav("/?__flagship_gen=1"), "alice--chess")).toBeNull();
    const api = { method: "POST", path: "/api/move", headers: { "sec-fetch-mode": "cors" }, body: Buffer.alloc(0) } as unknown as HttpRequest;
    expect(await gate(api, "alice--chess")).toBeNull();
    expect(await gate(nav("/"), "bob--other")).toBeNull();
    expect(await gate(nav("/"), null)).toBeNull();
    const evil = await gate(nav(`${GENERATION_PATH}?g=g1&next=//evil.example`), "alice--chess");
    expect(evil?.headers?.location?.startsWith("/?")).toBe(true);
    // A cookie name that is not a token is not echoed back into a header.
    const odd = await gate(nav("/", "bad name=1; ok=2"), "alice--chess");
    expect(odd?.headers?.["set-cookie"]).toBe("ok=; Path=/; Max-Age=0; Secure");
  });
});
