/**
 * P14 — Companion receiver flow (apps/web/public/webapp/lib/companionReceiver.js).
 *
 * Coverage:
 *   1. companionPayloadFromLocation parses ?companion=… into the documented shape.
 *   2. redeemCompanionAndPersist hits the pod's /api/companion/redeem with
 *      the right body shape.
 *   3. On 200, persists a NEW profile slot with kind:"companion" + the
 *      session-token/expiresAt/podBaseUrl/username, sets it active, and
 *      strips ?companion=… from the URL via history.replaceState.
 *   4. On non-2xx surfaces a friendly error (no profile mutation).
 *   5. The companion-profile write-gate (requireOwnerProfile) THROWS
 *      when the active profile is kind:"companion".
 *   6. cloudName is deterministic per (podBaseUrl, tokenPrefix).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class MemStorage implements Storage {
  private kv = new Map<string, string>();
  get length() { return this.kv.size; }
  clear(): void { this.kv.clear(); }
  getItem(k: string): string | null { return this.kv.get(k) ?? null; }
  setItem(k: string, v: string): void { this.kv.set(k, String(v)); }
  removeItem(k: string): void { this.kv.delete(k); }
  key(i: number): string | null {
    return [...this.kv.keys()][i] ?? null;
  }
}

async function loadReceiverModule() {
  // Install a fresh localStorage on globalThis BEFORE the module loads,
  // because profilesStore reads it at first call. We also rotate the
  // module via a cache-busting suffix so each test sees a fresh closure.
  const ls = new MemStorage();
  (globalThis as { localStorage?: Storage }).localStorage = ls;

  const receiverPath = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "companionReceiver.js",
  );
  const profilesPath = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "profilesStore.js",
  );
  const clientPath = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "companionClient.js",
  );
  const guardPath = resolve(
    __dirname,
    "..",
    "public",
    "webapp",
    "lib",
    "companionGuard.js",
  );
  const apiPath = resolve(__dirname, "..", "public", "webapp", "lib", "api.js");

  // Cache-bust each import with a query suffix so per-test module state
  // doesn't leak across tests.
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const [receiver, profilesStore, client, guard, api] = await Promise.all([
    import(pathToFileURL(receiverPath).href + bust),
    import(pathToFileURL(profilesPath).href + bust),
    import(pathToFileURL(clientPath).href + bust),
    import(pathToFileURL(guardPath).href + bust),
    import(pathToFileURL(apiPath).href + bust),
  ]);
  return { receiver, profilesStore, client, guard, api, ls };
}

const VALID_PAYLOAD = {
  ticketId: "deadbeef".repeat(4),
  ticketSecret: "ab".repeat(32),
  podBaseUrl: "https://home.alice.flagship.services",
  username: "alice",
};

function payloadB64(obj: object) {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString("base64url");
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemStorage();
});

describe("companionPayloadFromLocation", () => {
  it("parses a ?companion=<b64> URL", async () => {
    const { receiver } = await loadReceiverModule();
    const url = new URL(`https://web.flagshipserver.com/?companion=${payloadB64(VALID_PAYLOAD)}`);
    const parsed = receiver.companionPayloadFromLocation({ search: url.search });
    expect(parsed).toEqual(VALID_PAYLOAD);
  });

  it("returns null when no companion param", async () => {
    const { receiver } = await loadReceiverModule();
    expect(receiver.companionPayloadFromLocation({ search: "" })).toBeNull();
    expect(receiver.companionPayloadFromLocation({ search: "?foo=bar" })).toBeNull();
  });

  it("returns null on malformed payload (missing required fields)", async () => {
    const { receiver } = await loadReceiverModule();
    const bad = payloadB64({ ticketId: "x" });
    expect(receiver.companionPayloadFromLocation({ search: `?companion=${bad}` })).toBeNull();
  });
});

describe("companionCloudName", () => {
  it("is deterministic per (podBaseUrl, tokenPrefix)", async () => {
    const { receiver } = await loadReceiverModule();
    const a = receiver.companionCloudName("https://home.alice.flagship.services", "abcd1234ef56");
    const b = receiver.companionCloudName("https://home.alice.flagship.services", "abcd1234ef56");
    expect(a).toBe(b);
    expect(a).toBe("companion-home.alice.flagship.services-abcd1234ef56");
  });

  it("differs across token prefixes", async () => {
    const { receiver } = await loadReceiverModule();
    const a = receiver.companionCloudName("https://home.alice.flagship.services", "abcd1234ef56");
    const b = receiver.companionCloudName("https://home.alice.flagship.services", "0000feedbeef");
    expect(a).not.toBe(b);
  });
});

describe("redeemCompanionAndPersist", () => {
  it("POSTs the right shape to /api/companion/redeem", async () => {
    const { receiver } = await loadReceiverModule();
    const calls: Array<{ url: string; body: unknown; method: string | undefined }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method,
      });
      return new Response(
        JSON.stringify({
          companionSessionToken: "f".repeat(64),
          expiresAt: 9_999,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
          label: "iMac",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://home.alice.flagship.services/api/companion/redeem",
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      ticketId: VALID_PAYLOAD.ticketId,
      ticketSecret: VALID_PAYLOAD.ticketSecret,
    });
    expect(result.error).toBeUndefined();
    expect(result.kind).toBe("companion");
    expect(result.sessionToken).toMatch(/^f+$/);
    expect(result.expiresAt).toBe(9_999);
    expect(result.label).toBe("iMac");
  });

  it("persists a NEW companion profile slot with the documented kind + fields", async () => {
    const { receiver, profilesStore, api } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          companionSessionToken: "abcd1234ef56" + "0".repeat(52),
          expiresAt: 12_345,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
          label: "iMac",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });

    // The new cloudName is the deterministic companion-<host>-<prefix>.
    const expectedCloud = "companion-home.alice.flagship.services-abcd1234ef56";
    expect(profilesStore.getActiveCloudName()).toBe(expectedCloud);
    const slot = profilesStore.getProfileSlot(expectedCloud)!;
    expect(slot.kind).toBe("companion");
    expect(slot.username).toBe("alice");
    expect(slot.podBaseUrl).toBe("https://home.alice.flagship.services");
    expect(slot.sessionToken).toMatch(/^abcd1234ef56/);
    expect(slot.companionExpiresAt).toBe("12345");
    expect(slot.companionLabel).toBe("iMac");

    // api.js read-helpers see the new active session.
    expect(api.getPodBaseUrl()).toBe("https://home.alice.flagship.services");
    expect(api.getSessionToken()).toMatch(/^abcd1234ef56/);
  });

  it("strips ?companion=… from the URL via history.replaceState on success", async () => {
    const { receiver } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          companionSessionToken: "x".repeat(64),
          expiresAt: 1,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
        }),
        { status: 200 },
      );
    const replaced: string[] = [];
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: (u: string) => replaced.push(u),
      locationHref: "https://web.flagshipserver.com/some/page?companion=abc&foo=bar",
    });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).not.toContain("companion=");
    expect(replaced[0]).toContain("foo=bar");
  });

  it("returns { error } and does NOT mutate the active profile on a non-2xx response", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "ticket expired" }), { status: 410 });
    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });
    expect(result.error).toMatch(/ticket expired/);
    expect(result.status).toBe(410);
    // No active profile got set — receiver should be inert on failure.
    expect(profilesStore.getActiveCloudName()).toBeNull();
  });

  it("returns { error } on a malformed 200 response (missing sessionToken)", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ companionSessionToken: 42 }), { status: 200 });
    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });
    expect(result.error).toMatch(/missing/);
    expect(profilesStore.getActiveCloudName()).toBeNull();
  });
});

describe("companionGuard.requireOwnerProfile()", () => {
  it("throws CompanionWriteError when active profile is kind:'companion'", async () => {
    const { receiver, guard } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          companionSessionToken: "abc" + "0".repeat(61),
          expiresAt: 1,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
        }),
        { status: 200 },
      );
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });
    expect(guard.isCompanionProfile()).toBe(true);
    expect(() => guard.requireOwnerProfile()).toThrow(/companion/i);
    try {
      guard.requireOwnerProfile();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("companion-write-not-allowed");
    }
  });

  it("does NOT throw when no profile is active", async () => {
    const { guard } = await loadReceiverModule();
    expect(guard.isCompanionProfile()).toBe(false);
    expect(() => guard.requireOwnerProfile()).not.toThrow();
  });

  it("non-relayable signing helpers (replace / wipe) still REFUSE companion writes", async () => {
    const { receiver } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          companionSessionToken: "abc" + "0".repeat(61),
          expiresAt: 1,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
        }),
        { status: 200 },
      );
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });

    // replaceDeviceCeremony — outside the v1 relayable set; throws.
    const replacePath = resolve(
      __dirname, "..", "public", "webapp", "lib", "replaceDeviceCeremony.js",
    );
    const replaceMod = await import(pathToFileURL(replacePath).href + `?t=${Math.random()}`);
    await expect(
      replaceMod.runReplaceDeviceCeremony(
        { username: "alice", umk: new Uint8Array(32) },
        { fetch: async () => new Response("", { status: 500 }) },
      ),
    ).rejects.toThrow(/companion/i);

    // wipeRestartCeremony — also outside the v1 relayable set.
    const wipePath = resolve(
      __dirname, "..", "public", "webapp", "lib", "wipeRestartCeremony.js",
    );
    const wipeMod = await import(pathToFileURL(wipePath).href + `?t=${Math.random()}`);
    // Find the entry that wraps requireOwnerProfile(); call it with minimal
    // arg coverage to elicit the guard.
    let wipeSaw = false;
    for (const fn of Object.keys(wipeMod)) {
      if (typeof wipeMod[fn] !== "function") continue;
      try {
        // Call with maximally-permissive args; the guard runs before deeper checks.
        const out = wipeMod[fn](
          {
            username: "alice",
            serverDomain: "home.alice.flagship.services",
            umk: new Uint8Array(32),
            signWithIrk: async () => new Uint8Array(64),
          },
          { fetch: async () => new Response("", { status: 500 }) },
        );
        if (out && typeof out.then === "function") await out;
      } catch (e: unknown) {
        if (/companion/i.test(String((e as Error)?.message ?? e))) { wipeSaw = true; break; }
      }
    }
    expect(wipeSaw).toBe(true);
  });

  it("RELAYABLE signing helpers (releaseServer / revokeServer) forward to the daemon write-relay", async () => {
    const { receiver, api } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          companionSessionToken: "abc" + "0".repeat(61),
          expiresAt: 1,
          podBaseUrl: "https://home.alice.flagship.services",
          username: "alice",
        }),
        { status: 200 },
      );
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
      historyReplaceState: () => {},
      locationHref: "https://web.flagshipserver.com/?companion=abc",
    });

    // releaseServerName under a companion profile now forwards to the
    // pod's /api/companion/request-write instead of throwing.
    expect(api.getPodBaseUrl()).toBe("https://home.alice.flagship.services");
    const releasePath = resolve(__dirname, "..", "public", "webapp", "lib", "releaseServer.js");
    const releaseMod = await import(pathToFileURL(releasePath).href + `?t=${Math.random()}`);

    let releaseRelayUrl: string | null = null;
    let releaseRelayBody: unknown = null;
    const releaseRelayFetch: typeof fetch = (async (url: string, init: RequestInit) => {
      releaseRelayUrl = url;
      releaseRelayBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        requestId: "req-release-1",
        queuedAt: 1700000000000,
        expiresAt: 1700000000000 + 600_000,
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const releaseOut = await releaseMod.releaseServerName(
      {
        username: "alice",
        serverDomain: "home.alice.flagship.services",
        umk: new Uint8Array(32),
        signWithIrk: async () => new Uint8Array(64),
      },
      { fetch: releaseRelayFetch, now: () => 1700000000000 },
    );
    expect(releaseOut).toMatchObject({
      pending: true,
      kind: "release-server",
      requestId: "req-release-1",
    });
    expect(releaseRelayUrl).toBe(
      "https://home.alice.flagship.services/api/companion/request-write",
    );
    expect(releaseRelayBody).toMatchObject({
      kind: "release-server",
      intent: {
        username: "alice",
        serverDomain: "home.alice.flagship.services",
        issuedAt: 1700000000000,
      },
    });

    // revokeServer under a companion profile — same shape, kind="revoke-server".
    const revokePath = resolve(__dirname, "..", "public", "webapp", "lib", "revokeServer.js");
    const revokeMod = await import(pathToFileURL(revokePath).href + `?t=${Math.random()}`);
    let revokeRelayUrl: string | null = null;
    let revokeRelayBody: unknown = null;
    const revokeRelayFetch: typeof fetch = (async (url: string, init: RequestInit) => {
      revokeRelayUrl = url;
      revokeRelayBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        requestId: "req-revoke-1",
        queuedAt: 1700000000000,
        expiresAt: 1700000000000 + 600_000,
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const revokeOut = await revokeMod.revokeServer(
      {
        userId: "alice",
        revokedServerId: "home.alice.flagship.services",
        reason: "decommissioned",
        umk: new Uint8Array(32),
        signWithIrk: async () => new Uint8Array(64),
      },
      { fetch: revokeRelayFetch, now: () => 1700000000000 },
    );
    expect(revokeOut).toMatchObject({
      pending: true,
      kind: "revoke-server",
      requestId: "req-revoke-1",
    });
    expect(revokeRelayUrl).toBe(
      "https://home.alice.flagship.services/api/companion/request-write",
    );
    expect(revokeRelayBody).toMatchObject({
      kind: "revoke-server",
      intent: {
        userId: "alice",
        revokedServerId: "home.alice.flagship.services",
        reason: "decommissioned",
        issuedAt: 1700000000000,
      },
    });
  });
});
