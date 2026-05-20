import { beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import * as OTPAuth from "otpauth";
import {
  _resetTotpVerifyRateLimitForTests,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
  handleTotpVerify,
} from "../src/totp.js";

const USERNAME = "alice";
const TEST_KEK_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Set up a multi-device user with TOTP enrolled. Returns the storage,
 * the base32 secret, and the fixed clock used during enrollment so the
 * test can mint codes relative to a known epoch.
 */
async function setupEnrolled(): Promise<{
  storage: InMemoryStorage;
  secretBase32: string;
  fixedNow: number;
}> {
  const irk = makeKey();
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
    accountType: "single",
  });
  const fixedNow = 1_700_000_000_000;
  const begin = await handleTotpEnrollBegin(
    { usernames: storage.usernames, kekHex: TEST_KEK_HEX, now: () => fixedNow },
    USERNAME,
    {
      request: { username: USERNAME, issuedAt: fixedNow },
      signature: bytesToHex(
        signTotpEnrollBegin({ username: USERNAME, issuedAt: fixedNow }, irk),
      ),
    },
  );
  const secretBase32 = (begin.body as { secret: string }).secret;
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const sample = totp.generate({ timestamp: fixedNow });
  const confirm = await handleTotpEnrollConfirm(
    {
      usernames: storage.usernames,
      kekHex: TEST_KEK_HEX,
      now: () => fixedNow,
      fastHash: true,
    },
    USERNAME,
    {
      request: { username: USERNAME, issuedAt: fixedNow },
      signature: bytesToHex(
        signTotpEnrollConfirm({ username: USERNAME, issuedAt: fixedNow }, irk),
      ),
      code: sample,
    },
  );
  expect(confirm.status).toBe(200);
  return { storage, secretBase32, fixedNow };
}

function codeAt(secretBase32: string, t: number): string {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: t });
}

