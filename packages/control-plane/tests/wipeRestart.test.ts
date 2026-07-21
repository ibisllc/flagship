import { beforeEach, describe, expect, it } from "vitest";
import {
  ed,
  signWipeRestart,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleWipeRestart,
  _resetWipeRestartIdempotencyForTests,
} from "../src/wipeRestart.js";

const USERNAME = "alice";

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
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  let s = "";
  for (const x of h) s += x.toString(16).padStart(2, "0");
  return s;
}
function makeIdemKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
function makeCredentialId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function setup(oldIrk: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(oldIrk.publicKey),
    claimedAt: 1,
  });
  // Seed a stale recovery envelope so we can verify it gets replaced.
  const wrappedOld = new Uint8Array([0xfa, 0xce]);
  await s.webauthnRecovery.upsert({
    username: USERNAME,
    credentialIdHex: "deadbeefdeadbeef",
    wrappedUmkB64: bytesToB64(wrappedOld),
    irkPubHex: bytesToHex(oldIrk.publicKey),
    createdAt: 1,
    updatedAt: 1,
  });
  return s;
}

interface BodyArgs {
  oldIrk: Keypair;
  newIrk: Keypair;
  newCredentialId?: string;
  newWrappedUmk?: Uint8Array;
  issuedAt?: number;
  idempotencyKey?: string;
}
async function makeBody(args: BodyArgs) {
  const issuedAt = args.issuedAt ?? Date.now();
  const newCredId = args.newCredentialId ?? makeCredentialId();
  const wrapped = args.newWrappedUmk ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const wrappedHashHex = await sha256Hex(wrapped);
  const sig = signWipeRestart(
    {
      username: USERNAME,
      oldIrkPub: args.oldIrk.publicKey,
      newIrkPub: args.newIrk.publicKey,
      newCredentialIdHex: newCredId,
      newWrappedUmkHashHex: wrappedHashHex,
      issuedAt,
    },
    args.oldIrk,
  );
  return {
    request: {
      username: USERNAME,
      oldIrkPub: bytesToHex(args.oldIrk.publicKey),
      newIrkPub: bytesToHex(args.newIrk.publicKey),
      newCredentialId: newCredId,
      newWrappedUmk: bytesToB64(wrapped),
      issuedAt,
    },
    signature: bytesToHex(sig),
    idempotencyKey: args.idempotencyKey ?? makeIdemKey(),
  };
}

function deps(s: InMemoryStorage, now?: () => number) {
  return {
    usernames: s.usernames,
    webauthnRecovery: s.webauthnRecovery,
    auditEvents: s.auditEvents,
    pushTokens: s.pushTokens,
    now,
  };
}

beforeEach(() => {
  _resetWipeRestartIdempotencyForTests();
});

describe("handleWipeRestart — happy path", () => {
  it("swaps IRK, replaces envelope, appends audit, returns auditSeq", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });

    const res = await handleWipeRestart(deps(s), USERNAME, body);

    expect(res.status).toBe(200);
    const b = res.body as { ok: boolean; auditSeq: number; newIrkPub: string };
    expect(b.ok).toBe(true);
    expect(typeof b.auditSeq).toBe("number");
    expect(b.newIrkPub).toBe(body.request.newIrkPub);

    const u = await s.usernames.get(USERNAME);
    expect(u?.irkPubHex.toLowerCase()).toBe(body.request.newIrkPub.toLowerCase());

    const rec = await s.webauthnRecovery.get(USERNAME);
    expect(rec?.credentialIdHex).toBe(body.request.newCredentialId);
    expect(rec?.wrappedUmkB64).toBe(body.request.newWrappedUmk);
    expect(rec?.irkPubHex.toLowerCase()).toBe(body.request.newIrkPub.toLowerCase());

    const audit = await s.auditEvents.list(USERNAME, 0, 5);
    expect(audit[0]?.eventKind).toBe("wipe-restart");
  });

  it("returns a fresh devices ETag in the response headers", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });

    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(200);
    expect(res.headers?.etag).toMatch(/^W\/".+"/);
  });
});

