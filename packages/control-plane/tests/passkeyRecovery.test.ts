import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed, signRecoveryRecord, type Keypair, type RecoveryRecordV2 } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  ANDROID_CERT_SHA256,
  checkRecoveryChallenge,
  issueRecoveryChallenge,
  readAttestationObject,
  recoveryPasskeyPolicy,
  verifyPasskeyAssertion,
} from "../src/passkeyAssertion.js";
import {
  handleFetchWebauthnRecovery,
  handleFetchWrappedUmkWithToken,
  handleRecoveryChallenge,
  handleUploadWebauthnRecovery,
} from "../src/webauthnRecovery.js";

const v = JSON.parse(readFileSync(new URL("../../protocol/test-vectors/recovery-passkey/vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const policy = recoveryPasskeyPolicy("flagshipserver.com");
const NOW = v.now as number;
const SECRET = v.secretUtf8 as string;
const ES = v.entries[0];
const ED = v.entries[1];

describe("recovery passkey: the shared vectors", () => {
  it("reads each registration's key and credential, and accepts each assertion over the challenge", async () => {
    for (const e of v.entries) {
      const r = readAttestationObject(Buffer.from(e.attestationObject, "base64url"));
      expect(hex(r.credentialId)).toBe(e.credentialIdHex);
      expect(hex(r.cose)).toBe(e.coseHex);
      expect(await verifyPasskeyAssertion({ coseHex: e.coseHex, credentialIdHex: e.credentialIdHex, assertion: e.assertion, challenge: v.challenge, policy }), e.name).toEqual({ ok: true });
    }
  });

  it("refuses another origin, rpId, challenge, credential or key, and a passkey that did not verify the user", async () => {
    for (const c of v.invalid) {
      const r = await verifyPasskeyAssertion({ coseHex: ES.coseHex, credentialIdHex: ES.credentialIdHex, assertion: c.assertion, challenge: v.challenge, policy });
      expect(r.ok, c.name).toBe(false);
    }
    expect((await verifyPasskeyAssertion({ coseHex: ES.coseHex, credentialIdHex: ES.credentialIdHex, assertion: null, challenge: v.challenge, policy })).ok).toBe(false);
  });

  it("issues the challenge byte for byte, for one account, until it expires", async () => {
    expect((await issueRecoveryChallenge(SECRET, v.username, NOW, new Uint8Array(16).fill(0x5a))).challenge).toBe(v.challenge);
    expect(await checkRecoveryChallenge(SECRET, v.username, v.challenge, NOW)).toBe(true);
    expect(await checkRecoveryChallenge(SECRET, "bob", v.challenge, NOW)).toBe(false);
    expect(await checkRecoveryChallenge("another secret", v.username, v.challenge, NOW)).toBe(false);
    expect(await checkRecoveryChallenge(SECRET, v.username, v.challenge, v.challengeExpiresAt)).toBe(false);
  });

  it("trusts exactly the Android signing certificates published in assetlinks.json", () => {
    const links = JSON.parse(readFileSync(new URL("../../../apps/web/public/.well-known/assetlinks.json", import.meta.url), "utf8")) as Array<{ target: { sha256_cert_fingerprints: string[] } }>;
    expect([...ANDROID_CERT_SHA256]).toEqual(links[0]!.target.sha256_cert_fingerprints);
    expect(policy.origins).toEqual(v.origins);
  });
});

// ── the routes ───────────────────────────────────────────────────────────

function key(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const sha = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

async function world() {
  const irk = key();
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: v.username, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  const fetchToken = crypto.getRandomValues(new Uint8Array(32));
  const deps = { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery, recoveryProofSecret: SECRET, passkeyPolicy: policy, now: () => NOW };
  const upload = async (credentialIdHex: string, extra: Record<string, unknown> = {}) => {
    const existing = await storage.webauthnRecovery.get(v.username);
    const wrapped = new Uint8Array([1, 2, 3, 4]);
    const claim: RecoveryRecordV2 = {
      op: "put", username: v.username, irkPubHex: hex(irk.publicKey), adminRootPubHex: "none", credentialIdHex,
      wrappedUmkDigestHex: await sha(wrapped), adminRoot: { change: "none" }, acmeKey: { change: "none" },
      fetchTokenHashHex: await sha(fetchToken), prfSaltHashHex: "cd".repeat(32), kdfVersion: 1, algVersion: 1,
      policy: "passkey-and-passphrase", generation: existing ? (existing.signed?.generation ?? 0) + 1 : 1,
      nonceHex: hex(crypto.getRandomValues(new Uint8Array(16))), priorDigestHex: existing ? (existing.signed?.digestHex ?? "legacy") : "genesis", issuedAt: NOW,
    };
    return handleUploadWebauthnRecovery(deps, { claim, signature: hex(signRecoveryRecord(claim, irk)), wrappedUmk: Buffer.from(wrapped).toString("base64"), ...extra });
  };
  const fetch = (passkey?: unknown) => handleFetchWrappedUmkWithToken(deps, v.username, { fetchToken: hex(fetchToken), issuedAt: NOW, ...(passkey ? { passkey } : {}) });
  return { storage, deps, upload, fetch };
}

describe("recovery passkey: the routes", () => {
  it("keeps the passkey's key at enrolment and releases nothing without its signature over a fresh challenge", async () => {
    const w = await world();
    const up = await w.upload(ES.credentialIdHex, { passkeyAttestationObject: ES.attestationObject });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ passkeyChecked: true });
    expect((await handleFetchWebauthnRecovery(w.deps, v.username)).body).toMatchObject({ passkeyRequired: true });

    expect((await w.fetch()).body).toMatchObject({ code: "passkey-required" });
    expect((await w.fetch({ challenge: v.challenge, assertion: v.invalid[0].assertion })).body).toMatchObject({ code: "passkey-invalid" });
    const other = await issueRecoveryChallenge(SECRET, "bob", NOW);
    expect((await w.fetch({ challenge: other.challenge, assertion: ES.assertion })).body).toMatchObject({ code: "passkey-challenge" });
    const ok = await w.fetch(ES.fetchPasskeyField);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ passkeyChecked: true, recoveryProof: expect.any(Object) });
    // The same answer again, while the challenge is still fresh: one use only.
    expect((await w.fetch(ES.fetchPasskeyField)).body).toMatchObject({ code: "passkey-challenge" });

    // The same assertion after the challenge has expired.
    const late = await handleFetchWrappedUmkWithToken({ ...w.deps, now: () => v.challengeExpiresAt }, v.username, { fetchToken: "00".repeat(32), issuedAt: v.challengeExpiresAt, passkey: ES.fetchPasskeyField });
    expect(late.body).toMatchObject({ code: "passkey-challenge" });
  });

  it("refuses a registration for another credential or site, and keeps the key across a rewrite of the same credential", async () => {
    const w = await world();
    expect((await w.upload("ab".repeat(16), { passkeyAttestationObject: ES.attestationObject })).status).toBe(403);
    expect((await w.upload(ED.credentialIdHex, { passkeyAttestationObject: ED.attestationObject })).status).toBe(200);
    expect((await w.upload(ED.credentialIdHex)).status).toBe(200); // an older client rewriting: the key stays
    expect((await w.storage.webauthnRecovery.get(v.username))?.passkey?.alg).toBe(-8);
    expect((await w.fetch(ED.fetchPasskeyField)).status).toBe(200);
    expect((await w.upload("ab".repeat(16))).status).toBe(200); // a new credential with no key: back to passphrase-only
    expect((await w.storage.webauthnRecovery.get(v.username))?.passkey).toBeUndefined();
  });

  it("a record from before keeps the passphrase-only path and says so", async () => {
    const w = await world();
    await w.upload(ES.credentialIdHex);
    expect((await handleFetchWebauthnRecovery(w.deps, v.username)).body).toMatchObject({ passkeyRequired: false });
    const r = await w.fetch();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ passkeyLegacy: true });
  });

  it("issues a challenge to anyone who asks (no account oracle), and fails closed without the secret", async () => {
    const r = await handleRecoveryChallenge({ recoveryProofSecret: SECRET, now: () => NOW }, "nobody-here");
    expect(r.status).toBe(200);
    expect(await checkRecoveryChallenge(SECRET, "nobody-here", (r.body as { challenge: string }).challenge, NOW)).toBe(true);
    expect((await handleRecoveryChallenge({}, "alice")).status).toBe(503);
    const w = await world();
    await w.upload(ES.credentialIdHex, { passkeyAttestationObject: ES.attestationObject });
    const noSecret = await handleFetchWrappedUmkWithToken({ ...w.deps, recoveryProofSecret: undefined } as never, v.username, { fetchToken: "00".repeat(32), issuedAt: NOW, passkey: ES.fetchPasskeyField });
    expect(noSecret.status).toBe(503);
  });
});
