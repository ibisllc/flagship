import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountReadFetch,
  accountReadUsername,
  clearAccountReadTokens,
  deviceRequestHeaders,
  irkClaimBody,
  isAccountReadPaused,
} from "../public/webapp/lib/accountRead.js";

const v = JSON.parse(readFileSync(
  resolve(__dirname, "../../../packages/protocol/test-vectors/account-read-token/vectors.json"),
  "utf8",
));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const U = v.keys.accountId as string;
const PODS = `https://com.test/api/users/${U}/pods`;
const session = () => ({ username: U, umk: bytes(v.keys.umkSeedHex) });
const profile = () => ({ cloudName: "home", accountId: U, deviceId: v.keys.deviceId });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => clearAccountReadTokens());

describe("account read token requests match the vectors", () => {
  it("signs the device request exactly like the TS reference", async () => {
    const headers = await deviceRequestHeaders(
      { umk: bytes(v.keys.umkSeedHex), accountId: U, deviceId: v.keys.deviceId, path: v.device.fields.path },
      { now: () => v.device.fields.issuedAt, requestId: v.device.fields.requestId },
    );
    expect(headers).toEqual(v.device.headers);
  });

  it("signs the IRK claim exactly like the TS reference", async () => {
    const body = await irkClaimBody(
      { username: U, umk: bytes(v.keys.umkSeedHex) },
      { now: () => v.irk.fields.issuedAt, nonceHex: v.irk.fields.nonce },
    );
    expect(body).toEqual(v.irk.body);
  });
});

describe("accountReadFetch", () => {
  it("only gates the account's private reads", () => {
    expect(accountReadUsername(PODS)).toBe(U);
    expect(accountReadUsername(`https://com.test/api/users/${U}/stream?cursor=x`)).toBe(U);
    expect(accountReadUsername(`https://com.test/api/users/${U}/apps/${U}--family/links`)).toBe(U);
    expect(accountReadUsername(`https://com.test/api/users/${U}/apps/aliases`)).toBe(U);
    expect(accountReadUsername(`https://com.test/api/users/${U}/allowance`)).toBe(U);
    expect(accountReadUsername(`https://com.test/api/users/${U}/apps/${U}--family/rename`)).toBeNull();
    expect(accountReadUsername(`https://com.test/api/users/${U}/pubkey-cert`)).toBeNull();
  });

  it("mints with the device key, then reads with the token", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/read-token")) return json({ token: "art1.t.m", expiresAt: Date.now() + 86_400_000 });
      return json({ pods: [] });
    });
    const deps = { fetch, getSession: session, getProfile: profile, isCompanion: () => false, baseUrl: "https://com.test" };
    expect((await accountReadFetch(PODS, { cache: "no-store" }, deps)).status).toBe(200);
    expect((await accountReadFetch(PODS, {}, deps)).status).toBe(200);
    const mints = fetch.mock.calls.filter(([url]) => String(url).endsWith("/read-token"));
    expect(mints).toHaveLength(1);
    expect((mints[0]![1] as RequestInit).headers).toHaveProperty("x-flagship-device-id", v.keys.deviceId);
    const reads = fetch.mock.calls.filter(([url]) => url === PODS);
    for (const [, init] of reads) expect((init as RequestInit).headers).toHaveProperty("authorization", "Bearer art1.t.m");
  });

  it("falls back to the IRK when the device request is refused", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/read-token")) {
        return init.body ? json({ token: "art1.irk.m", expiresAt: Date.now() + 3_600_000 }) : json({ error: "no" }, 403);
      }
      return json({ pods: [] });
    });
    await accountReadFetch(PODS, {}, { fetch, getSession: session, getProfile: profile, isCompanion: () => false, baseUrl: "https://com.test" });
    const irkMint = fetch.mock.calls.find(([url, init]) => String(url).endsWith("/read-token") && (init as RequestInit).body);
    expect(JSON.parse(String((irkMint![1] as RequestInit).body)).auth.endpointLabel).toBe("account-read-token");
    expect(fetch.mock.calls.at(-1)![1]).toHaveProperty("headers.authorization", "Bearer art1.irk.m");
  });

  it("re-mints once on a 401, then gives up and pauses", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/read-token")) return json({ token: `art1.${++n}.m`, expiresAt: Date.now() + 86_400_000 });
      return json({ error: "an account read token is required" }, 401);
    });
    const r = await accountReadFetch(PODS, {}, { fetch, getSession: session, getProfile: profile, isCompanion: () => false, baseUrl: "https://com.test" });
    expect(r.status).toBe(401);
    expect(fetch.mock.calls.filter(([url]) => url === PODS)).toHaveLength(2);
    expect(n).toBe(2);
    expect(isAccountReadPaused()).toBe(true);
  });

  it("never mints or prompts without the account keys", async () => {
    const fetch = vi.fn(async () => json({ error: "an account read token is required" }, 401));
    await accountReadFetch(PODS, {}, { fetch, getSession: () => ({ username: U, umk: null }), getProfile: profile, isCompanion: () => false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[1]).not.toHaveProperty("headers.authorization");
  });

  it("reads a demo account without a token", async () => {
    const fetch = vi.fn(async () => json({ pods: [] }));
    await accountReadFetch(PODS, {}, {
      fetch,
      getSession: session,
      getProfile: () => ({ ...profile(), demoServer: { fqdn: "x" } }),
      isCompanion: () => false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(PODS);
  });

  it("never reads the account from a keyless remote browser", async () => {
    const fetch = vi.fn(async () => json({ pods: [] }));
    const r = await accountReadFetch(PODS, {}, { fetch, getSession: session, getProfile: profile, isCompanion: () => true });
    expect(r.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