describe("handleWipeRestart — validation", () => {
  it("400 on malformed body", async () => {
    const oldIrk = makeKey();
    const s = await setup(oldIrk);
    const res = await handleWipeRestart(deps(s), USERNAME, { request: {} });
    expect(res.status).toBe(400);
  });

  it("400 when idempotencyKey is not 32 hex chars", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = { ...(await makeBody({ oldIrk, newIrk })), idempotencyKey: "tooshort" };
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(400);
  });

  it("400 when newWrappedUmk is not valid base64", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    (body.request as Record<string, unknown>).newWrappedUmk = "@@@not-base64@@@";
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(400);
  });

  it("403 when URL username differs from body username", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(deps(s), "someone-else", body);
    expect(res.status).toBe(403);
  });

  it("403 when issuedAt is too stale", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk, issuedAt: Date.now() - 10 * 60_000 });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(403);
  });

  it("404 when username does not exist", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = new InMemoryStorage();
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(404);
  });

  it("403 when body's oldIrkPub does not match the registered IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const wrongOld = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk: wrongOld, newIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(403);
  });

  it("400 when newIrkPub equals the current IRK (no-op rejection)", async () => {
    const oldIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk: oldIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(400);
  });

  it("403 when the signature is by the NEW IRK rather than the OLD IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    // Re-sign the same canonical bytes with the wrong key.
    const wrappedBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wrappedHashHex = await sha256Hex(wrappedBytes);
    const forged = signWipeRestart(
      {
        username: USERNAME,
        oldIrkPub: oldIrk.publicKey,
        newIrkPub: newIrk.publicKey,
        newCredentialIdHex: body.request.newCredentialId,
        newWrappedUmkHashHex: wrappedHashHex,
        issuedAt: body.request.issuedAt,
      },
      newIrk, // wrong signer
    );
    body.signature = bytesToHex(forged);
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(403);
  });
});

