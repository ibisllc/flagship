import { describe, expect, it } from "vitest";
import { buildPushForwarder } from "../src/pushBridge.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  responses: Array<{ status: number; body: string }>,
): {
  f: (
    u: string,
    i?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;
  calls: Captured[];
} {
  let i = 0;
  const calls: Captured[] = [];
  const f: ReturnType<typeof fakeFetch>["f"] = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ?? "",
    });
    const r = responses[i++] ?? { status: 200, body: "{}" };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async text() { return r.body; },
      async json() { return JSON.parse(r.body); },
    };
  };
  return { f, calls };
}

// Real-shape ECDSA P-256 PKCS8 key for tests. Generated offline; this
// isn't real Apple credential material. APNs in tests never sees the
// signed JWT — the fake fetch swallows everything.
const APNS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcVB2+bq/sRVh4a9z
XK+4vc8tAkTF5R7XlJLioNYePZehRANCAATxCC37T/vfvyrC9DWfgVwPQ21tFt1n
NCEaFHQPSliSCPNgeoIJnVCmBnBTHnJB70P222WNXY/q0LCdmx/jxPfr
-----END PRIVATE KEY-----`;

describe("buildPushForwarder — APNs", () => {
  it("mints a JWT, sends a notification with sealed payload, returns sent=1", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: "" }]);
    const forward = buildPushForwarder({
      apns: {
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        privateKeyPem: APNS_TEST_KEY,
        bundleId: "com.flagship.app",
      },
      fetchImpl: f,
      now: () => 1_700_000_000_000,
    });
    const r = await forward({
      targets: [{ tokenId: "tok1", platform: "apns", providerToken: "ABCDEF1234" }],
      category: "unlock-request",
      sealedPayloadHex: "deadbeef",
    });
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.push.apple.com/3/device/ABCDEF1234");
    expect(c.headers["authorization"]).toMatch(/^bearer ey/);
    expect(c.headers["apns-topic"]).toBe("com.flagship.app");
    const body = JSON.parse(c.body);
    expect(body.aps.category).toBe("unlock-request");
    expect(body["flagship-sealed"]).toBe("deadbeef");
  });

  it("counts a non-200 response as failed; returns ok=false when nothing sent", async () => {
    const { f } = fakeFetch([{ status: 410, body: "BadDeviceToken" }]);
    const forward = buildPushForwarder({
      apns: {
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        privateKeyPem: APNS_TEST_KEY,
        bundleId: "com.flagship.app",
      },
      fetchImpl: f,
      now: () => 1_700_000_000_000,
    });
    const r = await forward({
      targets: [{ tokenId: "tok1", platform: "apns", providerToken: "X" }],
      category: "x",
      sealedPayloadHex: "00",
    });
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);
  });

  it("counts unconfigured-platform targets as failed and skips them", async () => {
    const { f, calls } = fakeFetch([]);
    const forward = buildPushForwarder({ fetchImpl: f });
    const r = await forward({
      targets: [
        { tokenId: "tok1", platform: "apns", providerToken: "X" },
        { tokenId: "tok2", platform: "fcm", providerToken: "Y" },
      ],
      category: "x",
      sealedPayloadHex: "00",
    });
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(2);
    expect(calls.length).toBe(0);
  });

  it("at-least-one-success returns ok=true even with mixed outcomes", async () => {
    const { f } = fakeFetch([
      { status: 200, body: "" },
      { status: 410, body: "fail" },
    ]);
    const forward = buildPushForwarder({
      apns: {
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        privateKeyPem: APNS_TEST_KEY,
        bundleId: "com.flagship.app",
      },
      fetchImpl: f,
      now: () => 1_700_000_000_000,
    });
    const r = await forward({
      targets: [
        { tokenId: "a", platform: "apns", providerToken: "A" },
        { tokenId: "b", platform: "apns", providerToken: "B" },
      ],
      category: "x",
      sealedPayloadHex: "00",
    });
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
  });

  it("reuses a JWT across consecutive sends (token cache)", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: "" },
      { status: 200, body: "" },
    ]);
    const forward = buildPushForwarder({
      apns: {
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        privateKeyPem: APNS_TEST_KEY,
        bundleId: "com.flagship.app",
      },
      fetchImpl: f,
      now: () => 1_700_000_000_000,
    });
    await forward({
      targets: [{ tokenId: "a", platform: "apns", providerToken: "A" }],
      category: "x",
      sealedPayloadHex: "00",
    });
    await forward({
      targets: [{ tokenId: "b", platform: "apns", providerToken: "B" }],
      category: "x",
      sealedPayloadHex: "00",
    });
    expect(calls[0]!.headers["authorization"]).toBe(calls[1]!.headers["authorization"]);
  });

  it("refreshes the JWT after the cache TTL", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: "" },
      { status: 200, body: "" },
    ]);
    let now = 1_700_000_000_000;
    const forward = buildPushForwarder({
      apns: {
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        privateKeyPem: APNS_TEST_KEY,
        bundleId: "com.flagship.app",
      },
      fetchImpl: f,
      now: () => now,
    });
    await forward({
      targets: [{ tokenId: "a", platform: "apns", providerToken: "A" }],
      category: "x",
      sealedPayloadHex: "00",
    });
    // Advance well past the 50-min TTL.
    now += 51 * 60_000;
    await forward({
      targets: [{ tokenId: "b", platform: "apns", providerToken: "B" }],
      category: "x",
      sealedPayloadHex: "00",
    });
    expect(calls[0]!.headers["authorization"]).not.toBe(calls[1]!.headers["authorization"]);
  });
});
