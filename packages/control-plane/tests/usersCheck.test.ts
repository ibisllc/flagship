// Unit tests for the /api/users/check handler.
//
// Two behaviors to pin:
//   1. Label rules + reserved-username allowlist
//   2. D1 claim lookup → "already claimed"

import { describe, expect, it } from "vitest";
import {
  handleUsersCheck,
  type UsersCheckResponse,
} from "../src/usersCheck.js";
import { caKeypairFromEnv } from "../src/pubkeyCert.js";
import { verifyDemoDirective } from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";

function fakeStorage(claimed: Record<string, string> = {}): UsernameStorage {
  return {
    async get(name: string) {
      const irkPub = claimed[name];
      return irkPub ? { username: name, irkPub, issuedAt: 1, signature: "00" } : undefined;
    },
    async put() { return { ok: true } as const; },
    async list() { return []; },
  } as unknown as UsernameStorage;
}

/** Storage whose `get` returns a proper UsernameRecord (with the
 *  isDemo flag) so the demo-directive branch can be exercised. */
function recordStorage(
  rows: Record<string, { isDemo?: boolean }>,
): UsernameStorage {
  return {
    async get(name: string) {
      const r = rows[name.toLowerCase()];
      return r
        ? { username: name.toLowerCase(), irkPubHex: "aa".repeat(32), claimedAt: 1, isDemo: !!r.isDemo }
        : undefined;
    },
    async put() { return { ok: true } as const; },
    async list() { return []; },
    async swapIrkPub() { return false; },
    async setDemo() { return true; },
  } as unknown as UsernameStorage;
}

describe("handleUsersCheck", () => {
  it("rejects malformed body", async () => {
    const r = await handleUsersCheck({ storage: fakeStorage() }, undefined);
    expect(r.status).toBe(400);
  });

  it("rejects reserved labels with available=false + reason", async () => {
    const r = await handleUsersCheck({ storage: fakeStorage() }, { username: "admin" });
    expect(r.status).toBe(200);
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/reserved/);
  });

  it("marks a fresh username available", async () => {
    const r = await handleUsersCheck({ storage: fakeStorage() }, { username: "harry" });
    expect((r.body as UsersCheckResponse).available).toBe(true);
  });

  it("accepts a hyphenated REAL username (interior dashes are valid now)", async () => {
    // Usernames now allow interior single dashes (the composite app id uses the
    // `--` delimiter — docs/service-addressing-double-dash.md), so a hyphenated
    // handle with no backing row is simply AVAILABLE, not a shape rejection.
    const r = await handleUsersCheck({ storage: fakeStorage() }, { username: "maria-jose" });
    expect(r.status).toBe(200);
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(true);
    expect(body.reason ?? "").not.toMatch(/no hyphens/i);
  });

  it("hyphenated DEMO username returns demoServer block before validateUserLabel rejection", async () => {
    // Bug fix: previously the validateUserLabel hyphen guard fired
    // BEFORE the demoUsers lookup, so /users/check for `demoalice`
    // would return `{available: false, reason: "no hyphens"}` even
    // though demo_users had a row for that username. Mobile demo-mode
    // never got the demoServer block and broke for every hyphenated
    // demo name. Fix: demoUsers / testAccounts lookup runs FIRST;
    // if either matches, return demo-aware response; only if neither
    // matches does validateUserLabel fire.
    const { InMemoryDemoUsersStorage } = await import("@flagship/storage");
    const demoUsers = new InMemoryDemoUsersStorage();
    await demoUsers.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1,
    });
    const r = await handleUsersCheck(
      { storage: fakeStorage(), demoUsers },
      { username: "demoalice" },
    );
    expect(r.status).toBe(200);
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(false);
    expect(body.demoServer).toBeDefined();
    expect(body.demoServer!.fqdn).toBe("home.demoalice.flagship.services");
    expect(body.reason).not.toMatch(/no hyphens/i);
  });

  it("accepts an all-alphanumeric username at the 30-char max", async () => {
    const u = "a".repeat(30);
    const r = await handleUsersCheck({ storage: fakeStorage() }, { username: u });
    expect((r.body as UsersCheckResponse).available).toBe(true);
  });

  it("rejects a username over 30 chars and one under 3 chars", async () => {
    const tooLong = await handleUsersCheck({ storage: fakeStorage() }, { username: "a".repeat(31) });
    expect((tooLong.body as UsersCheckResponse).available).toBe(false);
    const tooShort = await handleUsersCheck({ storage: fakeStorage() }, { username: "ab" });
    expect((tooShort.body as UsersCheckResponse).available).toBe(false);
  });

  it("returns taken=false + reason for a real existing claim", async () => {
    const r = await handleUsersCheck(
      { storage: fakeStorage({ harry: "deadbeef" }) },
      { username: "harry" },
    );
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(false);
    expect(body.reason).toBe("already claimed");
  });

  it("an is_demo claim carries a CA-signed demo directive (#84)", async () => {
    const ca = caKeypairFromEnv({});
    const r = await handleUsersCheck(
      { storage: recordStorage({ demo: { isDemo: true } }), ca, now: () => 1_000 },
      { username: "Demo" },
    );
    const body = r.body as UsersCheckResponse;
    // It is still a real claim.
    expect(body.available).toBe(false);
    expect(body.reason).toBe("already claimed");
    // …plus a verifiable directive.
    expect(body.demoDirective).toBeDefined();
    const { directive, signature } = body.demoDirective!;
    expect(directive.username).toBe("demo");
    expect(directive.useMockRecovery).toBe(true);
    expect(directive.issuedAt).toBe(1_000);
    expect(directive.expiresAt).toBeGreaterThan(directive.issuedAt);
    expect(directive.issuer).toBe(ca.issuer);
    const sigBytes = Uint8Array.from(
      signature.match(/../g)!.map((h) => parseInt(h, 16)),
    );
    expect(verifyDemoDirective(directive, sigBytes, ca.keypair.publicKey)).toBe(true);
  });

  it("a non-demo existing claim gets NO directive even with a CA wired", async () => {
    const ca = caKeypairFromEnv({});
    const r = await handleUsersCheck(
      { storage: recordStorage({ alice: { isDemo: false } }), ca },
      { username: "alice" },
    );
    expect((r.body as UsersCheckResponse).demoDirective).toBeUndefined();
  });

  it("an is_demo claim gets NO directive when no CA is wired (legacy path safe)", async () => {
    const r = await handleUsersCheck(
      { storage: recordStorage({ demo: { isDemo: true } }) },
      { username: "demo" },
    );
    const body = r.body as UsersCheckResponse;
    expect(body.reason).toBe("already claimed");
    expect(body.demoDirective).toBeUndefined();
  });

});

describe("public username privacy", () => {
  it("does not resolve dot-form device identities", async () => {
    const response = await handleUsersCheck(
      { storage: fakeStorage() },
      { username: "demoalice.reviewer" },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      username: "demoalice.reviewer",
      available: false,
      reason: "username must be 3–30 lowercase letters/digits with interior single dashes (no leading/trailing or double dash)",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/device|grant|ciphertext/i);
  });
});