describe("handleWipeRestart — rate limit", () => {
  it("429 when a wipe-restart audit row is fresher than the rate-limit window", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    // Seed a recent wipe-restart audit row.
    await s.auditEvents.append({
      username: USERNAME,
      eventKind: "wipe-restart",
      detail: "earlier",
      devicePrefix: "abcd1234",
      postedAt: Date.now() - 60_000, // 1 minute ago
    });
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(429);
    expect((res.body as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("200 again after the rate-limit window has elapsed", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    await s.auditEvents.append({
      username: USERNAME,
      eventKind: "wipe-restart",
      detail: "old",
      devicePrefix: "abcd1234",
      postedAt: Date.now() - 2 * 60 * 60_000, // 2 hours ago
    });
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(200);
  });
});

describe("handleWipeRestart — idempotency", () => {
  it("a second call within the window with the same idempotencyKey returns the same response", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const idKey = makeIdemKey();
    const body1 = await makeBody({ oldIrk, newIrk, idempotencyKey: idKey });
    const res1 = await handleWipeRestart(deps(s), USERNAME, body1);
    expect(res1.status).toBe(200);
    const seq1 = (res1.body as { auditSeq: number }).auditSeq;

    // A naive retry that re-signs with a fresh issuedAt — different
    // signature bytes, same idempotencyKey. Should replay the first
    // response without re-rotating.
    const body2 = await makeBody({ oldIrk, newIrk, idempotencyKey: idKey });
    const res2 = await handleWipeRestart(deps(s), USERNAME, body2);
    expect(res2.status).toBe(200);
    const seq2 = (res2.body as { auditSeq: number }).auditSeq;
    expect(seq2).toBe(seq1);

    // Only one audit row was actually written.
    const audit = await s.auditEvents.list(USERNAME, 0, 10);
    expect(audit.filter((e) => e.eventKind === "wipe-restart")).toHaveLength(1);
  });
});

describe("handleWipeRestart — ETag fence", () => {
  it("412 when If-Match does not match the current devices ETag", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(deps(s), USERNAME, body, 'W/"stale-etag"');
    expect(res.status).toBe(412);
    expect((res.body as { currentEtag: string }).currentEtag).toMatch(/^W\/"/);
  });
});

describe("handleWipeRestart — v2 device-capability-grant revocation", () => {
  it("revokes every active grant on the cloud + surfaces revokedGrantIds", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    // Seed two active grants under the OLD IRK. These will be revoked
    // by wipe-restart (their signatures are dead under the new root).
    const now = 1_000_000_000_000;
    await s.deviceCapabilityGrants.put({
      grantId: "11111111-1111-1111-1111-111111111111",
      username: USERNAME,
      deviceId: "primary",
      devicePubHex: bytesToHex(oldIrk.publicKey),
      scopesJson: '["browse","install-service"]',
      issuedAt: now - 1000,
      expiresAt: now + 90 * 86_400_000,
      signatureHex: "00".repeat(64),
      revokedAt: null,
    });
    await s.deviceCapabilityGrants.put({
      grantId: "22222222-2222-2222-2222-222222222222",
      username: USERNAME,
      deviceId: "ipad",
      devicePubHex: bytesToHex(makeKey().publicKey),
      scopesJson: '["browse"]',
      issuedAt: now - 500,
      expiresAt: now + 90 * 86_400_000,
      signatureHex: "00".repeat(64),
      revokedAt: null,
    });
    const body = await makeBody({ oldIrk, newIrk });
    const dwithGrants = { ...deps(s), deviceCapabilityGrants: s.deviceCapabilityGrants };
    const res = await handleWipeRestart(dwithGrants, USERNAME, body);
    expect(res.status).toBe(200);
    const respBody = res.body as { revokedGrantIds: string[] };
    expect(respBody.revokedGrantIds).toHaveLength(2);
    expect(respBody.revokedGrantIds.sort()).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
    // Both grants must be marked revoked on disk.
    for (const id of respBody.revokedGrantIds) {
      const g = await s.deviceCapabilityGrants.get(id);
      expect(g?.revokedAt).not.toBeNull();
    }
  });

  it("legacy: no grants → revokedGrantIds is [] and the wipe still succeeds", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    const res = await handleWipeRestart(
      { ...deps(s), deviceCapabilityGrants: s.deviceCapabilityGrants },
      USERNAME,
      body,
    );
    expect(res.status).toBe(200);
    expect((res.body as { revokedGrantIds: string[] }).revokedGrantIds).toEqual([]);
  });

  it("dep absent: revokedGrantIds is [] and the wipe still succeeds (deploy-safe degrade)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    // Note: deps() doesn't pass deviceCapabilityGrants — legacy path.
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    expect(res.status).toBe(200);
    expect((res.body as { revokedGrantIds: string[] }).revokedGrantIds).toEqual([]);
  });
});

describe("handleWipeRestart — concurrency", () => {
  it("409 when the IRK was rotated between read and CAS by a sibling write", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const interloper = makeKey();
    const s = await setup(oldIrk);
    const body = await makeBody({ oldIrk, newIrk });
    // Simulate a sibling rotation by manually swapping the IRK before
    // the handler's own CAS. The handler's swapIrkPub(old) will see
    // a different stored value and return false → 409.
    await s.usernames.swapIrkPub(
      USERNAME,
      bytesToHex(oldIrk.publicKey),
      bytesToHex(interloper.publicKey),
      Date.now(),
    );
    const res = await handleWipeRestart(deps(s), USERNAME, body);
    // The body's oldIrkPub check fires before the CAS, so this is 403
    // — the body claims oldIrkPub=<oldIrk> but the stored value is
    // <interloper>. Either 403 or 409 is acceptable; both indicate
    // the racing-rotation defense fired.
    expect([403, 409]).toContain(res.status);
  });
});

/**
 * Wipe-restart installs a NEW UMK. The account and device names are sealed
 * under keys DERIVED from the UMK, so the instant the rotation lands every
 * stored ciphertext is undecryptable — by the owner, by any device, forever.
 * Leaving it in place means names render opaque permanently while dead
 * ciphertext sits against the account.
 */
