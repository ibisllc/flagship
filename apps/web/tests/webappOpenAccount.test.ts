import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadLib() {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "openAccount.js")).href);
}

function jsonResponse(status: number, body: unknown = "") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const deviceId = "00112233445566778899aabbccddeeff";

function harness(created = true) {
  const session = {
    umk: new Uint8Array(32).fill(9),
    irk: { publicKey: new Uint8Array(32).fill(2) },
    adminRootSeed: new Uint8Array(32).fill(7),
  };
  const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { created }));
  return {
    session,
    fetch,
    deps: {
      session,
      accountDisplayName: "Johnson Family",
      deviceDisplayName: "This browser",
      signWithIrk: vi.fn(async () => new Uint8Array(64).fill(1)),
      ensureAdminRoot: vi.fn(async () => "aa".repeat(32)),
      deriveAccountDeviceKeyFromSeed: vi.fn(async () => ({
        privateKey: {},
        publicKey: new Uint8Array(32).fill(3),
      })),
      deriveAccountIdFromSeed: vi.fn(async () => ({ publicKey: new Uint8Array(32).fill(4) })),
      signWithAdminRoot: vi.fn(async () => new Uint8Array(64).fill(5)),
      signWithDevice: vi.fn(async () => new Uint8Array(64).fill(6)),
      generateDeviceId: vi.fn(() => deviceId),
      randomUUID: vi.fn(() => "550e8400-e29b-41d4-a716-446655440000"),
      bytesToHex: toHex,
      fetch,
    },
  };
}

describe("webapp account bootstrap", () => {
  it("accepts only bare public routing usernames", async () => {
    const { isValidUsername } = await loadLib();
    expect(isValidUsername("jolly-ranger")).toBe(true);
    expect(isValidUsername("demo--alice")).toBe(false);
    expect(isValidUsername("Alice")).toBe(false);
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("a".repeat(31))).toBe(false);
  });

  it("publishes identity and encrypted profiles in one request", async () => {
    const { openAccount } = await loadLib();
    const { deps, fetch, session } = harness();
    const local: Record<string, any> = {};
    const out = await openAccount("jolly-ranger", {
      ...deps,
      setUsername: vi.fn((username) => { local.username = username; }),
      addProfile: vi.fn((profile) => { local.profile = profile; }),
      dispatchInitialView: vi.fn(async () => { local.dispatched = true; }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toMatch(/^https:\/\/[^/]+\/api\/accounts$/);
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request.claim.request).toMatchObject({
      username: "jolly-ranger",
      irkPub: toHex(session.irk.publicKey),
    });
    expect(request.device).toEqual({ deviceId, devicePubHex: "03".repeat(32), platformClass: "web" });
    expect(request.grant.scopes).toContain("view-directory");
    expect(request.accountProfile.signatureHex).toBe("05".repeat(64));
    expect(request.deviceProfile.signatureHex).toBe("06".repeat(64));
    expect(fetch.mock.calls[0]![1].body).not.toContain("Johnson Family");
    expect(fetch.mock.calls[0]![1].body).not.toContain("This browser");
    expect(local.profile).toMatchObject({
      cloudName: "jolly-ranger",
      accountId: "jolly-ranger",
      deviceId,
      accountDisplayName: "Johnson Family",
      deviceDisplayName: "This browser",
    });
    expect(local.dispatched).toBe(true);
    expect(out).toEqual({ username: "jolly-ranger", alreadyClaimed: false, deviceId });
  });

  it("treats an exact server-side replay as idempotent", async () => {
    const { openAccount } = await loadLib();
    const { deps } = harness(false);
    await expect(openAccount("jolly-ranger", deps)).resolves.toMatchObject({ alreadyClaimed: true });
  });

  it("validates both private names before any network request", async () => {
    const { openAccount } = await loadLib();
    const { deps, fetch } = harness();
    await expect(openAccount("jolly-ranger", { ...deps, accountDisplayName: "bad\nname" }))
      .rejects.toThrow(/control character/);
    await expect(openAccount("jolly-ranger", { ...deps, deviceDisplayName: "" }))
      .rejects.toThrow(/must not be empty/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses bootstrap without an unlocked device identity", async () => {
    const { openAccount } = await loadLib();
    const { deps, fetch } = harness();
    await expect(openAccount("jolly-ranger", { ...deps, session: { umk: null, irk: null } }))
      .rejects.toThrow(/device key/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
