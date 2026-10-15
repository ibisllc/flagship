/**
 * The allowance read (#6 dashboard / #7 alert) and the purchases list are
 * account metadata, gated by the account's read token like /pods
 * (docs/account-read-token.md).
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { ACCOUNT_READ_TOKEN_LABEL, deriveIRK, signDeviceEndpointClaim } from "@flagship/protocol";

const ORIGIN = "https://flagshipserver.com";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function irkBody() {
  const now = Date.now();
  const claim = {
    username: "alice",
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: irk.publicKey,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  return {
    auth: { ...claim, phoneIrkPub: hex(claim.phoneIrkPub), nonce: hex(claim.nonce) },
    authSignature: hex(signDeviceEndpointClaim(claim, irk)),
  };
}

describe("GET /api/users/<u>/allowance and /purchases", () => {
  it("refuses without the account's read token and answers with it", async () => {
    const sqlite = createSqliteD1();
    try {
      const storage = new D1Storage(sqlite as unknown as D1Database);
      await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1 });
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, ACCOUNT_READ_TOKEN_SECRET: "route-secret" };

      const bare = await tryControlPlane(new Request(`${ORIGIN}/api/users/alice/allowance`), env);
      expect(bare!.status).toBe(401);

      const minted = await tryControlPlane(
        new Request(`${ORIGIN}/api/accounts/alice/read-token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(irkBody()),
        }),
        env,
      );
      const { token } = (await minted!.json()) as { token: string };
      const r = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/allowance`, { headers: { authorization: `Bearer ${token}` } }),
        env,
      );
      expect(r!.status).toBe(200);
      expect(r!.headers.get("cache-control")).toBe("private, no-store");
      expect(await r!.json()).toMatchObject({ ok: true, username: "alice", tier: "free", usedBytes: 0, state: "ok" });

      expect((await tryControlPlane(new Request(`${ORIGIN}/api/users/alice/purchases`), env))!.status).toBe(401);
      const owned = await tryControlPlane(
        new Request(`${ORIGIN}/api/users/alice/purchases`, { headers: { authorization: `Bearer ${token}` } }),
        env,
      );
      expect(owned!.status).toBe(200);
      expect(await owned!.json()).toMatchObject({ ok: true, purchases: [] });
    } finally {
      sqlite.close();
    }
  });
});