describe("TOTP verify", () => {
  beforeEach(() => {
    _resetTotpVerifyRateLimitForTests();
  });

  it("accepts a valid live TOTP code", async () => {
    const { storage, secretBase32, fixedNow } = await setupEnrolled();
    const res = await handleTotpVerify(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      { code: codeAt(secretBase32, fixedNow) },
    );
    expect(res.status).toBe(200);
    expect((res.body as { valid: boolean }).valid).toBe(true);
    expect((res.body as { method: string }).method).toBe("totp");
  });

  it("rejects an invalid TOTP code (401)", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    const res = await handleTotpVerify(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      { code: "000000" },
    );
    expect(res.status).toBe(401);
    expect((res.body as { valid: boolean }).valid).toBe(false);
  });

  it("rejects a TOTP code whose clock-skew exceeds the ±1 period window", async () => {
    // Code is generated 90 seconds (3 periods) in the past — outside
    // the ±1 period window.
    const { storage, secretBase32, fixedNow } = await setupEnrolled();
    const staleCode = codeAt(secretBase32, fixedNow - 90_000);
    const res = await handleTotpVerify(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      { code: staleCode },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a TOTP code from the previous period (within ±1 window)", async () => {
    const { storage, secretBase32, fixedNow } = await setupEnrolled();
    // 25s in the past — same period or the previous one, definitely
    // inside the ±1 window.
    const slightlyOldCode = codeAt(secretBase32, fixedNow - 25_000);
    const res = await handleTotpVerify(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      { code: slightlyOldCode },
    );
    expect(res.status).toBe(200);
  });

  it("returns 429 after 5 failed attempts inside 15 min", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    const deps = {
      usernames: storage.usernames,
      kekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    for (let i = 0; i < 5; i++) {
      const r = await handleTotpVerify(deps, USERNAME, { code: "000000" });
      expect(r.status).toBe(401);
    }
    const tripped = await handleTotpVerify(deps, USERNAME, { code: "000000" });
    expect(tripped.status).toBe(429);
    expect((tripped.body as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("rolls the counter window after 15 min", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    // Burn the limit.
    for (let i = 0; i < 5; i++) {
      await handleTotpVerify(
        { usernames: storage.usernames, kekHex: TEST_KEK_HEX, now: () => fixedNow },
        USERNAME,
        { code: "000000" },
      );
    }
    // 15 min + 1ms later, fresh attempt allowed.
    const later = fixedNow + 15 * 60_000 + 1;
    const res = await handleTotpVerify(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX, now: () => later },
      USERNAME,
      { code: "000000" },
    );
    expect(res.status).toBe(401);
  });

  it("verify does NOT consume the recovery code (side-effect-free)", async () => {
    // We can't synthesize a recovery code without going through
    // enroll-confirm, so we use a full enrolled user.
    const irk = makeKey();
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(irk.publicKey),
      claimedAt: 1,
      accountType: "single",
    });
    const fixedNow = 1_700_000_000_000;
    const beginRes = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX, now: () => fixedNow },
      USERNAME,
      {
        request: { username: USERNAME, issuedAt: fixedNow },
        signature: bytesToHex(
          signTotpEnrollBegin({ username: USERNAME, issuedAt: fixedNow }, irk),
        ),
      },
    );
    const secret = (beginRes.body as { secret: string }).secret;
    const confirmRes = await handleTotpEnrollConfirm(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
        fastHash: true,
      },
      USERNAME,
      {
        request: { username: USERNAME, issuedAt: fixedNow },
        signature: bytesToHex(
          signTotpEnrollConfirm(
            { username: USERNAME, issuedAt: fixedNow },
            irk,
          ),
        ),
        code: codeAt(secret, fixedNow),
      },
    );
    const codes = (confirmRes.body as { recoveryCodes: string[] }).recoveryCodes;
    const sampleCode = codes[0] as string;
    const before = await storage.usernames.get(USERNAME);
    const codesBeforeJson = before?.recoveryCodesHashesJson;
    const res = await handleTotpVerify(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      { code: sampleCode },
    );
    expect(res.status).toBe(200);
    expect((res.body as { method: string }).method).toBe("recovery");
    // Row is unchanged — verify must NOT consume.
    const after = await storage.usernames.get(USERNAME);
    expect(after?.recoveryCodesHashesJson).toBe(codesBeforeJson);
  });

  it("returns 503 when KEK is unset", async () => {
    const { storage } = await setupEnrolled();
    const res = await handleTotpVerify(
      { usernames: storage.usernames },
      USERNAME,
      { code: "000000" },
    );
    expect(res.status).toBe(503);
  });

  // ──────────────────────────────────────────────────────────────
  // v1.2 Plan B Phase 5 — failed-TOTP-rate alert
  // ──────────────────────────────────────────────────────────────

  it("Phase 5: fires the failed-rate push + audit row exactly once per 15-min window when the verify counter crosses the limit", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    // Seed two registered push tokens so the fan-out has targets.
    await storage.pushTokens.put({
      tokenId: "devA",
      username: USERNAME,
      platform: "apns",
      providerToken: "providerA",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    await storage.pushTokens.put({
      tokenId: "devB",
      username: USERNAME,
      platform: "fcm",
      providerToken: "providerB",
      pushX25519PubHex: "02".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "Pixel",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: Array<{ username: string; category: string; targetCount: number }> = [];
    const deps = {
      usernames: storage.usernames,
      pushTokens: storage.pushTokens,
      auditEvents: storage.auditEvents,
      kekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    const fanout = async ({
      username,
      targets,
      payload,
    }: {
      username: string;
      targets: Array<{ tokenId: string }>;
      payload: { category: string };
    }) => {
      fires.push({ username, category: payload.category, targetCount: targets.length });
    };
    // 5 failures — only on the 5th does the alert fire (boundary).
    for (let i = 0; i < 5; i++) {
      const r = await handleTotpVerify(deps, USERNAME, { code: "000000" }, fanout);
      expect(r.status).toBe(401);
    }
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe("totp-failed-rate");
    expect(fires[0]!.targetCount).toBe(2);
    // Audit row was written.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.filter((e) => e.eventKind === "totp-failed-rate")).toHaveLength(1);
    expect(events[0]?.accountTypeAtEvent).toBe("multi");
  });

  it("Phase 5: subsequent failures inside the same window do NOT re-fire the alert", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    await storage.pushTokens.put({
      tokenId: "trusted",
      username: USERNAME,
      platform: "apns",
      providerToken: "providerTrust",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: number[] = [];
    const deps = {
      usernames: storage.usernames,
      pushTokens: storage.pushTokens,
      auditEvents: storage.auditEvents,
      kekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    const fanout = async () => {
      fires.push(1);
    };
    // Burn through 5 failed attempts to trip the limit + fire ONCE.
    for (let i = 0; i < 5; i++) {
      await handleTotpVerify(deps, USERNAME, { code: "000000" }, fanout);
    }
    // 6th request hits the 429 (so the failed-rate slot isn't even
    // re-claimed); 5th already fired the alert.
    expect(fires).toHaveLength(1);
    const r = await handleTotpVerify(deps, USERNAME, { code: "000000" }, fanout);
    expect(r.status).toBe(429);
    expect(fires).toHaveLength(1);
    // Audit row count stays at 1 too.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.filter((e) => e.eventKind === "totp-failed-rate")).toHaveLength(1);
  });

  it("Phase 5: a new window after 15 min re-arms the alert", async () => {
    const { storage, fixedNow } = await setupEnrolled();
    await storage.pushTokens.put({
      tokenId: "trusted",
      username: USERNAME,
      platform: "apns",
      providerToken: "providerTrust",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: number[] = [];
    let clock = fixedNow;
    const deps = {
      usernames: storage.usernames,
      pushTokens: storage.pushTokens,
      auditEvents: storage.auditEvents,
      kekHex: TEST_KEK_HEX,
      now: () => clock,
    };
    const fanout = async () => {
      fires.push(1);
    };
    for (let i = 0; i < 5; i++) {
      await handleTotpVerify(deps, USERNAME, { code: "000000" }, fanout);
    }
    expect(fires).toHaveLength(1);
    // Advance past the window.
    clock = fixedNow + 15 * 60_000 + 1;
    for (let i = 0; i < 5; i++) {
      await handleTotpVerify(deps, USERNAME, { code: "000000" }, fanout);
    }
    expect(fires).toHaveLength(2);
  });
});
