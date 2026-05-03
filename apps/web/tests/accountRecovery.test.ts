import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  deriveIRK,
  deriveSWK,
  deriveSTK,
  signAccountRecovery,
  type AccountRecovery,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryServerRegistry,
} from "../src/routes/serverRegistry.js";
import {
  InMemoryPushTokenStore,
} from "../src/routes/pushRelay.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const harryStk = deriveSTK(deriveSWK(harryUmk, "srv-1"));

const sarahUmk = { seed: new Uint8Array(32).fill(22) };
const sarahIrk = deriveIRK(sarahUmk);

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSignedRecovery(
  pushToken: string,
  over: Partial<AccountRecovery> = {},
  signer = harryIrk,
) {
  const newPushTokenHash = sha256(new TextEncoder().encode(pushToken));
  const claim: AccountRecovery = {
    userId: over.userId ?? "harry",
    newPushTokenHash,
    platform: over.platform ?? "apns",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      userId: claim.userId,
      newPushTokenHash: bytesToHex(claim.newPushTokenHash),
      platform: claim.platform,
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signAccountRecovery(claim, signer)),
    pushToken,
  };
}

function makeApp(extra: { revokeAll?: () => number } = {}) {
  void extra;
  const registry = new InMemoryServerRegistry();
  const pushTokenStore = new InMemoryPushTokenStore();
  registry.put({
    userId: "harry",
    serverId: "srv-1",
    stkPub: harryStk.publicKey,
    registeredAt: Date.now(),
  });
  const app = buildServer({
    serverRegistry: registry,
    pushTokenStore,
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  return { app, registry, pushTokenStore };
}

describe("/api/account/recovery", () => {
  it("rotates the push token, returns the user's server list, and verifies signature", async () => {
    const { app, pushTokenStore } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload: buildSignedRecovery("new-apns-token-XYZ"),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].serverId).toBe("srv-1");
    expect(pushTokenStore.getByIrk(bytesToHex(harryIrk.publicKey))?.pushToken).toBe(
      "new-apns-token-XYZ",
    );
  });

  it("rejects when the supplied pushToken does not match newPushTokenHash", async () => {
    const { app } = makeApp();
    const payload = buildSignedRecovery("token-A");
    payload.pushToken = "token-DIFFERENT";
    const r = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a forged signature (different IRK)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload: buildSignedRecovery("tk", { userId: "harry" }, sarahIrk),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects unknown users with 404", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload: buildSignedRecovery("tk", { userId: "ghost" }),
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects stale claims (issuedAt outside the replay window)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload: buildSignedRecovery("tk", { issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects malformed bodies (missing fields, bad hex)", async () => {
    const { app } = makeApp();
    const bad = await app.inject({
      method: "POST",
      url: "/api/account/recovery",
      payload: { request: { userId: "harry" }, signature: "00", pushToken: "tk" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
