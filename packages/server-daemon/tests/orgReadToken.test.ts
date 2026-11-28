import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalOrgReadTokenRequest, verifyOrgReadTokenRequest, type OrgReadTokenRequest } from "@flagship/protocol";
import { OrgReadToken } from "../src/orgReadToken.js";
import { startOrgAuthoritySync } from "../src/orgAuthorityPin.js";
import { fetchOrgRings } from "../src/orgBoxKeys.js";
import { ConnectorRuntime } from "../src/directory/connector.js";

const ORG = "ab".repeat(16);
const BASE = "https://flagshipserver.com";
const DOMAIN = "home.acme.flagship.services";
const seed = new Uint8Array(32).fill(7);
const pub = ed25519.getPublicKey(seed);

interface Call { url: string; method: string; auth: string | null; body?: any }

function fakeCom(opts: { mint?: (n: number) => Response; read?: (auth: string | null, n: number) => Response } = {}) {
  const calls: Call[] = [];
  let mints = 0;
  let reads = 0;
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const call: Call = { url, method, auth: headers.get("authorization") };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    if (url.endsWith("/read-token")) {
      mints++;
      return opts.mint?.(mints) ?? Response.json({ token: `ort1.t${mints}`, expiresAt: Date.now() + 24 * 3_600_000 });
    }
    reads++;
    return opts.read?.(call.auth, reads) ?? Response.json({});
  };
  return { f, calls, mints: () => mints };
}

const reader = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof OrgReadToken>[0]> = {}) =>
  new OrgReadToken({ comBaseUrl: BASE, orgId: ORG, serverDomain: DOMAIN, boxPublicKey: () => pub, signAsBox: (m) => ed25519.sign(m, seed), fetchImpl: f, ...extra });

afterEach(() => vi.useRealTimers());

