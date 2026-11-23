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
  TOTP_ADMIN_ONLY,
  TOTP_PENDING_TTL_MS,
  handleTotpDisable,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
  handleTotpVerify,
  _resetTotpVerifyRateLimitForTests,
} from "../src/totp.js";

// Security report F2 (docs/security/F2-2fa-enrolment-investigation.md): a
// begin never touches a live secret, a staged secret is never a credential,
// it expires, turning code protection on or off is an admin order, and every
// refusal has a stable code.

const USERNAME = "alice";
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const T0 = 1_700_000_000_000;

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function seed(irk: Keypair, adminRoot?: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    accountType: "single",
    ...(adminRoot ? { adminRootPubHex: hex(adminRoot.publicKey) } : {}),
  });
  return s;
}

const deps = (s: InMemoryStorage, now: number) => ({
  usernames: s.usernames,
  grants: s.deviceCapabilityGrants,
  pushTokens: s.pushTokens,
  kekHex: KEK,
  now: () => now,
  fastHash: true,
});

const begin = (s: InMemoryStorage, key: Keypair, now = T0) =>
  handleTotpEnrollBegin(deps(s, now), USERNAME, {
    request: { username: USERNAME, issuedAt: now },
    signature: hex(signTotpEnrollBegin({ username: USERNAME, issuedAt: now }, key)),
  });
const confirm = (s: InMemoryStorage, key: Keypair, code: string, now = T0) =>
  handleTotpEnrollConfirm(deps(s, now), USERNAME, {
    request: { username: USERNAME, issuedAt: now },
    signature: hex(signTotpEnrollConfirm({ username: USERNAME, issuedAt: now }, key)),
    code,
  });
const disable = (s: InMemoryStorage, key: Keypair, code: string, now = T0) =>
  handleTotpDisable(deps(s, now), USERNAME, {
    request: { username: USERNAME, issuedAt: now },
    signature: hex(signTotpDisable({ username: USERNAME, issuedAt: now }, key)),
    code,
  });
const codeFor = (secret: string, t: number) =>
  new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate({
    timestamp: t,
  });
const codeOf = (r: { body: unknown }) => (r.body as { code?: string }).code;

async function enrolled(key: Keypair) {
  const s = await seed(key);
  const b = await begin(s, key);
  const secret = (b.body as { secret: string }).secret;
  const c = await confirm(s, key, codeFor(secret, T0));
  expect(c.status).toBe(200);
  return { s, secret, recoveryCodes: (c.body as { recoveryCodes: string[] }).recoveryCodes };
}

describe("F2: enroll-begin never replaces a live secret", () => {
  it("refuses a begin on an enrolled account with 409 totp-already-enrolled and leaves the secret and codes alone", async () => {
    const irk = makeKey();
    const { s } = await enrolled(irk);
    const before = await s.usernames.get(USERNAME);
    const r = await begin(s, irk, T0 + 1000);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("totp-already-enrolled");
    const after = await s.usernames.get(USERNAME);
    expect(after?.totpSecretEncrypted).toBe(before?.totpSecretEncrypted);
    expect(after?.recoveryCodesHashesJson).toBe(before?.recoveryCodesHashesJson);
    expect(after?.totpPendingSecretEncrypted).toBeUndefined();
  });

  it("a confirm on an enrolled account is refused too (recovery codes are replaced only by a real enrolment)", async () => {
    const irk = makeKey();
    const { s, secret } = await enrolled(irk);
    const before = await s.usernames.get(USERNAME);
    const r = await confirm(s, irk, codeFor(secret, T0 + 60_000), T0 + 60_000);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("totp-already-enrolled");
    expect((await s.usernames.get(USERNAME))?.recoveryCodesHashesJson).toBe(before?.recoveryCodesHashesJson);
  });

  it("off, then on again, gives a new secret and new recovery codes", async () => {
    const irk = makeKey();
    const { s, secret, recoveryCodes } = await enrolled(irk);
    expect((await disable(s, irk, codeFor(secret, T0 + 30_000), T0 + 30_000)).status).toBe(200);
    const b = await begin(s, irk, T0 + 60_000);
    expect(b.status).toBe(200);
    const fresh = (b.body as { secret: string }).secret;
    expect(fresh).not.toBe(secret);
    const c = await confirm(s, irk, codeFor(fresh, T0 + 60_000), T0 + 60_000);
    expect(c.status).toBe(200);
    for (const code of (c.body as { recoveryCodes: string[] }).recoveryCodes) expect(recoveryCodes).not.toContain(code);
  });
});

