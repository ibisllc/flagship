import { describe, expect, it } from "vitest";
import { handlePhoneRouteLedger, phoneEligibilityAccount, PHONE_ROUTE_RATE, PhoneRouteMeter, tryPhoneRouteRoute, type LedgerStorage } from "../src/phoneRoute.js";

const SECRET = "s3cret";
const auth = { authorization: `Bearer ${SECRET}` };

function memStorage(): LedgerStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(k: string) {
      return map.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      map.set(k, structuredClone(v));
    },
  };
}

const post = (body: unknown) => new Request("https://serving-feed/phone-route", { method: "POST", body: JSON.stringify(body) });
const holder = (s: string) => ({ relayId: "relay-1", sessionId: s, phoneRoutePub: "ab".repeat(32) });
const H = "alice.flagship.services";

describe("the phone route ledger in the ServingFeed DO", () => {
  it("compare-and-set acquisition, push on commit, stale renewals refused", async () => {
    const st = memStorage();
    const a = await handlePhoneRouteLedger(st, post({ op: "acquire", hostname: H, generation: 1, holder: holder("s1") }), 1_000);
    expect(await a.response.json()).toMatchObject({ ok: true, entry: { generation: 1 } });
    expect(a.push).toEqual({ type: "phone-route", hostname: H, generation: 1, vacant: false });
    // Held: another phone is refused, whatever generation it names.
    const held = await handlePhoneRouteLedger(st, post({ op: "acquire", hostname: H, generation: 2, holder: holder("s2") }), 1_001);
    expect(await held.response.json()).toMatchObject({ ok: false, code: "route-held", entry: { generation: 1 } });
    expect(held.push).toBeUndefined();
    const rel = await handlePhoneRouteLedger(st, post({ op: "release", hostname: H, generation: 1, sessionId: "s1" }), 1_500);
    expect(rel.push).toEqual({ type: "phone-route", hostname: H, generation: 1, vacant: true });
    await handlePhoneRouteLedger(st, post({ op: "acquire", hostname: H, generation: 2, holder: holder("s2") }), 2_000);
    const stale = await handlePhoneRouteLedger(st, post({ op: "renew", hostname: H, generation: 1, sessionId: "s1" }), 3_000);
    expect(await stale.response.json()).toMatchObject({ ok: false, code: "stale-generation" });
    const read = await handlePhoneRouteLedger(st, new Request(`https://serving-feed/phone-route?hostname=${H}`), 3_000);
    expect(await read.response.json()).toMatchObject({ entry: { generation: 2, holder: { sessionId: "s2" } } });
    // Past the lease the entry has no holder, but keeps its generation.
    const later = await handlePhoneRouteLedger(st, new Request(`https://serving-feed/phone-route?hostname=${H}`), 200_000);
    expect(await later.response.json()).toEqual({ entry: { generation: 2, holder: null, leaseUntil: 0 } });
  });

  it("refuses malformed requests", async () => {
    const st = memStorage();
    for (const body of [{ op: "acquire", hostname: "ALICE", generation: 1, holder: holder("s") }, { op: "steal", hostname: H, generation: 1 }, "x"]) {
      expect((await handlePhoneRouteLedger(st, post(body), 1)).response.status).toBe(400);
    }
  });
});

describe("eligibility read", () => {
  const usernames = { get: async (u: string) => (u === "alice" ? { username: "alice", adminRootPubHex: "AA".repeat(32), irkPubHex: "bb".repeat(32) } : undefined) };
  const row = (deviceId: string, revokedAt: number | null, expiresAt = 10_000_000) => ({
    grantId: deviceId.padEnd(32, "0"), username: "alice", deviceId, devicePubHex: deviceId.padEnd(64, "a"), scopesJson: '["admin"]',
    issuedAt: 1, expiresAt, signatureHex: "cc".repeat(64), revokedAt, signerRoot: "admin-root" as const,
  });
  const grants = { listForUser: async () => [row("d1", null), row("d2", 5), row("d3", null, 2), row("d4", null)] };
  const identities = { get: async (_u: string, d: string) => (d === "d4" ? { revokedAt: 9, devicePubHex: "d4".padEnd(64, "a") } : undefined) };
  const env = { SERVICES_CONTROL_SECRET: SECRET };
  const deps = { usernames, grants, identities, now: () => 1_000 } as never;

  it("lists only active, unexpired grants of live devices, with the admin root", async () => {
    const r = await tryPhoneRouteRoute(new Request("https://x/api/internal/phone-route/alice/eligibility", { headers: auth }), env as never, deps);
    const b = (await r!.json()) as { adminRootPub: string; grants: Array<{ deviceId: string }> };
    expect(b.adminRootPub).toBe("aa".repeat(32));
    expect(b.grants.map((g) => g.deviceId)).toEqual(["d1"]);
  });

  it("needs the services control secret", async () => {
    const r = await tryPhoneRouteRoute(new Request("https://x/api/internal/phone-route/alice/eligibility"), env as never, deps);
    expect(r!.status).toBe(401);
    expect((await tryPhoneRouteRoute(new Request("https://x/api/internal/phone-route/bob/eligibility", { headers: auth }), env as never, deps))!.status).toBe(404);
  });

  it("meters the internal routes per account and hostname (security review 2026-11-02, M4)", async () => {
    let now = 1_000;
    let reads = 0;
    const counted = { ...grants, listForUser: async () => (reads++, grants.listForUser()) };
    const fetched: string[] = [];
    const ns = { idFromName: () => "one", get: () => ({ fetch: async (r: Request) => (fetched.push(r.method), new Response("{}")) }) };
    const e = { SERVICES_CONTROL_SECRET: SECRET, SERVING_FEED: ns };
    const d = { usernames, grants: counted, identities, now: () => now, meter: new PhoneRouteMeter() } as never;
    const elig = () => tryPhoneRouteRoute(new Request("https://x/api/internal/phone-route/alice/eligibility", { headers: auth }), e as never, d);
    for (let i = 0; i < PHONE_ROUTE_RATE.eligibilityPerMinute; i++) expect((await elig())!.status).toBe(200);
    const over = await elig();
    expect(over!.status).toBe(429);
    expect(await over!.json()).toMatchObject({ code: "phone-route-busy" });
    expect(reads).toBe(PHONE_ROUTE_RATE.eligibilityPerMinute);
    // Another account is not held back; a minute later the account is served again.
    expect((await tryPhoneRouteRoute(new Request("https://x/api/internal/phone-route/bob/eligibility", { headers: auth }), e as never, d))!.status).toBe(404);
    now += 60_000;
    expect((await elig())!.status).toBe(200);
    const read = () => tryPhoneRouteRoute(new Request(`https://x/api/internal/phone-route/ledger?hostname=${H}`, { headers: auth }), e as never, d);
    for (let i = 0; i < PHONE_ROUTE_RATE.ledgerReadPerMinute; i++) expect((await read())!.status).toBe(200);
    expect((await read())!.status).toBe(429);
    expect(fetched).toHaveLength(PHONE_ROUTE_RATE.ledgerReadPerMinute);
  });

  it("knows which writes may end a phone's eligibility", () => {
    expect(phoneEligibilityAccount("DELETE", "/api/accounts/alice/devices/abc")).toBe("alice");
    expect(phoneEligibilityAccount("POST", "/api/users/Alice/device-grants/revoke")).toBe("alice");
    expect(phoneEligibilityAccount("GET", "/api/accounts/alice/devices/abc")).toBeNull();
    expect(phoneEligibilityAccount("POST", "/api/users/alice/device-grants")).toBeNull();
  });
});
