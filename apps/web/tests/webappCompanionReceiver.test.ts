/**
 * The remote browser's redeem + session store (apps/web/public/webapp/lib/companionReceiver.js).
 *
 * Coverage:
 *   1. A `?companion=` URL does nothing: no boot entry reads it any more.
 *   2. redeemCompanionAndPersist hits the pod's /api/companion/redeem with
 *      the right body shape.
 *   3. On 200, persists a NEW profile slot with kind:"companion" + the
 *      session-token/expiresAt/podBaseUrl/username and sets it active.
 *   4. A redeem response (or a ticket) naming a server off the data apex is refused.
 *   5. On non-2xx surfaces a friendly error (no profile mutation).
 *   6. The companion-profile write-gate (requireOwnerProfile) THROWS
 *      when the active profile is kind:"companion".
 *   7. cloudName is deterministic per (podBaseUrl, tokenPrefix).
 *   8. Expired remote profiles are retired.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

describe("the ?companion= entry point is gone", () => {
  const webapp = resolve(__dirname, "..", "public", "webapp");
  const allJs = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "vendor" || e.name === "i18n" ? [] : allJs(p);
      return e.name.endsWith(".js") ? [p] : [];
    });

  it("no webapp code reads a companion query parameter, so a ?companion= URL does nothing", () => {
    for (const file of allJs(webapp)) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\.get\(\s*["']companion["']\s*\)/);
      expect(src, file).not.toMatch(/[?&]companion=/);
    }
  });

  it("the receiver no longer exports the URL parser, and the client no longer builds receiver URLs", async () => {
    const { receiver, client } = await loadReceiverModule();
    expect(receiver.companionPayloadFromLocation).toBeUndefined();
    expect(client.buildCompanionReceiverUrl).toBeUndefined();
    expect(client.parseCompanionPayload).toBeUndefined();
  });

  it("booting with ?companion= in the address bar creates no profile", async () => {
    const { profilesStore } = await loadReceiverModule();
    const app = readFileSync(join(webapp, "app.js"), "utf8");
    expect(app).not.toContain("redeemCompanionAndPersist");
    expect(profilesStore.getActiveCloudName()).toBeNull();
    expect(profilesStore.listCloudNames()).toEqual([]);
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
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
    expect(result.label).toBeUndefined();
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
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
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
    expect(slot.companionLabel).toBeUndefined();

    // api.js read-helpers see the new active session.
    expect(api.getPodBaseUrl()).toBe("https://home.alice.flagship.services");
    expect(api.getSessionToken()).toMatch(/^abcd1234ef56/);
  });

  it("refuses a redeem response that names a server on another apex, and stores nothing", async () => {
    const { receiver, profilesStore, api } = await loadReceiverModule();
    for (const other of [
      "https://home.alice.evil.example",
      "https://home.alice.evilflagship.services",
      "http://home.alice.flagship.services",
      "https://home.alice.flagship.services:8443",
      "https://home.alice.flagship.services/x",
    ]) {
      const fetchImpl = async () =>
        new Response(
          JSON.stringify({ companionSessionToken: "e".repeat(64), expiresAt: 9_999, podBaseUrl: other, username: "alice" }),
          { status: 200 },
        );
      const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, { fetchImpl });
      expect(result.error, other).toMatch(/won't connect/);
      expect(profilesStore.getActiveCloudName(), other).toBeNull();
      expect(profilesStore.listCloudNames(), other).toEqual([]);
    }
    expect(api.getSessionToken()).not.toMatch(/^e+$/);
  });

  it("never redeems a ticket whose server is off the data apex", async () => {
    const { receiver } = await loadReceiverModule();
    let called = 0;
    const fetchImpl = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const result = await receiver.redeemCompanionAndPersist(
      { ...VALID_PAYLOAD, podBaseUrl: "https://home.alice.evil.example" },
      { fetchImpl },
    );
    expect(result.error).toMatch(/won't connect/);
    expect(called).toBe(0);
  });

  it("persistCompanionSession applies the apex pin by itself", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const out = receiver.persistCompanionSession({
      companionSessionToken: "a".repeat(64),
      expiresAt: 1,
      podBaseUrl: "https://home.alice.evil.example",
      username: "alice",
    });
    expect(out.error).toMatch(/won't connect/);
    expect(profilesStore.listCloudNames()).toEqual([]);
    const gym = receiver.persistCompanionSession(
      { companionSessionToken: "a".repeat(64), expiresAt: 1, podBaseUrl: "https://Home.Alice.gym.flagship.services", username: "alice" },
      { apex: "gym.flagship.services" },
    );
    expect(gym.podBaseUrl).toBe("https://home.alice.gym.flagship.services");
  });

  it("returns { error } and does NOT mutate the active profile on a non-2xx response", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "ticket expired" }), { status: 410 });
    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
    });
    expect(result.error).toMatch(/ticket expired/);
    expect(result.status).toBe(410);
    // No active profile got set — receiver should be inert on failure.
    expect(profilesStore.getActiveCloudName()).toBeNull();
  });

  it("UX-B (B3) — a 5xx with no server message surfaces humanized copy, not `HTTP 500`", async () => {
    const { receiver } = await loadReceiverModule();
    const fetchImpl = async () => new Response("upstream exploded", { status: 500 });
    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
    });
    expect(result.status).toBe(500);
    // No raw `HTTP <code>` or stack text reaches the user.
    expect(result.error).not.toMatch(/HTTP \d/);
    expect(result.error).not.toContain("upstream exploded");
    // The static humanError() copy for a 5xx.
    expect(result.error).toMatch(/unavailable/i);
  });

  it("returns { error } on a malformed 200 response (missing sessionToken)", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ companionSessionToken: 42 }), { status: 200 });
    const result = await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, {
      fetchImpl,
    });
    expect(result.error).toMatch(/missing/);
    expect(profilesStore.getActiveCloudName()).toBeNull();
  });
});

describe("retireExpiredCompanionProfiles", () => {
  it("drops expired remote profiles, keeps live ones and owner profiles", async () => {
    const { receiver, profilesStore } = await loadReceiverModule();
    const ok = (token: string, expiresAt: number) => async () =>
      new Response(
        JSON.stringify({ companionSessionToken: token, expiresAt, podBaseUrl: VALID_PAYLOAD.podBaseUrl, username: "alice" }),
        { status: 200 },
      );
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, { fetchImpl: ok("live00000000" + "0".repeat(52), 2_000) });
    await receiver.redeemCompanionAndPersist(VALID_PAYLOAD, { fetchImpl: ok("dead00000000" + "0".repeat(52), 1_000) });
    profilesStore.ensureProfile("alice");
    profilesStore.ensureProfile("companion-broken");
    profilesStore.setActiveCloudName("companion-broken");
    profilesStore.set("kind", "companion");
    profilesStore.setActiveCloudName("companion-home.alice.flagship.services-dead00000000");

    const retired = receiver.retireExpiredCompanionProfiles(1_500);
    expect(retired.sort()).toEqual(["companion-broken", "companion-home.alice.flagship.services-dead00000000"]);
    expect(profilesStore.listCloudNames().sort()).toEqual(["alice", "companion-home.alice.flagship.services-live00000000"]);
    expect(profilesStore.getActiveCloudName()).not.toBe("companion-home.alice.flagship.services-dead00000000");
    expect(receiver.retireExpiredCompanionProfiles(1_500)).toEqual([]);
  });

  it("runs at boot", () => {
    const app = readFileSync(resolve(__dirname, "..", "public", "webapp", "app.js"), "utf8");
    expect(app).toMatch(/retireExpiredCompanionProfiles\(\)/);
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
    });
    expect(guard.isCompanionProfile()).toBe(true);
    expect(() => guard.requireOwnerProfile()).toThrow(/remote browser/i);
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

  it("disables the 'Update this server' button for a companion (honest UI)", async () => {
    const { receiver, guard } = await loadReceiverModule();
    // Fake just enough DOM: the update button + the companion banner.
    const btn: Record<string, unknown> & {
      attrs: Record<string, string>;
      setAttribute: (k: string, v: string) => void;
      getAttribute: (k: string) => string | null;
      removeAttribute: (k: string) => void;
      classList: { toggle: () => void };
    } = {
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      classList: { toggle: () => {} },
    };
    const inert = {
      classList: { toggle: () => {} },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
    };
    const doc = {
      getElementById: (id: string) => (id === "update-server-btn" ? btn : inert),
    };
    // Owner (no companion profile): the button is untouched.
    guard.applyCompanionUiRestrictions(doc);
    expect(btn.attrs["data-companion-unavailable"]).toBeUndefined();

    // Activate a companion session, then restrictions disable the button.
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
    });
    expect(guard.isCompanionProfile()).toBe(true);
    guard.applyCompanionUiRestrictions(doc);
    expect(btn.attrs["data-companion-unavailable"]).toBe("true");
    expect(btn.attrs["aria-disabled"]).toBe("true");
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
    ).rejects.toThrow(/remote browser/i);

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
        if (/remote browser/i.test(String((e as Error)?.message ?? e))) { wipeSaw = true; break; }
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
