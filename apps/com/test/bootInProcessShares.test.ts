import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { InProcessDirectoryClient } from "../src/bootInProcess.js";

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
