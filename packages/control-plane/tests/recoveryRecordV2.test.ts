import { describe, expect, it } from "vitest";
import { ed, signRecoveryRecord, type Keypair, type RecoveryRecordV2 } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleUploadWebauthnRecovery, handleDeleteWebauthnRecovery, handleFetchWrappedUmkWithToken } from "../src/webauthnRecovery.js";

// N03 acceptance: mutate, omit, swap and replay every field; no valid signature may authorize a
// different effective record, and concurrent writers are decided by compare-and-swap.

const USERNAME = "alice";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const sha = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const key = (): Keypair => {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};

const UMK = new Uint8Array([1, 2, 3, 4]);
const ROOT = new Uint8Array([9, 9, 9]);
const ACME = new Uint8Array([7, 7]);

async function world() {
  const irk = key();
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USERNAME, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  const deps = { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery };
  const genesis = async (over: Partial<RecoveryRecordV2> = {}): Promise<RecoveryRecordV2> => ({
    op: "put", username: USERNAME, irkPubHex: hex(irk.publicKey), adminRootPubHex: "none", credentialIdHex: "deadbeef".repeat(4),
    wrappedUmkDigestHex: await sha(UMK), adminRoot: { change: "replace", digestHex: await sha(ROOT) },
    acmeKey: { change: "replace", digestHex: await sha(ACME) }, fetchTokenHashHex: "ab".repeat(32), prfSaltHashHex: "cd".repeat(32),
    kdfVersion: 1, algVersion: 1, policy: "passkey-and-passphrase", generation: 1, nonceHex: "0a".repeat(16),
    priorDigestHex: "genesis", issuedAt: Date.now(), ...over,
  });
  const body = (claim: RecoveryRecordV2, extra: Record<string, unknown> = {}) => ({
    claim, signature: hex(signRecoveryRecord(claim, irk)), wrappedUmk: b64(UMK), wrappedAdminRoot: b64(ROOT), wrappedAcmeAccountKey: b64(ACME), ...extra,
  });
  return { irk, storage, deps, genesis, body };
}