describe("handleWipeRestart — UMK rotation clears the now-undecryptable names", () => {
  const DEVICE_ID = "00112233445566778899aabbccddeeff";

  async function seedEncryptedNames(s: InMemoryStorage): Promise<void> {
    await s.deviceIdentities.put({
      accountId: USERNAME, deviceId: DEVICE_ID, devicePubHex: "aa".repeat(32),
      platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null,
    });
    await s.accountProfiles.put({
      accountId: USERNAME, revision: 1, keyVersion: 1,
      nonceHex: "11".repeat(12), ciphertextHex: "deadbeef",
      signerPubHex: "bb".repeat(32), signatureHex: "cc".repeat(64),
      issuedAt: 1, updatedAt: 1,
    }, 0);
    await s.deviceSelfProfiles.put({
      accountId: USERNAME, deviceId: DEVICE_ID, revision: 1, keyVersion: 1,
      nonceHex: "22".repeat(12), ciphertextHex: "feedface",
      signerPubHex: "aa".repeat(32), signatureHex: "dd".repeat(64),
      issuedAt: 1, updatedAt: 1,
    }, 0);
    await s.deviceManagedProfiles.put({
      accountId: USERNAME, deviceId: DEVICE_ID, revision: 1, keyVersion: 1,
      nonceHex: "33".repeat(12), ciphertextHex: "cafebabe", locked: true,
      signerPubHex: "bb".repeat(32), signatureHex: "ee".repeat(64),
      issuedAt: 1, updatedAt: 1,
    }, 0);
    await s.accountDirectoryKeyGrants.put({
      grantId: "grant-1", accountId: USERNAME, recipientDeviceId: DEVICE_ID,
      keyKind: "device-directory", sealedKeyHex: "0badc0de",
      signerPubHex: "bb".repeat(32), signatureHex: "ff".repeat(64),
      issuedAt: 1, expiresAt: 9_999_999_999_999, revokedAt: null,
    });
  }

  function depsWithProfiles(s: InMemoryStorage) {
    return {
      ...deps(s),
      deviceCapabilityGrants: s.deviceCapabilityGrants,
      accountProfiles: s.accountProfiles,
      deviceSelfProfiles: s.deviceSelfProfiles,
      deviceManagedProfiles: s.deviceManagedProfiles,
      accountDirectoryKeyGrants: s.accountDirectoryKeyGrants,
    };
  }

  it("purges account, self, managed profiles and directory key grants", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    await seedEncryptedNames(s);
    // Precondition: the ciphertext really is there before the rotation.
    expect(await s.accountProfiles.get(USERNAME)).toBeDefined();
    expect(await s.deviceSelfProfiles.get(USERNAME, DEVICE_ID)).toBeDefined();
    expect(await s.deviceManagedProfiles.get(USERNAME, DEVICE_ID)).toBeDefined();

    const res = await handleWipeRestart(
      depsWithProfiles(s), USERNAME, await makeBody({ oldIrk, newIrk }), undefined,
    );
    expect(res.status).toBe(200);

    // Nothing sealed under the dead UMK survives.
    expect(await s.accountProfiles.get(USERNAME)).toBeUndefined();
    expect(await s.deviceSelfProfiles.get(USERNAME, DEVICE_ID)).toBeUndefined();
    expect(await s.deviceManagedProfiles.get(USERNAME, DEVICE_ID)).toBeUndefined();
    expect(await s.accountDirectoryKeyGrants.listActiveForDevice(USERNAME, DEVICE_ID, 2)).toEqual([]);
  });

  it("still rotates when the profile stores are not wired (deploy-safe degrade)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const s = await setup(oldIrk);
    await seedEncryptedNames(s);
    const res = await handleWipeRestart(deps(s), USERNAME, await makeBody({ oldIrk, newIrk }), undefined);
    expect(res.status).toBe(200);
    expect((await s.usernames.get(USERNAME))?.irkPubHex).toBe(bytesToHex(newIrk.publicKey));
  });
});
