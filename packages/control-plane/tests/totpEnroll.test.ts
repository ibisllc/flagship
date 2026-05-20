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
  decryptTotpSecret,
  encryptTotpSecret,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
} from "../src/totp.js";

const USERNAME = "alice";
// 32-byte test KEK (deterministic — production uses a random 32-byte
// secret rotated separately).
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

async function seedUser(irk: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
    accountType: "single",
  });
  return s;
}

function beginBody(args: { irk: Keypair; issuedAt?: number }) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signTotpEnrollBegin({ username: USERNAME, issuedAt }, args.irk);
  return {
    request: { username: USERNAME, issuedAt },
    signature: bytesToHex(sig),
  };
}

function confirmBody(args: { irk: Keypair; code: string; issuedAt?: number }) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signTotpEnrollConfirm(
    { username: USERNAME, issuedAt },
    args.irk,
  );
  return {
    request: { username: USERNAME, issuedAt },
    signature: bytesToHex(sig),
    code: args.code,
  };
}

describe("TOTP enroll-begin", () => {
  it("returns 503 when KEK is unset", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollBegin(
      { usernames: storage.usernames },
      USERNAME,
      beginBody({ irk }),
    );
    expect(res.status).toBe(503);
  });

  it("mints a TOTP secret, encrypts it at rest, returns otpauthUrl + qr + base32", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk }),
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      secret: string;
      otpauthUrl: string;
      qrPngBase64: string;
      issuer: string;
    };
    // Base32 secret with sane shape (multiple of 8 chars when no
    // padding, ≥16 chars for a 160-bit secret).
    expect(b.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(b.secret.replace(/=+$/, "").length).toBeGreaterThanOrEqual(16);
    expect(b.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Flagship:alice\?/);
    expect(b.otpauthUrl).toMatch(/secret=/);
    // QR PNG was generated (non-empty base64).
    expect(b.qrPngBase64.length).toBeGreaterThan(64);
    // Stored encrypted secret on the row.
    const stored = await storage.usernames.get(USERNAME);
    expect(stored?.totpSecretEncrypted).toBeTypeOf("string");
    expect(stored?.totpSecretEncrypted!.length).toBeGreaterThan(20);
    // Account stays SINGLE-device until enroll-confirm — this is the
    // anti-mid-enrollment-lockout invariant.
    expect(stored?.accountType).toBe("single");
    expect(stored?.totpEnrolledAt).toBeUndefined();
  });

  it("rejects an unsigned envelope (400)", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      { request: { username: USERNAME, issuedAt: Date.now() } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a signature from the wrong key (403)", async () => {
    const irk = makeKey();
    const wrong = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk: wrong }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a stale envelope (403)", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk, issuedAt: Date.now() - 10 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });

  it("404s on unknown username", async () => {
    const irk = makeKey();
    const res = await handleTotpEnrollBegin(
      { usernames: new InMemoryStorage().usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk }),
    );
    expect(res.status).toBe(404);
  });
});

describe("TOTP enroll-confirm", () => {
  it("rejects when no staged secret exists (no enroll-begin called)", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const res = await handleTotpEnrollConfirm(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      confirmBody({ irk, code: "000000" }),
    );
    expect(res.status).toBe(409);
  });

  it("end-to-end: enroll-begin → enroll-confirm with right code flips to multi + returns 10 recovery codes", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    const beginRes = await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk }),
    );
    expect(beginRes.status).toBe(200);
    const beginBody_ = beginRes.body as { secret: string };

    // Mint a code from the staged secret using the same library.
    const totp = new OTPAuth.TOTP({
      issuer: "Flagship",
      label: USERNAME,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(beginBody_.secret),
    });
    const fixedNow = 1_700_000_000_000;
    const code = totp.generate({ timestamp: fixedNow });

    const confirmRes = await handleTotpEnrollConfirm(
      {
        usernames: storage.usernames,
        kekHex: TEST_KEK_HEX,
        now: () => fixedNow,
        fastHash: true,
      },
      USERNAME,
      confirmBody({ irk, code, issuedAt: fixedNow }),
    );
    expect(confirmRes.status).toBe(200);
    const body = confirmRes.body as {
      ok: boolean;
      accountType: string;
      totpEnrolledAt: number;
      recoveryCodes: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.accountType).toBe("multi");
    expect(body.totpEnrolledAt).toBe(fixedNow);
    expect(body.recoveryCodes).toHaveLength(10);
    for (const c of body.recoveryCodes) {
      expect(c).toMatch(/^[A-Z2-7]{10}$/);
    }

    // Row reflects the post-confirm state.
    const after = await storage.usernames.get(USERNAME);
    expect(after?.accountType).toBe("multi");
    expect(after?.totpEnrolledAt).toBe(fixedNow);
    expect(after?.recoveryCodesHashesJson).toBeTypeOf("string");
    const parsed = JSON.parse(after!.recoveryCodesHashesJson!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(10);
    for (const row of parsed) {
      expect(typeof row.saltHex).toBe("string");
      expect(typeof row.hashHex).toBe("string");
    }
  });

  it("rejects enroll-confirm with the wrong code (401)", async () => {
    const irk = makeKey();
    const storage = await seedUser(irk);
    await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk }),
    );
    const res = await handleTotpEnrollConfirm(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      confirmBody({ irk, code: "000000" }),
    );
    expect(res.status).toBe(401);
    // Row stays single-device on failure.
    const after = await storage.usernames.get(USERNAME);
    expect(after?.accountType).toBe("single");
    expect(after?.totpEnrolledAt).toBeUndefined();
  });

  it("rejects a signature from a wrong key (403)", async () => {
    const irk = makeKey();
    const wrong = makeKey();
    const storage = await seedUser(irk);
    await handleTotpEnrollBegin(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      beginBody({ irk }),
    );
    const res = await handleTotpEnrollConfirm(
      { usernames: storage.usernames, kekHex: TEST_KEK_HEX },
      USERNAME,
      confirmBody({ irk: wrong, code: "000000" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("TOTP encryption helpers", () => {
  it("encrypt then decrypt round-trips arbitrary bytes", async () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const blob = await encryptTotpSecret(secret, TEST_KEK_HEX);
    const out = await decryptTotpSecret(blob, TEST_KEK_HEX);
    expect(Array.from(out)).toEqual(Array.from(secret));
  });
  it("re-encrypting the same bytes yields distinct ciphertexts (fresh IV)", async () => {
    const secret = new Uint8Array(20);
    const a = await encryptTotpSecret(secret, TEST_KEK_HEX);
    const b = await encryptTotpSecret(secret, TEST_KEK_HEX);
    expect(a).not.toBe(b);
  });
  it("decryption fails with a different KEK", async () => {
    const secret = new Uint8Array([1, 2, 3]);
    const blob = await encryptTotpSecret(secret, TEST_KEK_HEX);
    const other =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await expect(decryptTotpSecret(blob, other)).rejects.toThrow();
  });
  it("rejects a KEK that isn't 32 bytes", async () => {
    await expect(
      encryptTotpSecret(new Uint8Array(20), "ababab"),
    ).rejects.toThrow();
  });
});