describe("F2: a staged secret is not a credential and expires", () => {
  it("a code from a begun-but-unconfirmed secret does not verify", async () => {
    _resetTotpVerifyRateLimitForTests();
    const irk = makeKey();
    const s = await seed(irk);
    const b = await begin(s, irk);
    const secret = (b.body as { secret: string; expiresAt: number }).secret;
    expect((b.body as { expiresAt: number }).expiresAt).toBe(T0 + TOTP_PENDING_TTL_MS);
    const v = await handleTotpVerify(deps(s, T0), USERNAME, { code: codeFor(secret, T0) });
    expect(v.status).toBe(401);
    const row = await s.usernames.get(USERNAME);
    expect(row?.totpSecretEncrypted).toBeUndefined();
    expect(row?.accountType).toBe("single");
  });

  it("a confirm after an hour is refused with totp-pending-expired and the pending secret is dropped", async () => {
    const irk = makeKey();
    const s = await seed(irk);
    const b = await begin(s, irk);
    const secret = (b.body as { secret: string }).secret;
    const late = T0 + TOTP_PENDING_TTL_MS + 1;
    const r = await confirm(s, irk, codeFor(secret, late), late);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("totp-pending-expired");
    expect((await s.usernames.get(USERNAME))?.totpPendingSecretEncrypted).toBeUndefined();
  });

  it("a second begin replaces the pending secret: the first one's code no longer confirms", async () => {
    const irk = makeKey();
    const s = await seed(irk);
    const first = ((await begin(s, irk)).body as { secret: string }).secret;
    const second = ((await begin(s, irk, T0 + 1000)).body as { secret: string }).secret;
    expect(second).not.toBe(first);
    const r = await confirm(s, irk, codeFor(first, T0 + 1000), T0 + 1000);
    expect(r.status).toBe(401);
    expect(codeOf(r)).toBe("invalid-totp-code");
    expect((await confirm(s, irk, codeFor(second, T0 + 1000), T0 + 1000)).status).toBe(200);
  });

  it("confirm without a begin is totp-no-pending", async () => {
    const irk = makeKey();
    const s = await seed(irk);
    const r = await confirm(s, irk, "123456");
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("totp-no-pending");
  });
});

describe("F2: code protection is an admin order", () => {
  it("on an account that pins an admin root, an IRK-signed begin is refused with totp-admin-only", async () => {
    const irk = makeKey();
    const admin = makeKey();
    const s = await seed(irk, admin);
    const r = await begin(s, irk);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: TOTP_ADMIN_ONLY, code: "totp-admin-only" });
    expect((await s.usernames.get(USERNAME))?.totpPendingSecretEncrypted).toBeUndefined();
  });

  it("the admin root turns it on and off; the IRK can neither confirm nor disable", async () => {
    const irk = makeKey();
    const admin = makeKey();
    const s = await seed(irk, admin);
    const secret = ((await begin(s, admin)).body as { secret: string }).secret;
    const byIrk = await confirm(s, irk, codeFor(secret, T0));
    expect(codeOf(byIrk)).toBe("totp-admin-only");
    expect((await confirm(s, admin, codeFor(secret, T0))).status).toBe(200);
    const off = await disable(s, irk, codeFor(secret, T0 + 30_000), T0 + 30_000);
    expect(off.status).toBe(403);
    expect(codeOf(off)).toBe("totp-admin-only");
    expect((await disable(s, admin, codeFor(secret, T0 + 30_000), T0 + 30_000)).status).toBe(200);
  });

  it("an account with no admin root (legacy, demo) keeps the IRK", async () => {
    const irk = makeKey();
    const s = await seed(irk);
    expect((await begin(s, irk)).status).toBe(200);
    const other = makeKey();
    const r = await begin(s, other);
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("invalid-signature");
  });
});

describe("F2: every refusal has a stable code", () => {
  it("names each refusal", async () => {
    const irk = makeKey();
    const s = await seed(irk);
    const noKek = await handleTotpEnrollBegin({ usernames: s.usernames }, USERNAME, {});
    expect(codeOf(noKek)).toBe("totp-not-configured");
    expect(codeOf(await handleTotpEnrollBegin(deps(s, T0), USERNAME, {}))).toBe("malformed");
    const old = T0 - 10 * 60_000;
    const stale = await handleTotpEnrollBegin(deps(s, T0), USERNAME, {
      request: { username: USERNAME, issuedAt: old },
      signature: hex(signTotpEnrollBegin({ username: USERNAME, issuedAt: old }, irk)),
    });
    expect(stale.status).toBe(403);
    expect(codeOf(stale)).toBe("stale-request");
    const ghost = await handleTotpEnrollBegin(deps(s, T0), "bob", {
      request: { username: "bob", issuedAt: T0 },
      signature: hex(signTotpEnrollBegin({ username: "bob", issuedAt: T0 }, irk)),
    });
    expect(ghost.status).toBe(404);
    expect(codeOf(ghost)).toBe("account-not-found");
    const mismatch = await handleTotpEnrollBegin(deps(s, T0), "bob", {
      request: { username: USERNAME, issuedAt: T0 },
      signature: hex(signTotpEnrollBegin({ username: USERNAME, issuedAt: T0 }, irk)),
    });
    expect(codeOf(mismatch)).toBe("username-mismatch");
    const notOn = await disable(s, irk, "123456");
    expect(notOn.status).toBe(409);
    expect(codeOf(notOn)).toBe("totp-not-enrolled");
  });
});
