import { describe, expect, it } from "vitest";
import {
  ed,
  signTotpDisable,
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import * as OTPAuth from "otpauth";
import {
  handleTotpDisable,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
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

async function enrollFully(): Promise<{
  storage: InMemoryStorage;
  irk: Keypair;
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
  await handleTotpEnrollConfirm(
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
  return { storage, irk, secretBase32, fixedNow };
}

function disableBody(args: {
  irk: Keypair;
  code: string;
  issuedAt?: number;
}) {
  const issuedAt = args.issuedAt ?? Date.now();
  return {
    request: { username: USERNAME, issuedAt },
    signature: bytesToHex(
      signTotpDisable({ username: USERNAME, issuedAt }, args.irk),
    ),
    code: args.code,
  };
}

function codeAt(secret: string, t: number): string {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate({ timestamp: t });
}

describe("TOTP disable", () => {
  it("returns 503 when KEK is unset", async () => {
    const { storage, irk, fixedNow } = await enrollFully();
    const res = await handleTotpDisable(
      { usernames: storage.usernames, now: () => fixedNow },
      USERNAME,
      disableBody({ irk, code: "000000", issuedAt: fixedNow }),
    );
    expect(res.status).toBe(503);
  });

  it("rejects when TOTP is not enrolled (409)", async () => {
    const irk = makeKey();
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(irk.publicKey),
      claimedAt: 1,
      accountType: "single",
    });
    const res = await handleTotpDisable(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      disableBody({ irk, code: "000000" }),
    );
    expect(res.status).toBe(409);
  });

  it("rejects an invalid code (401)", async () => {
    const { storage, irk, fixedNow } = await enrollFully();
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({ irk, code: "000000", issuedAt: fixedNow }),
    );
    expect(res.status).toBe(401);
    const after = await storage.usernames.get(USERNAME);
    // Row stays multi on failed disable.
    expect(after?.accountType).toBe("multi");
  });

  it("rejects a signature from the wrong key (403)", async () => {
    const { storage, secretBase32, fixedNow } = await enrollFully();
    const wrong = makeKey();
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({
        irk: wrong,
        code: codeAt(secretBase32, fixedNow),
        issuedAt: fixedNow,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("succeeds with a valid code + flips back to single + drops TOTP artifacts", async () => {
    const { storage, irk, secretBase32, fixedNow } = await enrollFully();
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({
        irk,
        code: codeAt(secretBase32, fixedNow),
        issuedAt: fixedNow,
      }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { accountType: string }).accountType).toBe("single");
    const after = await storage.usernames.get(USERNAME);
    expect(after?.accountType).toBe("single");
    expect(after?.totpSecretEncrypted).toBeUndefined();
    expect(after?.recoveryCodesHashesJson).toBeUndefined();
    expect(after?.totpEnrolledAt).toBeUndefined();
  });

  it("refuses when multiple paired devices exist (409)", async () => {
    const { storage, irk, secretBase32, fixedNow } = await enrollFully();
    // Seed two push_tokens — simulates two paired devices on the
    // account. Disable's single-device-state invariant must refuse.
    await storage.pushTokens.put({
      tokenId: "devA",
      username: USERNAME,
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      deviceId: "0a".repeat(16),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    await storage.pushTokens.put({
      tokenId: "devB",
      username: USERNAME,
      platform: "apns",
      providerToken: "p2",
      pushX25519PubHex: "02".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      deviceId: "0b".repeat(16),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        pushTokens: storage.pushTokens,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({
        irk,
        code: codeAt(secretBase32, fixedNow),
        issuedAt: fixedNow,
      }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/remove other paired/);
    // Row stays multi.
    const after = await storage.usernames.get(USERNAME);
    expect(after?.accountType).toBe("multi");
  });

  it("permits disable when exactly one device is paired (single-device-shape OK)", async () => {
    const { storage, irk, secretBase32, fixedNow } = await enrollFully();
    await storage.pushTokens.put({
      tokenId: "devSolo",
      username: USERNAME,
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      deviceId: "0c".repeat(16),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        pushTokens: storage.pushTokens,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({
        irk,
        code: codeAt(secretBase32, fixedNow),
        issuedAt: fixedNow,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("v1.2 Phase 5 — emits `account-type-changed-multi-to-single` + `totp-disabled` on success", async () => {
    const { storage, irk, secretBase32, fixedNow } = await enrollFully();
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        auditEvents: storage.auditEvents,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({
        irk,
        code: codeAt(secretBase32, fixedNow),
        issuedAt: fixedNow,
      }),
    );
    expect(res.status).toBe(200);
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.map((e) => e.eventKind)).toEqual(
      expect.arrayContaining([
        "account-type-changed-multi-to-single",
        "totp-disabled",
      ]),
    );
    // accountTypeAtEvent='multi' on both rows — the row remembers
    // the OLD state at the moment of the disable.
    for (const e of events.filter((x) =>
      x.eventKind === "account-type-changed-multi-to-single" ||
      x.eventKind === "totp-disabled",
    )) {
      expect(e.accountTypeAtEvent).toBe("multi");
    }
  });

  it("v1.2 Phase 5 — failure path emits NO audit rows", async () => {
    const { storage, irk, fixedNow } = await enrollFully();
    const res = await handleTotpDisable(
      {
        usernames: storage.usernames,
        auditEvents: storage.auditEvents,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      disableBody({ irk, code: "000000", issuedAt: fixedNow }),
    );
    expect(res.status).toBe(401);
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(0);
  });
});
