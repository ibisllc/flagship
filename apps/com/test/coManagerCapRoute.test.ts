/**
 * The co-manager cap's `.com` backstop through the Worker's own route: the
 * share-offer route reads the account's plan from D1 and refuses a new link
 * once the open links and live shares reach it (packages/protocol/src/
 * coManagerCap.ts).
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  deriveIRK,
  SHARE_OFFER_TTL_MS,
  shareSha256Hex,
  shareTokenFromSecret,
  shareTokenHash,
  signServerShareOffer,
  type ServerShareOffer,
} from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const S = "home.alice.flagship.services";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function setup(tier?: "hobby") {
  const sqlite = createSqliteD1();
  const storage = new D1Storage(sqlite as unknown as D1Database);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: "cd".repeat(32), registeredAt: 1 });
  if (tier) await storage.tiers.put({ username: "alice", tier, currentPeriodEnd: Date.now() + 1e9, updatedAt: Date.now() });
  const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };
  return { env, close: () => sqlite.close() };
}

async function offer(env: ControlPlaneEnv, i: number) {
  const now = Date.now();
  const offerHex = "01".repeat(40);
  const ownerHex = "02".repeat(40);
  const o: ServerShareOffer = {
    username: "alice",
    serverDomain: S,
    shareId: i.toString(16).padStart(32, "0"),
    tokenHash: shareTokenHash(shareTokenFromSecret(new Uint8Array(32).fill(i))),
    offerSha256: shareSha256Hex(offerHex),
    ownerSha256: shareSha256Hex(ownerHex),
    expiresAt: now + SHARE_OFFER_TTL_MS,
    issuedAt: now,
  };
  const res = await tryControlPlane(
    new Request(`${ORIGIN}/api/users/alice/server-shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: o, signature: hex(signServerShareOffer(o, irk)), offerHex, ownerHex }),
    }),
    env,
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

describe("co-manager cap on the share-offer route", () => {
  it("refuses the sixth link of a Free account with the coded refusal", async () => {
    const { env, close } = await setup();
    try {
      for (let i = 1; i <= 5; i++) expect((await offer(env, i)).status).toBe(200);
      const r = await offer(env, 6);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "co-manager-cap", count: 5, cap: 5, plan: "free" });
    } finally {
      close();
    }
  });

  it("gives a Pro account ten", async () => {
    const { env, close } = await setup("hobby");
    try {
      for (let i = 1; i <= 10; i++) expect((await offer(env, i)).status).toBe(200);
      expect((await offer(env, 11)).body).toMatchObject({ code: "co-manager-cap", cap: 10, plan: "hobby" });
    } finally {
      close();
    }
  });
});
