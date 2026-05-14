// Unit tests for the /api/users/check handler.
//
// Three behaviors to pin:
//   1. Label rules + reserved-username allowlist
//   2. D1 claim lookup → "already claimed"
//   3. Test-account env-secret hit → testAccount block in response

import { describe, expect, it } from "vitest";
import {
  handleUsersCheck,
  parseTestAccountsEnv,
  type UsersCheckResponse,
} from "../src/usersCheck.js";
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
    expect(body.testAccount).toBeUndefined();
  });

  it("marks a fresh username available", async () => {
    const r = await handleUsersCheck({ storage: fakeStorage() }, { username: "harry" });
    expect((r.body as UsersCheckResponse).available).toBe(true);
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

  it("returns testAccount metadata when the username is in the secret", async () => {
    const r = await handleUsersCheck(
      {
        storage: fakeStorage(),
        testAccounts: { "playreview-q2": { display: "Play Reviewer (Q2)", ttlHours: 6 } },
      },
      { username: "playreview-q2" },
    );
    const body = r.body as UsersCheckResponse;
    expect(body.available).toBe(false);
    expect(body.testAccount).toEqual({ display: "Play Reviewer (Q2)", ttlHours: 6 });
  });

  it("does NOT leak the full test-account list", async () => {
    const r = await handleUsersCheck(
      {
        storage: fakeStorage(),
        testAccounts: {
          "playreview-q2": { display: "Play Reviewer (Q2)", ttlHours: 6 },
          "internal-tester": { display: "Internal", ttlHours: 24 },
        },
      },
      { username: "harry" },
    );
    const body = r.body as UsersCheckResponse;
    expect(body.testAccount).toBeUndefined();
    expect(body.available).toBe(true);
    // No reference to either configured test-account name in the body.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("playreview");
    expect(serialized).not.toContain("internal-tester");
  });

  it("is case-insensitive on the username", async () => {
    const r = await handleUsersCheck(
      {
        storage: fakeStorage(),
        testAccounts: { "playreview-q2": { display: "Play Reviewer", ttlHours: 6 } },
      },
      { username: "PlayReview-Q2" },
    );
    expect((r.body as UsersCheckResponse).testAccount?.display).toBe("Play Reviewer");
  });
});

describe("parseTestAccountsEnv", () => {
  it("returns null on missing or non-string input", () => {
    expect(parseTestAccountsEnv(undefined)).toBeNull();
    expect(parseTestAccountsEnv("")).toBeNull();
    expect(parseTestAccountsEnv(null)).toBeNull();
    expect(parseTestAccountsEnv(42)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseTestAccountsEnv("{not json")).toBeNull();
  });

  it("parses a valid object", () => {
    const m = parseTestAccountsEnv(JSON.stringify({
      "play-q2": { display: "Play Q2", ttlHours: 6 },
    }));
    expect(m).toEqual({ "play-q2": { display: "Play Q2", ttlHours: 6 } });
  });

  it("lowercases keys + defaults ttlHours when missing", () => {
    const m = parseTestAccountsEnv(JSON.stringify({
      "PLAY-Q2": { display: "Play Q2" },
    }));
    expect(m).toEqual({ "play-q2": { display: "Play Q2", ttlHours: 24 } });
  });

  it("skips malformed entries (no display)", () => {
    const m = parseTestAccountsEnv(JSON.stringify({
      "good": { display: "OK", ttlHours: 6 },
      "bad": { ttlHours: 6 },
    }));
    expect(m).toEqual({ "good": { display: "OK", ttlHours: 6 } });
  });
});