describe("box org read token", () => {
  it("mints with the protocol's request bytes, signed by the STK, as box:<domain>", async () => {
    const com = fakeCom();
    await reader(com.f).fetch(`${BASE}/api/orgs/${ORG}/authority`);
    const mint = com.calls[0]!;
    expect(mint.url).toBe(`${BASE}/api/orgs/${ORG}/read-token`);
    expect(mint.method).toBe("POST");
    const r = mint.body.request as OrgReadTokenRequest;
    expect(r).toMatchObject({ orgId: ORG, subject: `box:${DOMAIN}`, pubHex: Buffer.from(pub).toString("hex") });
    expect(Buffer.from(canonicalOrgReadTokenRequest(r)).toString()).toBe(
      ["flagship/org-read-token-request/v1", ORG, `box:${DOMAIN}`, r.pubHex, r.issuedAt, r.nonceHex].join("|"),
    );
    expect(verifyOrgReadTokenRequest(r, mint.body.signature, pub)).toBe(true);
    expect(com.calls[1]).toMatchObject({ method: "GET", auth: "Bearer ort1.t1" });
  });

  it("keeps the token until near expiry, and mints again once after a 401", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000_000_000);
    const com = fakeCom({ read: (auth, n) => (n === 3 && auth === "Bearer ort1.t1" ? new Response("{}", { status: 401 }) : Response.json({})) });
    const t = reader(com.f);
    await t.fetch(`${BASE}/api/orgs/${ORG}/seats`);
    await t.fetch(`${BASE}/api/orgs/${ORG}/seats`);
    expect(com.mints()).toBe(1);
    const r = await t.fetch(`${BASE}/api/orgs/${ORG}/seats`);
    expect(r.status).toBe(200);
    expect(com.mints()).toBe(2);
    expect(com.calls.at(-1)!.auth).toBe("Bearer ort1.t2");
    vi.setSystemTime(1_000_000_000_000 + 24 * 3_600_000 - 5 * 60_000);
    await t.fetch(`${BASE}/api/orgs/${ORG}/seats`);
    expect(com.mints()).toBe(3);
  });

  it("goes without a token when the mint fails, logs it once, and waits before minting again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000_000_000);
    const log = vi.fn();
    const com = fakeCom({ mint: () => new Response("{}", { status: 403 }), read: (auth) => (auth ? Response.json({}) : new Response("{}", { status: 401 })) });
    const t = reader(com.f, { log });
    for (let i = 0; i < 5; i++) {
      const r = await t.fetch(`${BASE}/api/orgs/${ORG}/keys`);
      expect(r.status).toBe(401);
    }
    expect(com.mints()).toBe(1);
    expect(com.calls.filter((c) => c.method === "GET").every((c) => c.auth === null)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000_000_000 + 5 * 60_000);
    await t.fetch(`${BASE}/api/orgs/${ORG}/keys`);
    expect(com.mints()).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("a .com that cannot be reached for the mint still gets the read", async () => {
    const f: typeof fetch = async (input) => {
      if (String(input).endsWith("/read-token")) throw new TypeError("fetch failed");
      return Response.json({ ok: true });
    };
    const r = await reader(f, { log: () => undefined }).fetch(`${BASE}/api/orgs/${ORG}/plan-attestation`);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("fetchFor adds the token to this org's GETs only", async () => {
    const com = fakeCom();
    const f = reader(com.f).fetchFor();
    await f(`${BASE}/api/orgs/${ORG}/plan-attestation`, { signal: AbortSignal.timeout(1000) });
    await f(`${BASE}/api/orgs/${ORG}/box-kems`, { method: "POST", body: "{}" });
    await f(`${BASE}/api/orgs/${"cd".repeat(16)}/authority`);
    await f(`${BASE}/api/users/alice/pods`);
    const byUrl = (u: string) => com.calls.find((c) => c.url === u && !c.url.endsWith("read-token"))!;
    expect(byUrl(`${BASE}/api/orgs/${ORG}/plan-attestation`).auth).toBe("Bearer ort1.t1");
    expect(byUrl(`${BASE}/api/orgs/${ORG}/box-kems`).auth).toBeNull();
    expect(byUrl(`${BASE}/api/orgs/${"cd".repeat(16)}/authority`).auth).toBeNull();
    expect(byUrl(`${BASE}/api/users/alice/pods`).auth).toBeNull();
    expect(com.mints()).toBe(1);
  });
});

describe("every org reader sends the token", () => {
  const gets = (com: ReturnType<typeof fakeCom>) => com.calls.filter((c) => c.method === "GET");

  it("org authority sync (authority, seats)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-rt-"));
    try {
      const com = fakeCom({ read: () => Response.json({ entries: [], grants: [] }) });
      const sync = await startOrgAuthoritySync({
        orgId: ORG, genesisHash: "00".repeat(32), serverDomain: DOMAIN, controlPlaneBaseUrl: BASE,
        pinPath: join(dir, "pin.json"), fetchImpl: reader(com.f).fetchFor(),
        hooks: { closeSessions: async () => undefined, dropEnrolledAppIds: async () => undefined, freezeInvitesBy: async () => undefined, rotate: async () => true },
      });
      await vi.waitFor(() => expect(gets(com).length).toBe(2));
      sync.stop();
      expect(gets(com).map((c) => c.url.split("/").at(-1)).sort()).toEqual(["authority", "seats"]);
      expect(gets(com).every((c) => c.auth === "Bearer ort1.t1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("org key rings (keys)", async () => {
    const com = fakeCom({ read: () => Response.json({ rings: [] }) });
    await fetchOrgRings({ orgId: ORG, controlPlaneBaseUrl: BASE, fetchImpl: reader(com.f).fetchFor() });
    expect(gets(com)).toEqual([expect.objectContaining({ url: `${BASE}/api/orgs/${ORG}/keys`, auth: "Bearer ort1.t1" })]);
  });

  it("directory connectors (connectors, servers, keys, proposals, seats)", async () => {
    const com = fakeCom();
    const rt = new ConnectorRuntime({
      dataDir: "/nonexistent", orgId: ORG, serverDomain: DOMAIN, controlPlaneBaseUrl: BASE, pin: () => null,
      boxKemSeed: async () => new Uint8Array(32), fetchImpl: reader(com.f).fetchFor(),
    });
    const get = (rt as unknown as { get: (p: string) => Promise<unknown> }).get.bind(rt);
    for (const p of ["/connectors", "/servers", "/keys", "/proposals", "/seats"]) await get(p);
    expect(gets(com).map((c) => c.url.slice(`${BASE}/api/orgs/${ORG}`.length))).toEqual(["/connectors", "/servers", "/keys", "/proposals", "/seats"]);
    expect(gets(com).every((c) => c.auth === "Bearer ort1.t1")).toBe(true);
  });
});
