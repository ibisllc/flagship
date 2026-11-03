import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { InProcessDirectoryClient } from "../src/bootInProcess.js";

// The owner IRK is found from the account label under the services apex. The gym's boxes sit under
// gym.flagship.services; read under the default apex, `home.bob.gym.flagship.services` is account "gym"
// and every owner answer to a gym box's start-up was "unknown server" (live lane boot-chain-refresh).
describe("InProcessDirectoryClient under a non-default services apex", () => {
  async function client(apex?: string) {
    const storage = new InMemoryStorage();
    await storage.usernames.put({ username: "bob", irkPubHex: "AA".repeat(32), claimedAt: 1 });
    await storage.servers.put({ serverDomain: "home.bob.gym.flagship.services", username: "bob", identityPubKeyHex: "bb".repeat(32), registeredAt: 1 });
    return new InProcessDirectoryClient({
      servers: storage.servers,
      usernames: storage.usernames,
      watchDelegates: storage.watchDelegates,
      ...(apex ? { apex } : {}),
    });
  }

  it("finds the owner's IRK when given the apex the boxes live under", async () => {
    expect(await (await client("gym.flagship.services")).ownerIrkForDomain("home.bob.gym.flagship.services")).toBe("aa".repeat(32));
  });

  it("finds no owner under the default apex (why the route must pass SERVICES_APEX)", async () => {
    expect(await (await client()).ownerIrkForDomain("home.bob.gym.flagship.services")).toBeNull();
  });
});
