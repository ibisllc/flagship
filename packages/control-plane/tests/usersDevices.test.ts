import { describe, expect, it } from "vitest";
import { InMemoryPushTokenStorage } from "@flagship/storage";
import {
  computeDevicesEtag,
  handleGetUsersDevices,
  type DeviceSummary,
  type UsersDevicesResponse,
} from "../src/usersDevices.js";

function makeStore() {
  return new InMemoryPushTokenStorage();
}

async function seed(
  s: InMemoryPushTokenStorage,
  username: string,
  rows: Array<{ tokenId: string; label: string; platform: "apns" | "fcm" | "webpush"; addedAt: number; lastSeenAt?: number }>,
) {
  for (const r of rows) {
    await s.put({
      tokenId: r.tokenId,
      username,
      platform: r.platform,
      providerToken: `provider-${r.tokenId}`,
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: r.label,
      registeredAt: r.addedAt,
      lastSeenAt: r.lastSeenAt ?? r.addedAt,
    });
  }
}

describe("GET /api/users/:u/devices", () => {
  it("returns an empty list + a stable ETag for a user with no devices", async () => {
    const s = makeStore();
    const r = await handleGetUsersDevices({ pushTokens: s }, "alice");
    expect(r.status).toBe(200);
    const body = r.body as UsersDevicesResponse;
    expect(body.devices).toEqual([]);
    expect(r.headers?.etag).toMatch(/^W\/".+"$/);
  });

  it("returns each device with platform, label, addedAt, lastSeenAt, tokenPrefix", async () => {
    const s = makeStore();
    await seed(s, "harry", [
      { tokenId: "ab12cd340000000000000000", label: "Harry's iPhone", platform: "apns", addedAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000 },
    ]);
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices.length).toBe(1);
    const d = body.devices[0]!;
    expect(d).toMatchObject({
      tokenId: "ab12cd340000000000000000",
      tokenPrefix: "ab12cd34",
      label: "Harry's iPhone",
      platform: "apns",
      addedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_100_000_000,
    });
  });

  it("renders an 'Untitled <platform>' fallback for rows with an empty label", async () => {
    const s = makeStore();
    await seed(s, "harry", [
      { tokenId: "11", label: "",        platform: "apns", addedAt: 1 },
      { tokenId: "22", label: "Tagged",  platform: "fcm",  addedAt: 2 },
    ]);
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices.map((d) => d.label)).toEqual(["Untitled apns", "Tagged"]);
  });

  it("sorts by addedAt ascending (deterministic for ETag)", async () => {
    const s = makeStore();
    await seed(s, "harry", [
      { tokenId: "z", label: "Third", platform: "apns", addedAt: 30 },
      { tokenId: "a", label: "First", platform: "apns", addedAt: 10 },
      { tokenId: "m", label: "Second", platform: "apns", addedAt: 20 },
    ]);
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices.map((d) => d.label)).toEqual(["First", "Second", "Third"]);
  });

  it("ETag is stable across calls when no data changed", async () => {
    const s = makeStore();
    await seed(s, "harry", [
      { tokenId: "ab", label: "iPhone", platform: "apns", addedAt: 100 },
      { tokenId: "cd", label: "iPad",   platform: "apns", addedAt: 200 },
    ]);
    const a = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const b = await handleGetUsersDevices({ pushTokens: s }, "harry");
    expect(a.headers?.etag).toBe(b.headers?.etag);
  });

  it("ETag changes when a new device is registered", async () => {
    const s = makeStore();
    await seed(s, "harry", [{ tokenId: "ab", label: "iPhone", platform: "apns", addedAt: 1 }]);
    const before = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    await seed(s, "harry", [{ tokenId: "cd", label: "iPad", platform: "apns", addedAt: 2 }]);
    const after = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    expect(after).not.toBe(before);
  });

  it("ETag changes when a device is removed", async () => {
    const s = makeStore();
    await seed(s, "harry", [
      { tokenId: "ab", label: "iPhone", platform: "apns", addedAt: 1 },
      { tokenId: "cd", label: "iPad",   platform: "apns", addedAt: 2 },
    ]);
    const before = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    await s.remove("cd");
    const after = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    expect(after).not.toBe(before);
  });

  it("ETag does NOT change when only lastSeenAt updates (push-delivery activity)", async () => {
    // The whole point of excluding lastSeenAt from the ETag: a fresh
    // push delivery updates lastSeenAt but the device list is
    // identity-stable. If the ETag fluttered, every revoke request
    // mid-push would race-fail.
    const s = makeStore();
    await seed(s, "harry", [{ tokenId: "ab", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 5 }]);
    const before = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    await s.touchLastSeen("ab", 999);
    const after = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    expect(after).toBe(before);
  });

  it("ETag changes when label rotates", async () => {
    const s = makeStore();
    await seed(s, "harry", [{ tokenId: "ab", label: "First", platform: "apns", addedAt: 1 }]);
    const before = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    await seed(s, "harry", [{ tokenId: "ab", label: "Renamed", platform: "apns", addedAt: 1 }]);
    const after = (await handleGetUsersDevices({ pushTokens: s }, "harry")).headers?.etag;
    expect(after).not.toBe(before);
  });

  it("rejects malformed usernames with 400", async () => {
    const s = makeStore();
    const r = await handleGetUsersDevices({ pushTokens: s }, "Has Spaces!");
    expect(r.status).toBe(400);
  });

  it("attaches a private, no-cache header so a CDN doesn't fan it out across users", async () => {
    const s = makeStore();
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    expect(r.headers?.["cache-control"]).toContain("private");
    expect(r.headers?.["cache-control"]).toContain("no-cache");
  });

  it("does not leak tokens for other users", async () => {
    const s = makeStore();
    await seed(s, "harry", [{ tokenId: "h1", label: "Harry", platform: "apns", addedAt: 1 }]);
    await seed(s, "alice", [{ tokenId: "a1", label: "Alice", platform: "apns", addedAt: 1 }]);
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices.map((d) => d.tokenId)).toEqual(["h1"]);
  });

  it("computeDevicesEtag returns a W/-prefixed weak ETag in the right format", async () => {
    const sample: DeviceSummary[] = [
      { tokenId: "ab", tokenPrefix: "ab", label: "Test", platform: "apns", addedAt: 1, lastSeenAt: 2 },
    ];
    const etag = await computeDevicesEtag(sample);
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });

  // v1.2 Phase 4 — UI needs the quarantine window so the
  // "freshly-admitted device" row can render the clock icon +
  // disable Remove/Replace until the 14-day grace expires.
  it("surfaces quarantineUntil when the row has one", async () => {
    const s = makeStore();
    const future = Date.now() + 7 * 86_400_000;
    await s.put({
      tokenId: "qq",
      username: "harry",
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "New iPhone",
      registeredAt: 100,
      lastSeenAt: 200,
      quarantineUntil: future,
    });
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices[0]!.quarantineUntil).toBe(future);
  });

  it("omits quarantineUntil when the row is already-trusted (0 / absent)", async () => {
    const s = makeStore();
    await seed(s, "harry", [{ tokenId: "ok", label: "Old", platform: "apns", addedAt: 1 }]);
    const r = await handleGetUsersDevices({ pushTokens: s }, "harry");
    const body = r.body as UsersDevicesResponse;
    expect(body.devices[0]!.quarantineUntil).toBeUndefined();
  });
});
