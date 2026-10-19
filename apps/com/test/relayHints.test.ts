import { beforeEach, describe, expect, it } from "vitest";
import { ed, parseRelayHint, signRelayHint, verifyRelayHint } from "@flagship/protocol";
import { caTrustChainPublicMaterial } from "../src/caTrustChainLoader.js";
import { route, type RouteEnv } from "../src/route.js";
import { handleRelayHints, resetRelayHintsState } from "../src/relayHints.js";

const DAY = 24 * 3600_000;
const T0 = Date.parse("2026-10-19T12:00:00Z");
const seed = new Uint8Array(32).fill(0x41);
const authority = { publicKey: ed.getPublicKey(seed), privateKey: seed };
const hint = signRelayHint(
  { seq: 1, validFrom: T0, validUntil: T0 + 90 * DAY, addresses: ["149.248.216.86", "2a09:8280:1::110:d2b6:0"] },
  authority,
);

const get = (headers: Record<string, string> = {}, path = "/api/relay-hints", method = "GET") =>
  new Request(`https://flagshipserver.com${path}`, { method, headers });

beforeEach(() => resetRelayHintsState());

describe("GET /api/relay-hints", () => {
  it("answers 204 when nothing is signed, cacheable", async () => {
    const res = await handleRelayHints(get(), { hint: null });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
  });

  it("serves the signed hint and the public mandate log, the same bytes for everyone", async () => {
    const deps = { hint, mandates: caTrustChainPublicMaterial().mandates };
    const a = await handleRelayHints(get(), deps);
    expect(a.status).toBe(200);
    const doc = (await a.json()) as { version: number; hint: unknown; mandates: unknown[] };
    expect(doc.version).toBe(1);
    const parsed = parseRelayHint(doc.hint);
    expect(parsed).not.toBeNull();
    expect(verifyRelayHint(parsed!, [parsed!.signedBy])).toEqual({ ok: true });
    expect(doc.mandates.length).toBeGreaterThan(0);

    const b = await handleRelayHints(
      get({ cookie: "session=abc", authorization: "Bearer secret", "x-flagship-device-id": "d1", "user-agent": "Flagship/1 (iPhone)" }, "/api/relay-hints?u=harry"),
      deps,
    );
    expect(await b.text()).toBe(JSON.stringify(doc));
    expect(b.headers.get("set-cookie")).toBeNull();
  });

  it("answers a conditional request with 304 and no body", async () => {
    const first = await handleRelayHints(get(), { hint });
    const again = await handleRelayHints(get({ "if-none-match": first.headers.get("etag")! }), { hint });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("allows only GET and HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handleRelayHints(get({}, "/api/relay-hints", method), { hint });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    const head = await handleRelayHints(get({}, "/api/relay-hints", "HEAD"), { hint });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("through the Worker", () => {
  const env = (): RouteEnv => ({
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
  });

  it("is public: no preview cookie, no session, no rate-limit bindings needed", async () => {
    const res = await route(get(), env());
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("serves nothing signed today", async () => {
    expect((await route(get(), env())).status).toBe(204);
  });
});
