import { describe, expect, it } from "vitest";
import { ed, signAccountDirectoryRequest, signDeviceCapabilityGrant, type DeviceCapabilityGrant, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { authorizeVoiciCallDevice } from "../src/voiciCalls.js";

const USER = "alice";
const NOW = 1_900_000_000_000;
const CALL = "0123456789abcdef0123456789abcdef";
const DEVICE_ID = "2e191c32602192218acdb115dac152f0";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function key(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

async function world() {
  const s = new InMemoryStorage();
  const adminRoot = key();
  const device = key();
  await s.usernames.put({ username: USER, irkPubHex: hex(key().publicKey), claimedAt: 1, adminRootPubHex: hex(adminRoot.publicKey) });
  await s.deviceIdentities.put({ accountId: USER, deviceId: DEVICE_ID, devicePubHex: hex(device.publicKey), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
  const grant: DeviceCapabilityGrant = { grantId: "g1", username: USER, deviceId: DEVICE_ID, devicePubKey: device.publicKey, scopes: ["admin"], issuedAt: NOW - 1000, expiresAt: NOW + 1e9 };
  await s.deviceCapabilityGrants.put({
    grantId: "g1", username: USER, deviceId: DEVICE_ID, devicePubHex: hex(device.publicKey), scopesJson: JSON.stringify(grant.scopes),
    issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, signatureHex: hex(signDeviceCapabilityGrant(grant, adminRoot)), revokedAt: null, signerRoot: "admin-root",
  });
  const claimed = new Set<string>();
  const deps = {
    usernames: s.usernames,
    grants: s.deviceCapabilityGrants,
    directory: { identities: s.deviceIdentities, nonces: { claim: async (k: string) => (claimed.has(k) ? false : (claimed.add(k), true)) }, now: () => NOW },
    now: () => NOW,
  };
  return { deps, device };
}

/** Signed exactly as the phones sign the room join (VoiciCallKeys.deviceHeaders, VoiciCallSession.kt). */
function phoneAuth(device: Keypair, requestId = "ffeeddccbbaa99887766554433221100") {
  const request = { accountId: USER, deviceId: DEVICE_ID, signerPubHex: hex(device.publicKey), method: "GET", path: `/api/voici/calls/${CALL}/device`, requestId, issuedAt: NOW };
  return { request, signature: signAccountDirectoryRequest(request, device) };
}

describe("an unlocked admin phone joins the call room with its device key", () => {
  it("is admitted (the signed path is a call route, not an account route)", async () => {
    const { deps, device } = await world();
    const refused: string[] = [];
    expect(await authorizeVoiciCallDevice(deps, USER, CALL, phoneAuth(device), (c) => refused.push(c))).not.toBeNull();
    expect(refused).toEqual([]);
  });

  it("names the failing check when refused", async () => {
    const { deps, device } = await world();
    const refused: string[] = [];
    await authorizeVoiciCallDevice(deps, USER, CALL, phoneAuth(key()), (c) => refused.push(c));
    expect(refused).toEqual(["device-signature"]);
    const auth = phoneAuth(device, "00112233445566778899aabbccddeeff");
    expect(await authorizeVoiciCallDevice(deps, USER, CALL, auth)).not.toBeNull();
    await authorizeVoiciCallDevice(deps, USER, CALL, auth, (c) => refused.push(c));
    expect(refused).toEqual(["device-signature", "device-signature"]);
  });
});
