import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  encryptProfile,
} from "../public/webapp/lib/accountMetadata.js";

const load = () => import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "lib", "accountDirectory.js")).href);
const accountId = "jolly-ranger";
const deviceId = "00112233445566778899aabbccddeeff";
const session = { umk: new Uint8Array(32).fill(9) };
const profile = { accountId, deviceId };

describe("web account directory client", () => {
  it("signs reads and decrypts effective names locally", async () => {
    const account = await encryptProfile("Johnson Family", await deriveAccountProfileKey(session.umk), {
      accountId, recordType: "account-profile", revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(1),
    });
    const self = await encryptProfile("Erica", await deriveDeviceDirectoryKey(session.umk), {
      accountId, deviceId, recordType: "device-self-profile", revision: 1, keyVersion: 1, nonce: new Uint8Array(12).fill(2),
    });
    const fetch = vi.fn(async (_url, init) => new Response(JSON.stringify({
      accountId,
      accountProfile: { ...account, accountId, revision: 1, keyVersion: 1 },
      devices: [{ accountId, deviceId, devicePubHex: "03".repeat(32), platformClass: "web", supportCode: "ABCD-EFGH" }],
      grants: [{ deviceId, scopesJson: '["admin","view-directory"]' }],
      selfProfiles: [{ ...self, accountId, deviceId, revision: 1, keyVersion: 1 }],
      managedProfiles: [],
    }), { status: 200 }));
    const { fetchDecryptedDirectory } = await load();
    const out = await fetchDecryptedDirectory({
      session,
      profile,
      fetch,
      baseUrl: "https://example.test",
      deriveDeviceKey: async () => ({ privateKey: {}, publicKey: new Uint8Array(32).fill(3) }),
      signDevice: async () => new Uint8Array(64).fill(4),
    });
    expect(out.accountDisplayName).toBe("Johnson Family");
    expect(out.devices[0]).toMatchObject({ displayName: "Erica", isCurrent: true, supportCode: "ABCD-EFGH" });
    const init = fetch.mock.calls[0]![1];
    expect(init.headers["x-flagship-device-id"]).toBe(deviceId);
    expect(init.headers["x-flagship-signature"]).toBe("04".repeat(64));
  });

  it("falls back to opaque presentation when decryption fails", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      accountId,
      accountProfile: null,
      devices: [{ accountId, deviceId, devicePubHex: "03".repeat(32), platformClass: "ios", supportCode: "ABCD-EFGH" }],
      grants: [], selfProfiles: [], managedProfiles: [],
    }), { status: 200 }));
    const { fetchDecryptedDirectory } = await load();
    const out = await fetchDecryptedDirectory({
      session, profile, fetch, baseUrl: "https://example.test",
      deriveDeviceKey: async () => ({ privateKey: {}, publicKey: new Uint8Array(32).fill(3) }),
      signDevice: async () => new Uint8Array(64),
    });
    expect(out.accountDisplayName).toBeNull();
    expect(out.devices[0].displayName).toBeNull();
  });
});
