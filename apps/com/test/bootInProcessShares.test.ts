import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { InProcessDirectoryClient, InProcessNotifyPipe, SHARE_STARTUP_KIND, type ShareStartupPush } from "../src/bootInProcess.js";

const S = "home.alice.flagship.services";
const ID = "ab".repeat(16);
const MEMBER = "cd".repeat(32);

async function dir() {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: "ef".repeat(32), registeredAt: 1 });
  await storage.serverShares.create({
    shareId: ID,
    ownerUsername: "alice",
    serverDomain: S,
    tokenHash: "11".repeat(32),
    offerHex: "00",
    ownerHex: "00",
    createdAt: 1,
    expiresAt: 10,
  });
  const d = new InProcessDirectoryClient({
    servers: storage.servers,
    usernames: storage.usernames,
    watchDelegates: storage.watchDelegates,
    serverShares: storage.serverShares,
  });
  return { d, storage };
}

describe("InProcessNotifyPipe start-up notices for shares", () => {
  async function pipe() {
    const { storage } = await dir();
    const sent: ShareStartupPush[] = [];
    const owner: string[] = [];
    const p = new InProcessNotifyPipe({
      servers: storage.servers,
      pushUserDevices: async (username, category) => void owner.push(`${username}:${category}`),
      shareStartup: { shares: storage.serverShares, forward: async (args) => void sent.push(args) },
    });
    return { p, storage, sent, owner };
  }
  const register = (storage: InMemoryStorage) =>
    storage.serverShares.putPush(
      { shareId: ID, serverDomain: S, memberPubHex: MEMBER, tokenSha256: "77".repeat(32), platform: "apns", providerToken: "apns-token", registeredAt: 1 },
      10,
    );
  const unlockKey = { serverDomain: S, signedRequest: { request: { nonce: "AB" }, signature: "00" }, purpose: "unlock-key" };

  it("wakes the owner and each opted-in co-manager with no content, for a disk unlock only", async () => {
    const { p, storage, sent, owner } = await pipe();
    await storage.serverShares.putUnlock({ shareId: ID, serverDomain: S, memberPubHex: MEMBER, sealedKeyHex: "aa", depositJson: "{}", signatureHex: "bb", issuedAt: 1 });
    await register(storage);
    expect(await p.notifyOwner(unlockKey)).toBe(true);
    expect(owner).toEqual(["alice:secret-request"]);
    expect(sent).toHaveLength(1);
    const push = sent[0]!;
    expect(push.category).toBe("secret-request");
    expect(push.sealedPayloadHex).toBe("");
    expect(push.displayData).toEqual({ kind: SHARE_STARTUP_KIND });
    expect(push.targets).toEqual([expect.objectContaining({ platform: "apns", providerToken: "apns-token" })]);
    const web = JSON.parse(new TextDecoder().decode(push.webpushPayloadBytes)) as Record<string, unknown>;
    expect(Object.keys(web).sort()).toEqual(["body", "kind"]);
    expect(JSON.stringify(web)).not.toContain(S);

    await p.notifyOwner({ ...unlockKey, purpose: "entitlement" });
    expect(sent).toHaveLength(1);
    expect(owner).toHaveLength(2);
  });

  it("wakes nobody once the owner withdraws the copy or the share ends", async () => {
    const { p, storage, sent } = await pipe();
    await storage.serverShares.putUnlock({ shareId: ID, serverDomain: S, memberPubHex: MEMBER, sealedKeyHex: "aa", depositJson: "{}", signatureHex: "bb", issuedAt: 1 });
    await register(storage);
    await storage.serverShares.deleteUnlock(ID);
    await p.notifyOwner(unlockKey);
    expect(sent).toHaveLength(0);
    await storage.serverShares.putUnlock({ shareId: ID, serverDomain: S, memberPubHex: MEMBER, sealedKeyHex: "aa", depositJson: "{}", signatureHex: "bb", issuedAt: 1 });
    await register(storage);
    await storage.serverShares.end(ID, "leave", "{}", 5);
    await p.notifyOwner(unlockKey);
    expect(sent).toHaveLength(0);
  });
});

describe("InProcessDirectoryClient.shareUnlockForMember", () => {
  it("returns the copy a live share holds for a live server, and nothing once it ends", async () => {
    const { d, storage } = await dir();
    expect(await d.shareUnlockForMember(S, MEMBER)).toBeNull();
    await storage.serverShares.putUnlock({ shareId: ID, serverDomain: S, memberPubHex: MEMBER, sealedKeyHex: "aa", depositJson: "{}", signatureHex: "bb", issuedAt: 1 });
    expect(await d.shareUnlockForMember(S, MEMBER.toUpperCase())).toEqual({ sealedKeyHex: "aa" });
    expect(await d.shareUnlockForMember("other.alice.flagship.services", MEMBER)).toBeNull();
    await storage.servers.revoke(S, "test", 2);
    expect(await d.shareUnlockForMember(S, MEMBER)).toBeNull();
    await storage.servers.unrevoke(S);
    await storage.serverShares.end(ID, "revoke", "{}", 3);
    expect(await d.shareUnlockForMember(S, MEMBER)).toBeNull();
  });
});