describe("recovery record v2 on .com", () => {
  it("stores the signed claim and serves it back with the ciphertexts", async () => {
    const w = await world();
    const res = await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis()));
    expect(res.status).toBe(200);
    const fetched = await handleFetchWrappedUmkWithToken(w.deps, USERNAME, { fetchToken: "00".repeat(32), issuedAt: Date.now() });
    expect(fetched.status).toBe(403); // the passphrase gate still stands
    const row = await w.storage.webauthnRecovery.get(USERNAME);
    expect(row?.signed?.generation).toBe(1);
    expect(JSON.parse(row!.signed!.signedClaimJson).wrappedUmkDigestHex).toBe(await sha(UMK));
  });

  it("refuses every one-field change to the signed claim (the signature no longer matches)", async () => {
    const w = await world();
    const claim = await w.genesis();
    const sig = hex(signRecoveryRecord(claim, w.irk));
    const changes: Partial<RecoveryRecordV2>[] = [
      { credentialIdHex: "feedface".repeat(4) }, { fetchTokenHashHex: "11".repeat(32) }, { prfSaltHashHex: "22".repeat(32) },
      { nonceHex: "0b".repeat(16) }, { wrappedUmkDigestHex: "33".repeat(32) },
      { adminRoot: { change: "replace", digestHex: "44".repeat(32) } }, { acmeKey: { change: "none" } },
    ];
    for (const c of changes) {
      const res = await handleUploadWebauthnRecovery(w.deps, { ...w.body(claim), claim: { ...claim, ...c }, signature: sig });
      expect(res.status, JSON.stringify(c)).toBe(403);
    }
    expect(await w.storage.webauthnRecovery.get(USERNAME)).toBeUndefined();
  });

  it("refuses a swapped or missing ciphertext under a valid signature", async () => {
    const w = await world();
    const claim = await w.genesis();
    for (const extra of [
      { wrappedUmk: b64(new Uint8Array([9])) }, { wrappedAdminRoot: b64(new Uint8Array([1])) },
      { wrappedAcmeAccountKey: b64(new Uint8Array([1])) }, { wrappedAdminRoot: undefined }, { wrappedAcmeAccountKey: undefined },
    ]) {
      const res = await handleUploadWebauthnRecovery(w.deps, w.body(claim, extra));
      expect([400, 403], JSON.stringify(Object.keys(extra))).toContain(res.status);
    }
    expect(await w.storage.webauthnRecovery.get(USERNAME)).toBeUndefined();
  });

  it("refuses unknown fields, a missing field and a wrong operation", async () => {
    const w = await world();
    const claim = await w.genesis();
    const withExtra = { ...w.body(claim), claim: { ...claim, surprise: 1 } };
    expect((await handleUploadWebauthnRecovery(w.deps, withExtra)).status).toBe(400);
    const { policy: _p, ...missing } = claim;
    expect((await handleUploadWebauthnRecovery(w.deps, { ...w.body(claim), claim: missing })).status).toBe(400);
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis({ op: "delete" })))).status).toBe(400);
  });

  it("refuses a record that names another signing key or admin root than the account holds", async () => {
    const w = await world();
    const other = key();
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis({ irkPubHex: hex(other.publicKey) })))).status).toBe(403);
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis({ adminRootPubHex: "ee".repeat(32) })))).status).toBe(403);
  });

  it("replay: the same envelope twice, and an old generation, are refused", async () => {
    const w = await world();
    const first = w.body(await w.genesis());
    expect((await handleUploadWebauthnRecovery(w.deps, first)).status).toBe(200);
    expect((await handleUploadWebauthnRecovery(w.deps, first)).status).toBe(409);
    const row = await w.storage.webauthnRecovery.get(USERNAME);
    const second = w.body(await w.genesis({
      generation: 2, priorDigestHex: row!.signed!.digestHex, adminRoot: { change: "keep", digestHex: await sha(ROOT) },
      acmeKey: { change: "keep", digestHex: await sha(ACME) }, nonceHex: "0c".repeat(16),
    }), { wrappedAdminRoot: undefined, wrappedAcmeAccountKey: undefined });
    expect((await handleUploadWebauthnRecovery(w.deps, second)).status).toBe(200);
    // The first envelope, even re-signed fresh, no longer names the stored digest.
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis({ nonceHex: "0d".repeat(16) })))).status).toBe(409);
  });

  it("omission cannot inherit: keep must name the held digest, none cannot hide one", async () => {
    const w = await world();
    await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis()));
    const prior = (await w.storage.webauthnRecovery.get(USERNAME))!.signed!.digestHex;
    const next = (over: Partial<RecoveryRecordV2>) => w.genesis({ generation: 2, priorDigestHex: prior, nonceHex: "0e".repeat(16), ...over });
    const noCipher = { wrappedAdminRoot: undefined, wrappedAcmeAccountKey: undefined };
    const wrongKeep = await next({ adminRoot: { change: "keep", digestHex: "55".repeat(32) }, acmeKey: { change: "keep", digestHex: await sha(ACME) } });
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(wrongKeep, noCipher))).status).toBe(409);
    const hide = await next({ adminRoot: { change: "none" }, acmeKey: { change: "keep", digestHex: await sha(ACME) } });
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(hide, noCipher))).status).toBe(409);
    // An explicit remove is a signed act and works.
    const remove = await next({ adminRoot: { change: "remove" }, acmeKey: { change: "keep", digestHex: await sha(ACME) } });
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(remove, noCipher))).status).toBe(200);
    const row = await w.storage.webauthnRecovery.get(USERNAME);
    expect(row?.wrappedAdminRootB64).toBeUndefined();
    expect(row?.wrappedAcmeAccountKeyB64).toBe(b64(ACME));
  });

  it("two concurrent writers from the same record: exactly one wins", async () => {
    const w = await world();
    await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis()));
    const prior = (await w.storage.webauthnRecovery.get(USERNAME))!.signed!.digestHex;
    const mk = async (nonce: string) => w.body(await w.genesis({
      generation: 2, priorDigestHex: prior, nonceHex: nonce, adminRoot: { change: "keep", digestHex: await sha(ROOT) },
      acmeKey: { change: "keep", digestHex: await sha(ACME) },
    }), { wrappedAdminRoot: undefined, wrappedAcmeAccountKey: undefined });
    const [a, b] = await Promise.all([
      handleUploadWebauthnRecovery(w.deps, await mk("a1".repeat(16))),
      handleUploadWebauthnRecovery(w.deps, await mk("b2".repeat(16))),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("a v1 row is replaced by a v2 record naming `legacy`, and labelled until then", async () => {
    const w = await world();
    await w.storage.webauthnRecovery.upsert({
      username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkB64: b64(UMK), wrappedAdminRootB64: b64(ROOT),
      irkPubHex: hex(w.irk.publicKey), createdAt: 1, updatedAt: 1,
    });
    // Genesis cannot silently overwrite a legacy row.
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis()))).status).toBe(409);
    const upgrade = await w.genesis({ priorDigestHex: "legacy", adminRoot: { change: "keep", digestHex: await sha(ROOT) }, acmeKey: { change: "none" } });
    expect((await handleUploadWebauthnRecovery(w.deps, w.body(upgrade, { wrappedAdminRoot: undefined, wrappedAcmeAccountKey: undefined }))).status).toBe(200);
    const row = await w.storage.webauthnRecovery.get(USERNAME);
    expect(row?.signed?.generation).toBe(1);
    expect(row?.wrappedAdminRootB64).toBe(b64(ROOT));
  });

  it("a delete names the digest it deletes and cannot remove a later record", async () => {
    const w = await world();
    await handleUploadWebauthnRecovery(w.deps, w.body(await w.genesis()));
    const row = await w.storage.webauthnRecovery.get(USERNAME);
    const del = await w.genesis({ op: "delete", generation: 2, priorDigestHex: "66".repeat(32), adminRoot: { change: "none" }, acmeKey: { change: "none" } });
    expect((await handleDeleteWebauthnRecovery(w.deps, USERNAME, w.body(del))).status).toBe(409);
    const ok = await w.genesis({ op: "delete", generation: 2, priorDigestHex: row!.signed!.digestHex, adminRoot: { change: "none" }, acmeKey: { change: "none" } });
    expect((await handleDeleteWebauthnRecovery(w.deps, USERNAME, w.body(ok))).status).toBe(200);
    expect(await w.storage.webauthnRecovery.get(USERNAME)).toBeUndefined();
  });
});
