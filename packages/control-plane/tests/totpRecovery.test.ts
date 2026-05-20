import { describe, expect, it } from "vitest";
import {
  ed,
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import * as OTPAuth from "otpauth";
import {
  consumeRecoveryCode,
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

async function enrollWithRecoveryCodes(): Promise<{
  storage: InMemoryStorage;
  recoveryCodes: string[];
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
  const secret = (begin.body as { secret: string }).secret;
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
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
  return {
    storage,
    recoveryCodes: (confirm.body as { recoveryCodes: string[] }).recoveryCodes,
  };
}

describe("TOTP recovery code consumption", () => {
  it("consumes a valid recovery code atomically", async () => {
    const { storage, recoveryCodes } = await enrollWithRecoveryCodes();
    const target = recoveryCodes[0] as string;
    const before = await storage.usernames.get(USERNAME);
    const beforeRows = JSON.parse(before!.recoveryCodesHashesJson!);
    expect(beforeRows).toHaveLength(10);
    const r = await consumeRecoveryCode(
      { usernames: storage.usernames },
      USERNAME,
      target,
    );
    expect(r.consumed).toBe(true);
    const after = await storage.usernames.get(USERNAME);
    const afterRows = JSON.parse(after!.recoveryCodesHashesJson!);
    expect(afterRows).toHaveLength(9);
  });

  it("a second consume of the same code fails (single-use)", async () => {
    const { storage, recoveryCodes } = await enrollWithRecoveryCodes();
    const target = recoveryCodes[0] as string;
    const first = await consumeRecoveryCode(
      { usernames: storage.usernames },
      USERNAME,
      target,
    );
    expect(first.consumed).toBe(true);
    const second = await consumeRecoveryCode(
      { usernames: storage.usernames },
      USERNAME,
      target,
    );
    expect(second.consumed).toBe(false);
  });

  it("rejects an unknown code without changing the array", async () => {
    const { storage } = await enrollWithRecoveryCodes();
    const before = await storage.usernames.get(USERNAME);
    const r = await consumeRecoveryCode(
      { usernames: storage.usernames },
      USERNAME,
      "ZZZZZZZZZZ",
    );
    expect(r.consumed).toBe(false);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.recoveryCodesHashesJson).toBe(before?.recoveryCodesHashesJson);
  });

  it("concurrent races: two parallel consumes of the same code result in exactly one success", async () => {
    const { storage, recoveryCodes } = await enrollWithRecoveryCodes();
    const target = recoveryCodes[0] as string;
    const [a, b] = await Promise.all([
      consumeRecoveryCode({ usernames: storage.usernames }, USERNAME, target),
      consumeRecoveryCode({ usernames: storage.usernames }, USERNAME, target),
    ]);
    const wins = [a.consumed, b.consumed].filter((x) => x === true).length;
    const losses = [a.consumed, b.consumed].filter((x) => x === false).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    // Array shrank by exactly one.
    const final = await storage.usernames.get(USERNAME);
    const rows = JSON.parse(final!.recoveryCodesHashesJson!);
    expect(rows).toHaveLength(9);
  });

  it("consuming all 10 codes leaves the array empty", async () => {
    const { storage, recoveryCodes } = await enrollWithRecoveryCodes();
    for (const c of recoveryCodes) {
      const r = await consumeRecoveryCode(
        { usernames: storage.usernames },
        USERNAME,
        c,
      );
      expect(r.consumed).toBe(true);
    }
    const after = await storage.usernames.get(USERNAME);
    const rows = JSON.parse(after!.recoveryCodesHashesJson!);
    expect(rows).toHaveLength(0);
    // A subsequent consume sees the empty list and rejects.
    const r = await consumeRecoveryCode(
      { usernames: storage.usernames },
      USERNAME,
      recoveryCodes[0] as string,
    );
    expect(r.consumed).toBe(false);
  });

  it("a fresh enroll-confirm regenerates all 10 codes", async () => {
    const irk = makeKey();
    const storage = new InMemoryStorage();
    await storage.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(irk.publicKey),
      claimedAt: 1,
      accountType: "single",
    });
    const fixedNow = 1_700_000_000_000;

    async function fullEnroll(): Promise<string[]> {
      const begin = await handleTotpEnrollBegin(
        {
          usernames: storage.usernames,
          kekHex: TEST_KEK_HEX,
          now: () => fixedNow,
        },
        USERNAME,
        {
          request: { username: USERNAME, issuedAt: fixedNow },
          signature: bytesToHex(
            signTotpEnrollBegin(
              { username: USERNAME, issuedAt: fixedNow },
              irk,
            ),
          ),
        },
      );
      const secret = (begin.body as { secret: string }).secret;
      const totp = new OTPAuth.TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret),
      });
      const code = totp.generate({ timestamp: fixedNow });
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
            signTotpEnrollConfirm(
              { username: USERNAME, issuedAt: fixedNow },
              irk,
            ),
          ),
          code,
        },
      );
      return (confirm.body as { recoveryCodes: string[] }).recoveryCodes;
    }

    const first = await fullEnroll();
    const second = await fullEnroll();
    // Every code is freshly minted — no overlap.
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    for (const f of first) expect(second).not.toContain(f);
  });
});
